import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterProjectPaths } from '../scripts/adapter-projects.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'eoduksini-adapters-')); mkdirSync(join(root,'adapters'));
  t.after(()=>rmSync(root,{recursive:true,force:true})); return root;
}
function adapter(root,name) {
  const directory=join(root,'adapters',name); mkdirSync(directory); writeFileSync(join(directory,'project.json'),'{}');
}

test('adapter project discovery is sorted and needs no product registry',t=>{
  const root=fixture(t); adapter(root,'zeta'); adapter(root,'alpha');
  assert.deepEqual(adapterProjectPaths(root).map(value=>value.name),['alpha','zeta']);
});

test('adapter project discovery fails closed on missing contracts and root files',t=>{
  const missing=fixture(t); mkdirSync(join(missing,'adapters','valid-name'));
  assert.throws(()=>adapterProjectPaths(missing),/ENOENT|INVALID_ADAPTER_PROJECT/);
  const file=fixture(t); writeFileSync(join(file,'adapters','registry.json'),'{}');
  assert.throws(()=>adapterProjectPaths(file),/INVALID_ADAPTER_ENTRY/);
});
