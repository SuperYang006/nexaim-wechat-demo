import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { chooseImage, uploadImage } from '../miniprogram/services/im/media';
import { SessionGate } from '../miniprogram/services/im/lifecycle';
import type { IMSession } from '../miniprogram/services/im/types';

// Real PNG bytes include zero and non-ASCII bytes; text hashing is not equivalent.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=', 'base64');
const expectedHash = createHash('sha256').update(png).digest('hex');
function fileBytes(foreign = false): ArrayBuffer {
  return foreign
    ? runInNewContext('Uint8Array.from(values).buffer', { values: Array.from(png) })
    : Uint8Array.from(png).buffer;
}
function mockPicker(data: ArrayBuffer | string, request = vi.fn()) {
  vi.stubGlobal('wx', {
    chooseMedia: (options: any) => options.success({ tempFiles: [{ tempFilePath: '/tmp/image.png', size: png.length }] }),
    getImageInfo: (options: any) => options.success({ type: 'png', width: 1, height: 1 }),
    getFileSystemManager: () => ({ readFile: (options: any) => options.success({ data }) }),
    request
  });
}
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])('prepares the exact PNG digest from file bytes (foreign realm: %s)', async foreign => {
  const bytes = fileBytes(foreign);
  if (foreign) expect(bytes.constructor).not.toBe(ArrayBuffer);
  mockPicker(bytes);
  const task = await chooseImage();
  expect(task.image.bytes).toBe(bytes);
  expect(task).toMatchObject({ image: { sha256: expectedHash, mimeType: 'image/png', fileName: 'image.png', width: 1, height: 1 }, putDone: false });
});

it('uploads the original foreign-realm file bytes and completes with their digest', async () => {
  const bytes = fileBytes(true);
  const request = vi.fn((options: any) => {
    expect(options.method).toBe('PUT');
    expect(options.data).toBe(bytes);
    expect(createHash('sha256').update(new Uint8Array(options.data)).digest('hex')).toBe(expectedHash);
    options.success({ statusCode: 200 });
    return { abort() {} };
  });
  mockPicker(bytes, request);
  const requestMediaUpload = vi.fn().mockResolvedValue({
    mediaAsset: { id: 'asset-1' },
    upload: { method: 'PUT', url: 'https://media.example.com/image?X-Amz-SignedHeaders=content-type%3Bhost', headers: { 'Content-Type': 'image/png' }, expiresAt: '2099-01-01T00:00:00.000Z' }
  });
  const completeMediaUpload = vi.fn().mockResolvedValue(undefined);
  const session = { gate: new SessionGate(), client: { requestMediaUpload, completeMediaUpload } } as unknown as IMSession;
  const task = await chooseImage();
  await expect(uploadImage(session, task)).resolves.toBe('asset-1');
  expect(requestMediaUpload).toHaveBeenCalledWith(expect.objectContaining({ sizeBytes: png.length, sha256: expectedHash }));
  expect(request).toHaveBeenCalledOnce();
  expect(completeMediaUpload).toHaveBeenCalledWith('asset-1', { sha256: expectedHash });
  expect(task.putDone).toBe(true);
});

it('rejects a text file response instead of hashing encoded text', async () => {
  mockPicker(png.toString('base64'));
  await expect(chooseImage()).rejects.toThrow('IMAGE_BINARY_REQUIRED');
});
