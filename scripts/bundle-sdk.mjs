import {build} from 'esbuild';
import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {verifySDK} from './verify-sdk.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function bundleSDK() {
  const source=await verifySDK(root);
  const entry=path.join(root,source.entry),out=path.join(root,'miniprogram/vendor');
  await mkdir(out,{recursive:true});
  await build({stdin:{contents:`export * from ${JSON.stringify(entry)}; export {sha256} from 'js-sha256';`,resolveDir:root,loader:'ts'},alias:{'@nexaim/protocol':path.join(root,source.protocolEntry)},bundle:true,platform:'browser',define:{'process.versions.node':'undefined'},format:'cjs',target:'es2020',outfile:path.join(out,'nexaim-client.js'),legalComments:'none'});
  const relative=path.relative(out,entry).replaceAll(path.sep,'/').replace(/\.ts$/,'');
  await writeFile(path.join(out,'nexaim-client.d.ts'),`// Generated from the pinned SDK snapshot by bundle-sdk.mjs\nexport * from ${JSON.stringify(relative)};\nexport {sha256} from 'js-sha256';\n`);
  console.log(`SDK bundle ready (${source.commit.slice(0,7)}, local snapshot verified)`);
}
if(process.argv[1]===fileURLToPath(import.meta.url)) await bundleSDK();
