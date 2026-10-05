import vm from 'node:vm';
import {validateClientConfig} from './client-config.mjs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=path.join(root,'dist/miniprogram');
const pages=[],components=[],apps=[],cache=new Map();
const native={getStorageSync:()=>'',setStorageSync(){},request(){throw new Error('Unexpected network request');},connectSocket(){throw new Error('Unexpected socket');}};
// Deliberately omit process, Buffer, window, URL, fetch, Response and WebSocket.
const context=vm.createContext({wx:native,Page:value=>pages.push(value),Component:value=>components.push(value),App:value=>apps.push(value),console,setTimeout,clearTimeout});
function load(file) {
 const resolved=path.resolve(file);assert.ok(resolved.startsWith(base+path.sep));
 if(cache.has(resolved))return cache.get(resolved).exports;
 const module={exports:{}};cache.set(resolved,module);
 const source=readFileSync(resolved,'utf8');
 const execute=vm.runInContext(`(function(require,module,exports){${source}\n})`,context,{filename:resolved});
 execute(name=>{assert.ok(name.startsWith('.'),`External runtime dependency: ${name}`);let target=path.resolve(path.dirname(resolved),name);if(!target.endsWith('.js'))target+='.js';return load(target);},module,module.exports);
 return module.exports;
}
function checkConditionBindings(markup,file) {
 for(const match of markup.matchAll(/\bwx:(?:if|elif)\s*=\s*(["'])(.*?)\1/g)) {
  assert.match(match[2],/^\s*\{\{[\s\S]*\}\}\s*$/,`${file}: conditional must use {{ }} data binding: ${match[0]}`);
 }
}
const config=JSON.parse(readFileSync(path.join(root,'project.config.json'),'utf8'));
const clientConfig=load(path.join(base,'config/env.js')).config;
validateClientConfig(config.appid,clientConfig.businessBaseUrl);
assert.equal(clientConfig.wechatAppId,config.appid,'CLIENT_APP_ID_MISMATCH: run pnpm configure and rebuild');
assert.equal(config.miniprogramRoot,'dist/miniprogram/');
const app=JSON.parse(readFileSync(path.join(base,'app.json'),'utf8'));
load(path.join(base,'app.js'));
for(const page of app.pages){
 load(path.join(base,`${page}.js`));
 const definition=pages.at(-1),markup=readFileSync(path.join(base,`${page}.wxml`),'utf8');
 checkConditionBindings(markup,`${page}.wxml`);
 for(const match of markup.matchAll(/(?:bind|catch):?[a-z]+="([A-Za-z][\w]*)"/g))assert.equal(typeof definition[match[1]],'function',`${page}: missing ${match[1]}`);
 const pageConfig=JSON.parse(readFileSync(path.join(base,`${page}.json`),'utf8'));
 for(const relative of Object.values(pageConfig.usingComponents??{})){
   const p=path.join(base,relative.slice(1));assert.ok(existsSync(p+'.json'));load(p+'.js');
   const definition=cache.get(p+'.js');assert.ok(definition);
   checkConditionBindings(readFileSync(p+'.wxml','utf8'),relative+'.wxml');
 }
}
const sdk=load(path.join(base,'vendor/nexaim-client.js'));
assert.equal(sdk.sha256('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
// Native file callbacks can return buffers from another JavaScript realm.
const imageBytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=','base64')).buffer;
assert.notEqual(imageBytes.constructor,vm.runInContext('ArrayBuffer',context));
Object.assign(native,{
 chooseMedia(options){options.success({tempFiles:[{tempFilePath:'/tmp/image.png',size:imageBytes.byteLength}]});},
 getImageInfo(options){options.success({type:'png',width:1,height:1});},
 getFileSystemManager(){return {readFile(options){options.success({data:imageBytes});}};}
});
const media=load(path.join(base,'services/im/media.js'));
const prepared=await media.chooseImage();
const expectedHash=createHash('sha256').update(new Uint8Array(imageBytes)).digest('hex');
assert.equal(prepared.image.sha256,expectedHash);
assert.equal(prepared.image.bytes,imageBytes);
await media.putImageBytes({method:'PUT',url:'https://media.example.com/image?X-Amz-SignedHeaders=content-type%3Bhost',headers:{'Content-Type':'image/png'},expiresAt:'2099-01-01T00:00:00.000Z'},prepared.image.bytes,options=>{
 assert.equal(options.method,'PUT');assert.equal(options.data,imageBytes);
 options.success({statusCode:200});return {abort(){}};
});
const id='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const asset={id,kind:'image',status:'pending',fileName:'image.png',mimeType:'image/png',sizeBytes:4,sha256:'a'.repeat(64),createdAt:'2026-10-05T00:00:00.000Z',updatedAt:'2026-10-05T00:00:00.000Z'};
const wx={...native,request(o){o.success({statusCode:200,data:{requestId:'request-1',data:{mediaAsset:asset,upload:{url:'https://storage.nexaims.com/test',method:'PUT',headers:{'Content-Type':'image/png'},expiresAt:'2099-01-01T00:00:00.000Z'}}},header:{}});return {abort(){}};}};
const client=new sdk.NexaIMClient({appId:id,userId:'alice',deviceId:'device-1',wsBaseUrl:'wss://ws.nexaims.com/ws',apiBaseUrl:'https://api.nexaims.com',tokenProvider:()=> 'synthetic-token',WebSocketCtor:sdk.createWeChatWebSocketCtor(wx),fetchImpl:sdk.createWeChatFetch(wx)});
await client.requestMediaUpload({kind:'image',fileName:'image.png',mimeType:'image/png',sizeBytes:4,sha256:'a'.repeat(64)});
console.log(JSON.stringify({pages:pages.length,components:components.length,apps:apps.length,isolatedRuntime:'passed',wxmlBindings:'passed',sha256:'passed',binaryImagePreparation:'passed',originalImageUpload:'passed',mediaResponse:'passed',liveNetworkRequests:0}));
