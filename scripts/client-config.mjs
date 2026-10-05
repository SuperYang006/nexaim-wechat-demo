export function validateClientConfig(appId,businessBaseUrl) {
  if(typeof appId!=='string'||!/^wx[a-f0-9]{16}$/.test(appId)) throw new Error('WECHAT_APP_ID_INVALID');
  if(typeof businessBaseUrl!=='string') throw new Error('BUSINESS_BASE_URL_INVALID');
  if(!businessBaseUrl) return;
  let url;
  try { url=new URL(businessBaseUrl); } catch { throw new Error('BUSINESS_BASE_URL_INVALID'); }
  const local=url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!local)||url.username||url.password||url.search||url.hash) throw new Error('BUSINESS_BASE_URL_INVALID');
}
export function clientConfigSource(appId,businessBaseUrl) {
  validateClientConfig(appId,businessBaseUrl);
  return '// Public settings only. Configure with pnpm configure; server secrets belong in .env.\nexport const config = '+JSON.stringify({wechatAppId:appId,businessBaseUrl:businessBaseUrl.replace(/\/+$/,'')},null,2)+';\n';
}
