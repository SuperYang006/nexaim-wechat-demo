import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export async function verifySDK(root) {
  const source=JSON.parse(await readFile(path.join(root,'sdk-source.json'),'utf8'));
  if(source.formatVersion!==1 || !/^[a-f0-9]{40}$/.test(source.commit)) throw new Error('SDK_SOURCE_INVALID');
  const manifest=JSON.parse(await readFile(path.join(root,'sdk/manifest.json'),'utf8'));
  if(manifest.commit!==source.commit || !manifest.files?.[source.entry] || !manifest.files?.[source.protocolEntry]) throw new Error('SDK_SOURCE_INVALID');
  for(const [file,hash] of Object.entries(manifest.files)) {
    if(!/^sdk\/(reference-client|protocol)\/src\/[\w/-]+\.ts$/.test(file) || file.includes('..')) throw new Error('SDK_SOURCE_INVALID');
    const content=await readFile(path.join(root,file));
    if(createHash('sha256').update(content).digest('hex')!==hash) throw new Error(`SDK_SNAPSHOT_MISMATCH: ${file}`);
  }
  return source;
}
