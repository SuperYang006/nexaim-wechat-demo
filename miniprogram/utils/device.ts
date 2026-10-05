// 非安全令牌：只用于客户端消息幂等标识与设备标识；登录凭据由服务端产生。
export function newId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const n = Math.floor(Math.random() * 16);
        return (c === 'x' ? n : (n & 3) | 8).toString(16);
    });
}
export function getDeviceId() {
    const key = 'nexaim-demo:device-id';
    let id = wx.getStorageSync(key) as string;
    if (!id) {
        id = newId();
        wx.setStorageSync(key, id);
    }
    return id;
}
