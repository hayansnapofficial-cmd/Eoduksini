import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root=fileURLToPath(new URL('..',import.meta.url));
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'eoduksini-build-'));
  const adapters=readdirSync(join(root,'adapters'),{withFileTypes:true}).filter(entry=>entry.isDirectory())
    .map(entry=>'adapters/'+entry.name+'/project.json');
  for(const path of ['core','packages/engine-primitives','packages/runtime-adapters','studio','agent','scripts/build.mjs',
    'scripts/adapter-projects.mjs','package.json','package-lock.json',...adapters]) {
    const target=join(dir,path); mkdirSync(join(target,'..'),{recursive:true}); cpSync(join(root,path),target,{recursive:true});
  }
  symlinkSync(join(root,'node_modules'),join(dir,'node_modules'),process.platform==='win32'?'junction':'dir');
  return dir;
}
const run=(dir,script,args=[])=>spawnSync(process.execPath,[script,...args],{cwd:dir,encoding:'utf8'});
const bundle=dir=>join(dir,'dist/eoduksini-0.1.0');

test('build replaces stale output recoverably and hashes actual artifact files',()=>{
  const dir=fixture(),example=JSON.parse(readFileSync(join(dir,'adapters/demo/project.json'),'utf8'));
  example.project_id='third'; example.task_prefix='THIRD-';
  mkdirSync(join(dir,'adapters/third')); writeFileSync(join(dir,'adapters/third/project.json'),JSON.stringify(example));
  mkdirSync(bundle(dir),{recursive:true}); writeFileSync(join(bundle(dir),'obsolete.txt'),'keep in backup');
  const result=run(dir,'scripts/build.mjs'); assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(existsSync(join(bundle(dir),'obsolete.txt')),false);
  assert.equal(readFileSync(join(report.previous_directory,'obsolete.txt'),'utf8'),'keep in backup');
  assert.match(report.artifact_digest,/^[0-9a-f]{64}$/);
  assert.equal(existsSync(join(bundle(dir),'adapters/third/project.json')),true);
  assert.equal(existsSync(join(bundle(dir),'packages/runtime-adapters/providers/ollama-worker.mjs')),true);
  assert.equal(existsSync(join(bundle(dir),'studio/public/index.html')),true);
  assert.equal(existsSync(join(bundle(dir),'agent/node-agent.mjs')),true);
  const manifest=JSON.parse(readFileSync(join(bundle(dir),'artifact-manifest.json'),'utf8'));
  for(const file of manifest.files) assert.equal(createHash('sha256').update(readFileSync(join(bundle(dir),file.path))).digest('hex'),file.sha256);
  assert.equal(manifest.artifact_digest,report.artifact_digest);
  const again=run(dir,'scripts/build.mjs'); assert.equal(again.status,0,again.stderr);
  assert.equal(JSON.parse(again.stdout).artifact_digest,report.artifact_digest);
  const cli=join(dir,'core/cli.mjs'); writeFileSync(cli,readFileSync(cli,'utf8')+'\n// fixture code revision\n');
  const changed=run(dir,'scripts/build.mjs'); assert.equal(changed.status,0,changed.stderr);
  assert.equal(JSON.parse(changed.stdout).package_digest,report.package_digest);
  assert.notEqual(JSON.parse(changed.stdout).artifact_digest,report.artifact_digest);
});
