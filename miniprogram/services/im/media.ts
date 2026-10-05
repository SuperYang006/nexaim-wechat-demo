import { sha256, type CreateMediaUploadResponseData } from '../../vendor/nexaim-client';
import type { IMSession } from './types';
type Upload = CreateMediaUploadResponseData['upload'];
export async function putImageBytes(upload: Upload, bytes: ArrayBuffer, request: typeof wx.request = wx.request) {
    if (Date.now() >= Date.parse(upload.expiresAt))
        throw new Error('IMAGE_UPLOAD_URL_EXPIRED');
    const length = Object.entries(upload.headers).find(([k]) => k.toLowerCase() === 'content-length')?.[1];
    if (length !== undefined && Number(length) !== bytes.byteLength)
        throw new Error('IMAGE_SIZE_INVALID');
    const raw = /[?&]X-Amz-SignedHeaders=([^&]+)/.exec(upload.url)?.[1];
    if (!raw)
        throw new Error('IMAGE_UPLOAD_SIGNATURE_MISSING');
    const signed = new Set(decodeURIComponent(raw).toLowerCase().split(';'));
    const header = Object.fromEntries(Object.entries(upload.headers).filter(([k]) => k.toLowerCase() !== 'host' && (signed.has(k.toLowerCase()) || k.toLowerCase() === 'content-type')));
    await new Promise<void>((resolve, reject) => request({ url: upload.url, method: 'PUT', header, data: bytes, dataType: 'text', responseType: 'text', timeout: 60000, success: r => r.statusCode >= 200 && r.statusCode < 300 ? resolve() : reject(new Error(`IMAGE_UPLOAD_HTTP_${r.statusCode}`)), fail: () => reject(new Error('IMAGE_UPLOAD_NETWORK_ERROR')) }));
}
export type PreparedImage = {
    bytes: ArrayBuffer;
    fileName: string;
    mimeType: string;
    sha256: string;
    width: number;
    height: number;
};
export type ImageUploadTask = {
    image: PreparedImage;
    mediaAssetId?: string;
    upload?: Upload;
    putDone: boolean;
};
export async function chooseImage(): Promise<ImageUploadTask> {
    const result = await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult>((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['original'], success: resolve, fail: reject }));
    const file = result.tempFiles[0];
    if (!file || file.size <= 0 || file.size > 10 * 1024 * 1024)
        throw new Error('IMAGE_SIZE_INVALID');
    const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) => wx.getImageInfo({ src: file.tempFilePath, success: resolve, fail: reject }));
    const formats: Record<string, [
        string,
        string
    ]> = { jpeg: ['image/jpeg', 'jpg'], jpg: ['image/jpeg', 'jpg'], png: ['image/png', 'png'], webp: ['image/webp', 'webp'], gif: ['image/gif', 'gif'] };
    const format = formats[info.type.toLowerCase()];
    if (!format)
        throw new Error('IMAGE_FORMAT_UNSUPPORTED');
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: file.tempFilePath, success: r => typeof r.data === 'string' ? reject(new Error('IMAGE_BINARY_REQUIRED')) : resolve(r.data), fail: reject }));
    if (bytes.byteLength <= 0 || bytes.byteLength > 10 * 1024 * 1024)
        throw new Error('IMAGE_SIZE_INVALID');
    // 微信文件回调的 ArrayBuffer 可能来自另一运行环境；字节视图避免哈希库的构造器比较。
    return { image: { bytes, fileName: `image.${format[1]}`, mimeType: format[0], sha256: sha256(new Uint8Array(bytes)), width: info.width, height: info.height }, putDone: false };
}
export async function uploadImage(session: IMSession, task: ImageUploadTask): Promise<string> {
    session.gate.assert();
    if (!task.mediaAssetId) {
        const image = task.image;
        const result = await session.client.requestMediaUpload({ kind: 'image', fileName: image.fileName, mimeType: image.mimeType, sizeBytes: image.bytes.byteLength, sha256: image.sha256, width: image.width, height: image.height });
        session.gate.assert();
        task.mediaAssetId = result.mediaAsset.id;
        task.upload = result.upload;
    }
    if (!task.putDone) {
        if (!task.upload)
            throw new Error('IMAGE_UPLOAD_INSTRUCTION_MISSING');
        await putImageBytes(task.upload, task.image.bytes);
        session.gate.assert();
        task.putDone = true;
    }
    await session.client.completeMediaUpload(task.mediaAssetId, { sha256: task.image.sha256 });
    session.gate.assert();
    return task.mediaAssetId;
}
