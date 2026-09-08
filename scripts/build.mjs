import { mkdirSync, mkdtempSync, cpSync, readFileSync, writeFileSync, lstatSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { digest, projectContract } from '../core/contracts.mjs';
import { adapterProjectPaths } from './adapter-projects.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('INVALID_BUILD_VERSION');
const dist=join(root,'dist'),directory=join(dist,'eoduksini-'+pkg.version);
function directoryOrAbsent(path) {
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if(stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('UNSAFE_BUILD_DIRECTORY: '+path);
  return !!stat;
}
directoryOrAbsent(dist); mkdirSync(dist,{recursive:true});
const hadPrevious=directoryOrAbsent(directory);
const staging=mkdtempSync(join(dist,'.eoduksini-build-'));
const copy=path=>{ mkdirSync(dirname(join(staging,path)),{recursive:true}); cpSync(join(root,path),join(staging,path),{recursive:true}); };
const adapters=adapterProjectPaths(root);
for(const adapter of adapters) {
  const project=projectContract(JSON.parse(readFileSync(adapter.path,'utf8')));
  if(project.project_id!==adapter.name) throw new Error('ADAPTER_DIRECTORY_MISMATCH: '+adapter.name);
}
for(const path of ['core','packages/engine-primitives','packages/runtime-adapters',
  'studio','agent',...adapters.map(adapter=>adapter.relative_path),'package-lock.json']) copy(path);
const runtime={name:pkg.name,version:pkg.version,private:true,type:'module',bin:pkg.bin,engines:pkg.engines,
  scripts:{studio:'node studio/server.mjs',agent:'node agent/node-agent.mjs'},dependencies:pkg.dependencies};
writeFileSync(join(staging,'package.json'),JSON.stringify(runtime,null,2)+'\n');
function inventory(path) {
  return readdirSync(path,{withFileTypes:true}).flatMap(entry=>{
    const full=join(path,entry.name);
    if(entry.isDirectory()) return inventory(full);
    if(!entry.isFile()) throw new Error('UNSAFE_BUILD_ENTRY: '+full);
    return [{path:relative(staging,full).replaceAll('\\','/'),sha256:createHash('sha256').update(readFileSync(full)).digest('hex')}];
  });
}
const files=inventory(staging).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),artifactDigest=digest({files});
writeFileSync(join(staging,'artifact-manifest.json'),JSON.stringify({artifact_digest:artifactDigest,files,
  note:'Digest covers the listed packaged bytes, not this manifest, later installed dependencies, or a publisher signature.'},null,2)+'\n');
// Replace only validated children of this checkout's dist. Keep prior output
// recoverably, including any developer-installed dependencies or extra files.
const child=path=>{ const rel=relative(dist,resolve(path)); if(!rel || rel.startsWith('..') || resolve(dist,rel)!==resolve(path)) throw new Error('UNSAFE_BUILD_TARGET'); };
child(directory); child(staging);
let previous=null;
if(hadPrevious) {
  previous=join(mkdtempSync(join(dist,'.eoduksini-previous-')),basename(directory));
  child(previous); directoryOrAbsent(directory); renameSync(directory,previous);
}
try { renameSync(staging,directory); }
catch(error) { if(previous) renameSync(previous,directory); throw error; }
console.log(JSON.stringify({status:'BUILT',directory,previous_directory:previous,package_digest:digest(runtime),artifact_digest:artifactDigest,
  note:'Run npm ci --omit=dev --ignore-scripts in the bundle. Previous output, if any, is preserved at previous_directory.'},null,2));
