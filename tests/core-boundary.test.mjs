import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { adapterToCoreSchemaCoupling, assertNoAdapterToCoreSchemaCoupling } from '../scripts/core-boundary.mjs';

test('active scripts cannot regenerate Core schemas from a project adapter',()=>{
  const retired="const source='../adapters/example/schemas/'; const target='../core/schemas/';";
  assert.equal(adapterToCoreSchemaCoupling(retired),true);
  assert.throws(()=>assertNoAdapterToCoreSchemaCoupling(retired,'scripts/fixture.mjs'),
    /ADAPTER_TO_CORE_SCHEMA_COUPLING: scripts\/fixture\.mjs/);
  assert.equal(adapterToCoreSchemaCoupling("const source='../adapters/example/runtime/';"),false);
  assert.equal(adapterToCoreSchemaCoupling("const target='../core/schemas/';"),false);
  assert.equal(existsSync('scripts/derive-contracts.mjs'),false);
});
