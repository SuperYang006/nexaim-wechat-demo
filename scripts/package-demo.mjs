import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {readFile,writeFile,copyFile,mkdir,mkdtemp,lstat,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {clientConfigSource} from './client-config.mjs';
import {verifySDK} from './verify-sdk.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {values}=parseArgs({options:{output:{type:'string'}}});
await verifySDK(root);
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const output=path.resolve(values.output??path.join(root,'dist/releases',`nexaim-wechat-demo-${pkg.version}-${new Date().toISOString().replace(/[:.]/g,'-')}.tar.gz`));
const staging=await mkdtemp(path.join(tmpdir(),'nexaim-demo-package-'));
const dest=path.join(staging,'nexaim-wechat-demo');
let count=0;
async function copy(rel) {
  const source=path.join(root,rel),target=path.join(dest,rel);
  if(!(await lstat(source)).isFile()) throw new Error(`PACKAGE_SOURCE_NOT_REGULAR: ${rel}`);
  await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);count++;
}
async function tree(rel,extensions) {
  for(const entry of await readdir(path.join(root,rel),{withFileTypes:true})) {
    if(entry.name.startsWith('.')||entry.name==='vendor'||/^project\..*config\.json$/.test(entry.name)) continue;
    const child=path.join(rel,entry.name);
    if(entry.isDirectory()) await tree(child,extensions);
    else if(entry.isFile()&&extensions.includes(path.extname(entry.name))) {
      if(entry.name.endsWith('.js')) {
        try { await lstat(path.join(root,child.replace(/\.js$/,'.ts')));continue; } catch(error) { if(error.code!=='ENOENT') throw error; }
      }
      await copy(child);
    }
  }
}
try {
  for(const rel of ['AGENTS.md','README.md','package.json','pnpm-lock.yaml','tsconfig.json','vitest.config.ts','.gitignore','.dockerignore','.env.example','sdk-source.json','infra/Dockerfile','infra/docker-compose.yml','infra/docker-compose.standalone.yml','docs/getting-started.md','docs/direct-api.md','docs/customer-deployment.md','docs/acceptance.md','sdk/README.md','sdk/manifest.json']) await copy(rel);
  for(const [dir,extensions] of [['scripts',['.mjs']],['tests',['.ts']],['server/src',['.ts']],['sdk/reference-client/src',['.ts']],['sdk/protocol/src',['.ts']],['miniprogram',['.ts','.js','.json','.wxml','.wxss']]]) await tree(dir,extensions);
  const envExample=await readFile(path.join(dest,'.env.example'),'utf8');
  if(/^(?:WECHAT_APP_SECRET|NEXAIM_APP_KEY|NEXAIM_APP_SECRET)[ \t]*=[ \t]*\S.*$/m.test(envExample)) throw new Error('TEMPLATE_ENV_SECRET_NOT_EMPTY');
  await writeFile(path.join(dest,'project.config.json'),JSON.stringify({appid:'wx0000000000000000',projectname:'NexaIM-WeChat-Demo',compileType:'miniprogram',miniprogramRoot:'dist/miniprogram/',setting:{urlCheck:true,es6:true,minified:false,enhance:true}},null,2)+'\n');
  await writeFile(path.join(dest,'miniprogram/config/env.ts'),clientConfigSource('wx0000000000000000',''));
  await writeFile(path.join(dest,'docs/implementation.md'),'# 客户接入记录\n\n- [ ] 填写自己的微信 AppID、业务服务地址和服务端配置。\n- [ ] 执行 pnpm check 并记录实际 passed / failed / skipped。\n- [ ] 按 acceptance.md 执行双账号与真机验收。\n');
  const archive=path.join(staging,'customer.tar.gz');
  execFileSync('tar',['-czf',archive,'-C',staging,'nexaim-wechat-demo'],{env:{...process.env,COPYFILE_DISABLE:'1'},stdio:['ignore','pipe','pipe']});
  await mkdir(path.dirname(output),{recursive:true});
  await copyFile(archive,output,constants.COPYFILE_EXCL);
  const sha256=createHash('sha256').update(await readFile(output)).digest('hex');
  await writeFile(output+'.sha256',`${sha256}  ${path.basename(output)}\n`,{flag:'wx'});
  console.log(JSON.stringify({archive:output,sha256,sourceFiles:count+3}));
} finally { await rm(staging,{recursive:true,force:true}); }
