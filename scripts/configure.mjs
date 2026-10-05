import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {clientConfigSource} from './client-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {values}=parseArgs({options:{appid:{type:'string'},'business-url':{type:'string'}}});
const content=clientConfigSource(values.appid,values['business-url']);
const file=path.join(root,'project.config.json');
const project=JSON.parse(await readFile(file,'utf8'));
await writeFile(path.join(root,'miniprogram/config/env.ts'),content);
await writeFile(file,JSON.stringify({...project,appid:values.appid},null,2)+'\n');
console.log('Public client configuration updated. Set matching WECHAT_APP_ID in server .env, then run pnpm check.');
