import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Maintainer-only import: read Git objects, never copy a working tree or .env.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {values}=parseArgs({options:{source:{type:'string'},commit:{type:'string'}}});
if(!values.source || !/^[a-f0-9]{40}$/.test(values.commit??'')) throw new Error('Usage: pnpm sdk:update --source /path/to/NexaIM --commit <40-character-commit>');
const repo=path.resolve(values.source),commit=values.commit;
const git=args=>execFileSync('git',args,{cwd:repo,maxBuffer:4*1024*1024});
const paths=git(['ls-tree','-r','--name-only',commit,'--','packages/reference-client/src','packages/protocol/src']).toString().trim().split('\n').filter(p=>p.endsWith('.ts')&&!/\.(test|spec)\.ts$/.test(p)).sort();
const files={},contents=new Map();
for(const original of paths) {
  const file=original.replace(/^packages\//,'sdk/');
  if(!/^sdk\/(reference-client|protocol)\/src\/[\w/-]+\.ts$/.test(file)||file.includes('..')) throw new Error('SDK_SOURCE_PATH_INVALID');
  const content=git(['show',`${commit}:${original}`]);
  files[file]=createHash('sha256').update(content).digest('hex');contents.set(file,content);
}
const entry='sdk/reference-client/src/index.ts',protocolEntry='sdk/protocol/src/index.ts';
if(!files[entry]||!files[protocolEntry]) throw new Error('SDK_SOURCE_ENTRY_MISSING');
let previous={files:{}};
try { previous=JSON.parse(await readFile(path.join(root,'sdk/manifest.json'),'utf8')); } catch(error) { if(error.code!=='ENOENT') throw error; }
for(const [file,content] of contents) { await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),content); }
for(const file of Object.keys(previous.files)) {
  if(!files[file] && /^sdk\/(reference-client|protocol)\/src\/[\w/-]+\.ts$/.test(file) && !file.includes('..')) await rm(path.join(root,file),{force:true});
}
await writeFile(path.join(root,'sdk/manifest.json'),JSON.stringify({commit,files},null,2)+'\n');
await writeFile(path.join(root,'sdk-source.json'),JSON.stringify({formatVersion:1,commit,entry,protocolEntry},null,2)+'\n');
console.log(`SDK source snapshot updated: ${commit} (${paths.length} files)`);
