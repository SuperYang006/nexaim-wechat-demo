import {build} from 'esbuild';
import {readdir,mkdir,copyFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {bundleSDK} from './bundle-sdk.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await bundleSDK();
const source=path.join(root,'miniprogram'),out=path.join(root,'dist/miniprogram');
async function walk(dir) {const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())result.push(...await walk(p));else result.push(p);}return result;}
const files=await walk(source);
const tsFiles=files.filter(f=>f.endsWith('.ts')&&!f.endsWith('.d.ts'));
// Developer Tools may create JS templates beside TS pages; keep compiled handlers.
const compiledJs=new Set(tsFiles.map(file=>file.replace(/\.ts$/,'.js')));
await build({entryPoints:tsFiles,outbase:source,outdir:out,bundle:false,platform:'browser',format:'cjs',target:'es2020'});
for(const file of files.filter(f=>/\.(json|wxml|wxss|js)$/.test(f)&&!compiledJs.has(f))) {const to=path.join(out,path.relative(source,file));await mkdir(path.dirname(to),{recursive:true});await copyFile(file,to);}
const app=JSON.parse(await readFile(path.join(out,'app.json'),'utf8'));
for(const page of app.pages) for(const extension of ['js','json','wxml','wxss']) await readFile(path.join(out,`${page}.${extension}`));
console.log(`Mini program build ready: ${path.relative(root,out)} (${app.pages.length} pages)`);
