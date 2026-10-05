import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
// CI can provide a compiler path; static binding checks still run without it.
const compiler = process.env.WXML_COMPILER ?? '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec/wcc';
const bubble = 'miniprogram/components/message-bubble/index.wxml';
const chat = 'miniprogram/pages/chat/index.wxml';
const conversations = 'miniprogram/pages/conversations/index.wxml';
const login = 'miniprogram/pages/login/index.wxml';
type Node = { tag?: string; attr?: Record<string, unknown>; children?: Array<Node | string> };
let compiled = '';
function render(template: string, data: Record<string, unknown>): Node {
  const errors: unknown[] = [];
  const context = vm.createContext({ window: {}, console: { log: (...args: unknown[]) => errors.push(args), warn: (...args: unknown[]) => errors.push(args) } });
  vm.runInContext(compiled, context);
  const result = context.$gwx(template)(data);
  expect(errors).toEqual([]);
  expect(result?.tag).toBe('wx-page');
  return result;
}
function nodes(node: Node): Node[] { return [node, ...(node.children ?? []).flatMap(child => typeof child === 'string' ? [] : nodes(child))]; }
function text(node: Node): string { return (node.children ?? []).map(child => typeof child === 'string' ? child : text(child)).join(''); }
function withClass(node: Node, name: string) { return nodes(node).filter(n => String(n.attr?.class ?? '').split(' ').includes(name)); }
const image = { messageType: 'image', mediaAssetId: 'asset-1', imageUrl: 'https://media.example.com/image.png', imageFailed: false, mine: true, status: 'sent', statusText: '已发送' };

describe.skipIf(!existsSync(compiler))('actual WeChat WXML rendering', () => {
  beforeAll(() => { compiled = execFileSync(compiler, [bubble, chat, conversations, login], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }); });

  it('renders an image with its URL and image handlers instead of an empty text bubble', () => {
    const tree = render(bubble, { message: image });
    const images = nodes(tree).filter(n => n.tag === 'wx-image');
    expect(images).toHaveLength(1);
    expect(images[0]?.attr).toMatchObject({ src: image.imageUrl, mode: 'widthFix', bindtap: 'onPreview', binderror: 'onImageError' });
    expect(text(withClass(tree, 'bubble')[0]!)).toBe('');
    expect(nodes(withClass(tree, 'bubble')[0]!).some(n => n.tag === 'wx-text')).toBe(false);
  });
  it('shows the loading placeholder until an image URL is available', () => {
    const tree = render(bubble, { message: { ...image, imageUrl: '' } });
    expect(text(tree)).toContain('图片加载中');
    expect(nodes(tree).some(n => n.tag === 'wx-image')).toBe(false);
  });
  it('shows image failure and its reload handler even when a stale URL exists', () => {
    const tree = render(bubble, { message: { ...image, imageFailed: true } });
    expect(text(tree)).toContain('图片加载失败');
    expect(nodes(tree).some(n => n.attr?.bindtap === 'onReload')).toBe(true);
    expect(nodes(tree).some(n => n.tag === 'wx-image')).toBe(false);
  });
  it('keeps text messages on the text branch', () => {
    const tree = render(bubble, { message: { messageType: 'text', text: '你好', mine: false } });
    expect(text(withClass(tree, 'bubble')[0]!)).toBe('你好');
    expect(nodes(tree).some(n => n.tag === 'wx-image')).toBe(false);
  });
  it('uses the file placeholder for file messages', () => {
    expect(text(render(bubble, { message: { messageType: 'file', mine: false } }))).toBe('[文件消息]');
  });
  it('hides sender status and retry controls on received messages', () => {
    const tree = render(bubble, { message: { ...image, mine: false } });
    expect(withClass(tree, 'status')).toHaveLength(0);
    expect(withClass(tree, 'retry')).toHaveLength(0);
  });
  it.each(['sent', 'sending', 'failed'])('does not offer an unconfirmed-message retry for %s', status => {
    const tree = render(bubble, { message: { ...image, status } });
    expect(withClass(tree, 'status')).toHaveLength(1);
    expect(withClass(tree, 'retry')).toHaveLength(0);
  });
  it('offers retry for an unconfirmed outgoing message', () => {
    expect(withClass(render(bubble, { message: { ...image, status: 'unconfirmed' } }), 'retry')).toHaveLength(1);
  });
  it('hides empty, error and upload states when chat messages are present', () => {
    const tree = render(chat, { rows: [{ ...image, key: 'message-1' }], error: '', uploadStage: '', hasUploadTask: false, busy: false });
    for (const cls of ['empty', 'chat-error', 'upload-state']) expect(withClass(tree, cls)).toHaveLength(0);
    expect(withClass(tree, 'read-action')).toHaveLength(1);
  });
  it('shows the empty-chat state without a read action', () => {
    const tree = render(chat, { rows: [], error: '', uploadStage: '', hasUploadTask: false });
    expect(withClass(tree, 'empty')).toHaveLength(1);
    expect(withClass(tree, 'read-action')).toHaveLength(0);
  });
  it.each([true, false])('shows upload retry controls only for an idle retained task (busy: %s)', busy => {
    const tree = render(chat, { rows: [], error: '', uploadStage: '上传图片…', hasUploadTask: true, busy });
    expect(withClass(tree, 'upload-state')).toHaveLength(1);
    expect(nodes(tree).filter(n => n.attr?.bindtap === 'onDiscardImage')).toHaveLength(busy ? 0 : 1);
  });
  it('renders a populated conversation list without loading, empty or load-more placeholders', () => {
    const tree = render(conversations, { rows: [{ conversationId: 'c1', peerUserId: 'bob', unread: 0 }], error: '', loading: false, hasMore: false });
    expect(withClass(tree, 'empty')).toHaveLength(0);
    expect(withClass(tree, 'badge')).toHaveLength(0);
    expect(nodes(tree).some(n => n.attr?.bindtap === 'onLoadMore')).toBe(false);
  });
  it('shows the empty conversation prompt after loading finishes', () => {
    const tree = render(conversations, { rows: [], error: '', loading: false, hasMore: false });
    expect(text(tree)).toContain('还没有会话');
    expect(text(tree)).not.toContain('正在加载会话');
  });
  it('hides configuration and error notices on a configured login page', () => {
    const tree = render(login, { configured: true, error: '', loading: false });
    expect(withClass(tree, 'notice')).toHaveLength(0);
    expect(withClass(tree, 'error')).toHaveLength(0);
  });
});
