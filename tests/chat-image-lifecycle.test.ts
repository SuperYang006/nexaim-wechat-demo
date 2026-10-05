import { beforeEach, afterEach, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: null as any, choose: vi.fn(), upload: vi.fn(), send: vi.fn(), refresh: vi.fn(), recover: vi.fn() }));
vi.mock('../miniprogram/store/session', () => ({ getBusinessSession: () => ({ userId: mocks.session?.store.userId }) }));
vi.mock('../miniprogram/services/im/client', () => ({ getIMSession: () => mocks.session, recoverSession: mocks.recover, refreshConversations: mocks.refresh }));
vi.mock('../miniprogram/services/im/media', () => ({ chooseImage: mocks.choose, uploadImage: mocks.upload }));
vi.mock('../miniprogram/services/im/messages', () => ({ sendDraft: mocks.send, markRead: vi.fn() }));
vi.mock('../miniprogram/utils/device', () => ({ newId: () => 'stable-image-message-id' }));

function deferred<T = any>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function session(userId = 'alice') { return { gate: { active: true }, store: { userId, connection: 'connected', forPeer: () => [], subscribe: () => vi.fn() } }; }
const selected = () => ({ image: { bytes: new ArrayBuffer(4), fileName: 'test.png', mimeType: 'image/png', sha256: 'a'.repeat(64), width: 1, height: 1 }, putDone: false });
let page: any;
let picker: ReturnType<typeof deferred>;

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.session = session(); picker = deferred();
  mocks.choose.mockImplementation(() => picker.promise);
  mocks.upload.mockResolvedValue('asset-1'); mocks.send.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined); mocks.recover.mockResolvedValue(undefined);
  vi.stubGlobal('wx', { reLaunch: vi.fn() });
  vi.stubGlobal('Page', (definition: any) => {
    page = { ...definition, data: structuredClone(definition.data), setData: vi.fn(function(this: any, data: any) { Object.assign(this.data, data); }) };
  });
  // Select TypeScript explicitly; Developer Tools also left an index.js template.
  const pageModule = '../miniprogram/pages/chat/index.ts';
  await import(pageModule);
  page.onLoad({ peer: 'bob' }); page.onShow();
});
afterEach(() => { page?.onUnload(); vi.unstubAllGlobals(); });

it('sends a selected image after the native picker hides and shows the same page', async () => {
  const sending = page.onSendImage();
  page.onHide(); page.onShow(); picker.resolve(selected());
  await sending;
  expect(mocks.upload).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce();
  expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({ recipientUserId: 'bob', messageType: 'image', mediaAssetId: 'asset-1' });
  expect(page.data).toMatchObject({ busy: false, uploadStage: '', error: '', hasUploadTask: false });
});
it('waits for the page to return when the selection callback arrives before onShow', async () => {
  const sending = page.onSendImage(); page.onHide(); picker.resolve(selected());
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.upload).not.toHaveBeenCalled();
  page.onShow(); await sending;
  expect(mocks.upload).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce();
  expect(page.data.uploadStage).toBe('');
});
it('clears preparing state after picker cancellation across hide/show', async () => {
  const sending = page.onSendImage(); page.onHide(); page.onShow();
  picker.reject({ errMsg: 'chooseMedia:fail cancel' }); await sending;
  expect(page.data).toMatchObject({ busy: false, uploadStage: '', error: '', hasUploadTask: false });
  expect(mocks.upload).not.toHaveBeenCalled();
});
it('shows preparation failures after returning instead of swallowing them', async () => {
  const sending = page.onSendImage(); page.onHide(); page.onShow();
  picker.reject(new Error('IMAGE_FORMAT_UNSUPPORTED')); await sending;
  expect(page.data).toMatchObject({ busy: false, uploadStage: '', error: 'IMAGE_FORMAT_UNSUPPORTED' });
});
it('keeps the send action locked while an existing picker is still returning', async () => {
  const sending = page.onSendImage(); page.onHide(); page.onShow();
  expect(page.data.busy).toBe(true);
  const duplicate = page.onSendImage();
  picker.resolve(selected()); await Promise.all([sending, duplicate]);
  expect(mocks.choose).toHaveBeenCalledOnce(); expect(mocks.upload).toHaveBeenCalledOnce();
});
it('discards a late selection after the page unloads', async () => {
  const sending = page.onSendImage(); page.onHide(); page.onUnload();
  const writes = page.setData.mock.calls.length;
  picker.resolve(selected()); await sending;
  expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  expect(page.setData.mock.calls.length).toBe(writes);
});
it('discards the previous account selection without clearing the new account task', async () => {
  const oldSending = page.onSendImage(); const oldPicker = picker;
  page.onHide(); mocks.session.gate.active = false; mocks.session = session('carol'); page.onShow();
  picker = deferred(); const newSending = page.onSendImage();
  oldPicker.resolve(selected()); await oldSending;
  expect(mocks.upload).not.toHaveBeenCalled(); expect(page.data.busy).toBe(true);
  picker.resolve(selected()); await newSending;
  expect(mocks.upload).toHaveBeenCalledOnce(); expect(mocks.upload.mock.calls[0]?.[0]).toBe(mocks.session);
});
it('continues an in-flight upload after foreground recovery without creating another upload', async () => {
  const uploaded = deferred<string>(); mocks.upload.mockReturnValue(uploaded.promise);
  picker.resolve(selected()); const sending = page.onSendImage();
  await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
  page.onHide(); page.onShow();
  expect(page.data.busy).toBe(true);
  uploaded.resolve('asset-1'); await sending;
  expect(mocks.send).toHaveBeenCalledOnce(); expect(mocks.upload).toHaveBeenCalledOnce();
  expect(page.data).toMatchObject({ busy: false, uploadStage: '', hasUploadTask: false });
});
it('preserves an interrupted upload task for retry and clears the visible busy state', async () => {
  const uploaded = deferred<string>(); mocks.upload.mockReturnValueOnce(uploaded.promise);
  const task = selected(); picker.resolve(task); const sending = page.onSendImage();
  await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
  page.onHide(); page.onShow(); uploaded.reject(new Error('IMAGE_UPLOAD_NETWORK_ERROR')); await sending;
  expect(page.data).toMatchObject({ busy: false, hasUploadTask: true, error: 'IMAGE_UPLOAD_NETWORK_ERROR' });
  await page.onSendImage();
  expect(mocks.choose).toHaveBeenCalledOnce();
  expect(mocks.upload.mock.calls[1]?.[1]).toBe(task);
  expect(mocks.send).toHaveBeenCalledOnce();
});
it('releases a task waiting for foreground when the page unloads', async () => {
  const sending = page.onSendImage(); page.onHide(); picker.resolve(selected());
  await Promise.resolve(); await Promise.resolve();
  page.onUnload(); await sending;
  expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});
it('rechecks account identity at the write after foreground readiness resolves', async () => {
  const sending = page.onSendImage(); picker.resolve(selected());
  await Promise.resolve(); await Promise.resolve();
  page.onHide(); mocks.session.gate.active = false; mocks.session = session('carol'); page.onShow();
  const writes = page.setData.mock.calls.length;
  await sending;
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(page._imageTask).toBeNull();
  expect(page.setData.mock.calls.length).toBe(writes);
});
