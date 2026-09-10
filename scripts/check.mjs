import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { projectContract } from '../core/contracts.mjs';
import { adapterProjectPaths } from './adapter-projects.mjs';
import { assertNoAdapterToCoreSchemaCoupling } from './core-boundary.mjs';
function walk(dir) { return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]); }
for(const file of [...walk('core'),...walk('tests'),...walk('scripts'),...walk('studio'),...walk('agent')]) {
  if(/\.(?:mjs|js)$/.test(file)) execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
}
const ajv=new Ajv2020({strict:true}); addFormats(ajv);
for(const file of walk('core/schemas').filter(p=>p.endsWith('.json'))) ajv.compile(JSON.parse(readFileSync(file,'utf8')));
for(const adapter of adapterProjectPaths('.')) {
  const project=projectContract(JSON.parse(readFileSync(adapter.path,'utf8')));
  if(project.project_id!==adapter.name) throw new Error('ADAPTER_DIRECTORY_MISMATCH: '+adapter.name);
}
for(const file of walk('core')) {
  if(/GPT_ASTRA|gpt-6-astra/i.test(readFileSync(file,'utf8')))
    throw new Error('PROJECT_OR_PROVIDER_COUPLING: '+file);
}
const privateLineageNames=[
  ['rab','bit'].join(''),['bulga','sari'].join(''),['white','cloud','git'].join(''),
  ['photo','shift'].join(''),['photo','-','sift'].join(''),['wed','ing'].join(''),['wed','ding'].join(''),['uumm','123331'].join(''),
  String.fromCodePoint(47000,48727),String.fromCodePoint(48520,44032,49324,47532)
];
for(const file of ['README.md',...walk('.github'),...walk('adapters'),...walk('docs'),...walk('core'),...walk('packages'),...walk('scripts'),...walk('studio'),...walk('agent')]) {
  if(!/\.(?:md|mjs|js|ts|json|ya?ml)$/i.test(file) && file!=='README.md') continue;
  const contents=readFileSync(file,'utf8').toLocaleLowerCase('en-US');
  if(privateLineageNames.some(name=>contents.includes(name))) throw new Error('PRIVATE_LINEAGE_DISCLOSURE: '+file);
}
for(const file of walk('scripts').filter(path=>path.endsWith('.mjs')))
  assertNoAdapterToCoreSchemaCoupling(readFileSync(file,'utf8'),file);
for(const file of walk('packages/engine-primitives').filter(p=>p.endsWith('.mjs'))) execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
for(const file of walk('packages/runtime-adapters').filter(p=>p.endsWith('.mjs'))) execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
console.log('PASS: JavaScript syntax, draft-2020-12 schemas, adapters, Core boundary, engine primitives');
