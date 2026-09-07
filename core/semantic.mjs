import { lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { canonical, safePath, validate } from './contracts.mjs';
import { git, repository } from './project.mjs';

const FIELDS=['read_paths','write_paths','symbols','api_routes','request_contracts','response_contracts',
  'database_objects','migration_objects','environment_keys','generated_types','runtime_services','dependencies'];
const CONFLICT_FIELDS=FIELDS.filter(field=>field!=='read_paths');
const MAX_SCAN_BYTES=1024*1024;
const MAX_SCAN_FILES=256,MAX_TOTAL_SCAN_BYTES=8*1024*1024,MAX_FACTS_PER_FIELD=512;
const check=(condition,reason)=>{if(!condition) throw new Error(reason);};
const text=value=>typeof value==='string' && value.length>0 && value.length<=512 && !/[\x00-\x1f]/.test(value);
const confidence=value=>typeof value==='number' && Number.isFinite(value) && value>=0 && value<=1;

function trackedPath(value) {
  check(typeof value==='string' && value.length>0 && value.length<=512 && !value.includes('\\') && !value.startsWith('/') &&
    !/[:\x00-\x1f]/.test(value) && !value.split('/').some(part=>!part || part==='.' || part==='..' ||
      ['.git','.eoduksini'].includes(part.toLowerCase()) || /[. ]$/.test(part)),'UNSAFE_TRACKED_PATH');
  return value;
}
function scannerMatches(file,pattern) {
  trackedPath(file); safePath(pattern,{glob:true});
  if(process.platform==='win32') { file=file.toLowerCase(); pattern=pattern.toLowerCase(); }
  const escaped=pattern.split('**').map(part=>part.split('*').map(value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*')).join('.*');
  return new RegExp('^'+escaped+'$').test(file) || (!pattern.includes('*') && file.startsWith(pattern+'/'));
}

function exact(value,keys,reason) {
  check(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length &&
    keys.every(key=>Object.hasOwn(value,key)),reason);
}
function sorted(values) { return [...new Set(values)].sort(); }
const compareCanonical=(left,right)=>canonical(left)<canonical(right)?-1:canonical(left)>canonical(right)?1:0;
function uncertaintyContract(value) {
  exact(value,['subject','reason','confidence'],'INVALID_SEMANTIC_FOOTPRINT');
  check(text(value.subject) && text(value.reason) && confidence(value.confidence),'INVALID_SEMANTIC_FOOTPRINT');
  return structuredClone(value);
}

export function semanticFootprintContract(value) {
  validate('semantic-footprint',value);
  exact(value,[...FIELDS,'uncertainty'],'INVALID_SEMANTIC_FOOTPRINT');
  const output={};
  for(const field of FIELDS) {
    check(Array.isArray(value[field]) && value[field].every(text),'INVALID_SEMANTIC_FOOTPRINT');
    if(field==='read_paths') value[field].forEach(trackedPath);
    if(field==='write_paths') value[field].forEach(path=>safePath(path,{glob:true}));
    output[field]=sorted(value[field]);
    check(canonical(output[field])===canonical(value[field]),'INVALID_SEMANTIC_FOOTPRINT');
  }
  check(Array.isArray(value.uncertainty),'INVALID_SEMANTIC_FOOTPRINT');
  output.uncertainty=value.uncertainty.map(uncertaintyContract).sort(compareCanonical);
  check(canonical(output.uncertainty)===canonical(value.uncertainty),'INVALID_SEMANTIC_FOOTPRINT');
  return structuredClone(output);
}

export function requestSemanticFootprint(request) {
  return semanticFootprintContract(request.semantic_footprint??{
    read_paths:[],write_paths:request.scope.write_paths,symbols:request.scope.symbols,api_routes:request.scope.api_routes,
    request_contracts:request.scope.request_contracts,response_contracts:request.scope.response_contracts,
    database_objects:request.scope.database_objects,migration_objects:request.scope.migration_objects,
    environment_keys:request.scope.environment_keys,generated_types:request.scope.generated_types,
    runtime_services:request.scope.runtime_services,dependencies:[],uncertainty:[{
      subject:'attempt:'+request.attempt_id,reason:'LEGACY_SEMANTIC_FOOTPRINT_MISSING',confidence:0}]});
}

function addMatches(target,source,pattern) {
  for(const match of source.matchAll(pattern)) target.push(match[1]);
}
function packageName(specifier) {
  if(specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  return specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];
}
function apiRoute(path) {
  const parts=path.replace(/\.[^.\/]+$/,'').split('/'),index=parts.indexOf('api');
  if(index<0) return null;
  const route=parts.slice(index+1).filter(part=>!['route','index'].includes(part)).map(part=>
    /^\[\.\.\.(.+)\]$/.test(part)?'*'+part.slice(4,-1):/^\[(.+)\]$/.test(part)?':'+part.slice(1,-1):part);
  return '/api/'+route.join('/');
}
function sqlName(value) { return value.replaceAll('"','').toLowerCase(); }

function scanText(path,content,out) {
  if(/\.(?:[cm]?[jt]sx?)$/i.test(path)) {
    addMatches(out.environment_keys,content,/\b(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]*)\b/g);
    if(/\b(?:process\.env|import\.meta\.env)\s*\[/.test(content))
      out.uncertainty.push({subject:path,reason:'DYNAMIC_ENVIRONMENT_KEY',confidence:0});

    for(const match of content.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) {
      const name=match[1]; out.symbols.push(name);
      if(/(?:Request|Input|Params)$/.test(name)) out.request_contracts.push(name);
      if(/(?:Response|Output|Result)$/.test(name)) out.response_contracts.push(name);
      if(/(?:^|\/)(?:generated|__generated__)(?:\/|$)|\.generated\./i.test(path)) out.generated_types.push(name);
    }
    for(const match of content.matchAll(/\b(?:from\s*|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g)) {
      const dependency=packageName(match[1]); if(dependency) out.dependencies.push(dependency);
    }
    if(/\bimport\s*\(\s*(?!['"])/.test(content) || /\brequire\s*\(\s*(?!['"])/.test(content))
      out.uncertainty.push({subject:path,reason:'DYNAMIC_DEPENDENCY',confidence:0});
  }
  const route=apiRoute(path); if(route) out.api_routes.push(route);
  if(/\.sql$/i.test(path)) {
    for(const match of content.matchAll(/\b(?:create|alter|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?([A-Za-z0-9_."]+)/gi)) {
      const table=sqlName(match[1]); out.database_objects.push(table); out.migration_objects.push('table:'+table);
    }
    for(const match of content.matchAll(/\balter\s+table\s+([A-Za-z0-9_."]+)\s+(?:add|alter|drop)\s+(?:column\s+)?([A-Za-z0-9_"]+)/gi)) {
      const table=sqlName(match[1]),column=sqlName(match[2]);
      out.database_objects.push(table); out.migration_objects.push('column:'+table+'.'+column);
    }
    if(/\b(?:execute|format)\s*\(/i.test(content))
      out.uncertainty.push({subject:path,reason:'DYNAMIC_DATABASE_STATEMENT',confidence:0});
  }
}

function addDependencyMap(value,out) {
  for(const field of ['dependencies','devDependencies','peerDependencies','optionalDependencies'])
    if(value?.[field] && typeof value[field]==='object' && !Array.isArray(value[field])) out.dependencies.push(...Object.keys(value[field]));
}
function scanStructured(path,content,out) {
  const name=basename(path);
  if(name==='package.json') {
    try { addDependencyMap(JSON.parse(content),out); }
    catch { out.uncertainty.push({subject:path,reason:'UNPARSEABLE_PACKAGE_MANIFEST',confidence:0}); }
  }
  if(['package-lock.json','npm-shrinkwrap.json'].includes(name)) {
    try {
      const value=JSON.parse(content); addDependencyMap(value,out);
      for(const entry of Object.keys(value.packages??{})) if(entry.includes('node_modules/')) {
        const specifier=entry.slice(entry.lastIndexOf('node_modules/')+'node_modules/'.length),parts=specifier.split('/');
        out.dependencies.push(parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0]);
      }
    } catch { out.uncertainty.push({subject:path,reason:'UNPARSEABLE_DEPENDENCY_LOCK',confidence:0}); }
  }
  if(['yarn.lock','pnpm-lock.yaml','pnpm-lock.yml','bun.lock','bun.lockb'].includes(name))
    out.uncertainty.push({subject:path,reason:'LOCKFILE_FORMAT_NOT_ANALYZED',confidence:0});
  if(/^\.env(?:\..+)?$/.test(name))
    addMatches(out.environment_keys,content,/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm);
  if(/\.prisma$/i.test(path)) {
    for(const model of content.matchAll(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)) out.database_objects.push(model[1]);
    let current=null;
    for(const line of content.split(/\r?\n/)) {
      const model=line.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/); if(model) { current=model[1]; continue; }
      if(current && /^\s*}/.test(line)) { current=null; continue; }
      const field=current?line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z_][A-Za-z0-9_]*(?:\[\])?[?!]?/):null;
      if(field) out.migration_objects.push('field:'+current+'.'+field[1]);
    }
    addMatches(out.environment_keys,content,/\benv\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g);
  }
  if(/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(path))
    out.uncertainty.push({subject:path,reason:'WORKFLOW_SEMANTICS_NOT_ANALYZED',confidence:0});
  if(['pnpm-workspace.yaml','pnpm-workspace.yml','lerna.json','nx.json','turbo.json'].includes(name))
    out.uncertainty.push({subject:path,reason:'WORKSPACE_SEMANTICS_NOT_ANALYZED',confidence:0});
}
function scanServices(path,content,out) {
  if(/^Dockerfile(?:\..+)?$/i.test(basename(path))) {
    for(const match of content.matchAll(/^\s*FROM\s+([^\s]+)(?:\s+AS\s+([A-Za-z0-9._-]+))?/gmi))
      out.runtime_services.push(match[2]??match[1]);
  }
  if(/(?:^|\/)(?:compose|docker-compose)(?:\.[^.]+)?\.ya?ml$/i.test(path)) {
    const lines=content.split(/\r?\n/); let inServices=false,indent=-1;
    for(const line of lines) {
      if(/^\s*services\s*:\s*(?:#.*)?$/.test(line)) { inServices=true; indent=line.match(/^\s*/)[0].length; continue; }
      if(!inServices || !line.trim() || /^\s*#/.test(line)) continue;
      const current=line.match(/^\s*/)[0].length;
      if(current<=indent) { inServices=false; continue; }
      const match=line.match(/^\s+([A-Za-z0-9._-]+)\s*:\s*(?:#.*)?$/); if(match && current===indent+2) out.runtime_services.push(match[1]);
    }
  }
}

export function scanSemanticFootprint(root,{write_paths,declared_scope={}}) {
  root=repository(root);
  check(Array.isArray(write_paths) && write_paths.length>0,'INVALID_SCAN_REQUEST');
  write_paths.forEach(path=>safePath(path,{glob:true}));
  const files=git(root,['ls-files','-z']).split('\0').filter(Boolean).map(path=>path.replaceAll('\\','/'));
  const allMatched=files.filter(file=>write_paths.some(pattern=>scannerMatches(file,pattern))).sort();
  const matched=allMatched.slice(0,MAX_SCAN_FILES);
  const out=Object.fromEntries(FIELDS.map(field=>[field,[]])); out.uncertainty=[];
  if(allMatched.length>MAX_SCAN_FILES)
    out.uncertainty.push({subject:'repository-scan',reason:'TRACKED_FILE_LIMIT_EXCEEDED',confidence:0});
  out.write_paths.push(...write_paths);
  const declaredMap={symbols:'symbols',api_routes:'api_routes',request_contracts:'request_contracts',
    response_contracts:'response_contracts',database_objects:'database_objects',migration_objects:'migration_objects',
    environment_keys:'environment_keys',generated_types:'generated_types',runtime_services:'runtime_services'};
  for(const [source,target] of Object.entries(declaredMap)) if(Array.isArray(declared_scope[source])) out[target].push(...declared_scope[source]);
  for(const pattern of write_paths) if(!allMatched.some(file=>scannerMatches(file,pattern)))
    out.uncertainty.push({subject:pattern,reason:'NO_TRACKED_WRITE_PATH_MATCH',confidence:0});
  let totalBytes=0;
  for(const path of matched) {
    trackedPath(path); out.read_paths.push(path);
    const full=join(root,...path.split('/')),stat=lstatSync(full);
    if(!stat.isFile() || stat.size>MAX_SCAN_BYTES) {
      out.uncertainty.push({subject:path,reason:stat.isFile()?'SCAN_FILE_TOO_LARGE':'SCAN_TARGET_NOT_REGULAR',confidence:0}); continue;
    }
    if(totalBytes+stat.size>MAX_TOTAL_SCAN_BYTES) {
      out.uncertainty.push({subject:path,reason:'TOTAL_SCAN_BYTES_EXCEEDED',confidence:0}); continue;
    }
    totalBytes+=stat.size;
    const bytes=readFileSync(full);
    if(bytes.includes(0)) { out.uncertainty.push({subject:path,reason:'BINARY_CONTENT_NOT_ANALYZED',confidence:0}); continue; }
    let content;
    try { content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); }
    catch { out.uncertainty.push({subject:path,reason:'INVALID_UTF8_NOT_ANALYZED',confidence:0}); continue; }
    scanText(path,content,out); scanStructured(path,content,out); scanServices(path,content,out);
  }
  for(const field of FIELDS) {
    const values=sorted(out[field]),valid=values.filter(text);
    if(valid.length!==values.length) out.uncertainty.push({subject:field,reason:'SEMANTIC_FACT_OUT_OF_BOUNDS',confidence:0});
    if(valid.length>MAX_FACTS_PER_FIELD) out.uncertainty.push({subject:field,reason:'SEMANTIC_FACT_LIMIT_EXCEEDED',confidence:0});
    out[field]=valid.slice(0,MAX_FACTS_PER_FIELD);
  }
  out.uncertainty=[...new Map(out.uncertainty.map(item=>[canonical(item),item])).values()].sort(compareCanonical);
  return semanticFootprintContract(out);
}

function pathOverlap(left,right) {
  const ap=left.split('*')[0].replace(/\/$/,''),bp=right.split('*')[0].replace(/\/$/,'');
  return ap===bp || !ap || !bp || ap.startsWith(bp+'/') || bp.startsWith(ap+'/') ||
    (left.includes('*') && bp.startsWith(ap)) || (right.includes('*') && ap.startsWith(bp));
}

export function compareSemanticFootprints(left,right) {
  left=semanticFootprintContract(left); right=semanticFootprintContract(right);
  const conflicts=[];
  for(const field of CONFLICT_FIELDS) for(const a of left[field]) for(const b of right[field]) {
    if(field==='write_paths'?!pathOverlap(a,b):a!==b) continue;
    conflicts.push({field,left:a,right:b});
  }
  const uncertainty=[...left.uncertainty,...right.uncertainty];
  const status=uncertainty.length?'MANUAL_DECISION_REQUIRED':conflicts.length?'SEMANTIC_CONFLICT':'NON_OVERLAPPING';
  return {status,conflicts:[...new Map(conflicts.map(item=>[canonical(item),item])).values()].sort(compareCanonical),
    uncertainty:[...new Map(uncertainty.map(item=>[canonical(item),item])).values()].sort(compareCanonical)};
}

export function semanticAssessmentContract(value) {
  exact(value,['status','compared_attempt_ids','conflicts','uncertainty'],'INVALID_SEMANTIC_ASSESSMENT');
  check(['NON_OVERLAPPING','SEMANTIC_CONFLICT','MANUAL_DECISION_REQUIRED'].includes(value.status) &&
    Array.isArray(value.compared_attempt_ids) && value.compared_attempt_ids.every(text) &&
    canonical(sorted(value.compared_attempt_ids))===canonical(value.compared_attempt_ids),'INVALID_SEMANTIC_ASSESSMENT');
  check(Array.isArray(value.conflicts) && value.conflicts.every(item=>{
    try { exact(item,['field','left','right','other_attempt_id'],'INVALID_SEMANTIC_ASSESSMENT'); }
    catch { return false; }
    return CONFLICT_FIELDS.includes(item.field) && text(item.left) && text(item.right) && text(item.other_attempt_id);
  }),'INVALID_SEMANTIC_ASSESSMENT');
  check(Array.isArray(value.uncertainty),'INVALID_SEMANTIC_ASSESSMENT');
  const uncertainty=value.uncertainty.map(uncertaintyContract);
  const sortedConflicts=[...new Map(value.conflicts.map(item=>[canonical(item),item])).values()].sort(compareCanonical);
  const sortedUncertainty=[...new Map(uncertainty.map(item=>[canonical(item),item])).values()].sort(compareCanonical);
  check(canonical(sortedConflicts)===canonical(value.conflicts) && canonical(sortedUncertainty)===canonical(value.uncertainty),
    'INVALID_SEMANTIC_ASSESSMENT');
  check((value.status==='NON_OVERLAPPING')===(value.conflicts.length===0 && uncertainty.length===0) &&
    (value.status!=='SEMANTIC_CONFLICT' || value.conflicts.length>0) &&
    (value.status!=='MANUAL_DECISION_REQUIRED' || uncertainty.length>0),'INVALID_SEMANTIC_ASSESSMENT');
  return structuredClone(value);
}

export function assessSemanticAdmission(request,peers) {
  const footprint=requestSemanticFootprint(request),conflicts=[],uncertainty=[...footprint.uncertainty];
  const ids=[];
  for(const peer of peers) {
    ids.push(peer.attempt_id);
    const compared=compareSemanticFootprints(footprint,peer.semantic_footprint);
    uncertainty.push(...compared.uncertainty);
    conflicts.push(...compared.conflicts.map(item=>({...item,other_attempt_id:peer.attempt_id})));
  }
  const uniqueUncertainty=[...new Map(uncertainty.map(item=>[canonical(item),item])).values()].sort(compareCanonical);
  const uniqueConflicts=[...new Map(conflicts.map(item=>[canonical(item),item])).values()].sort(compareCanonical);
  return semanticAssessmentContract({status:uniqueUncertainty.length?'MANUAL_DECISION_REQUIRED':uniqueConflicts.length?'SEMANTIC_CONFLICT':'NON_OVERLAPPING',
    compared_attempt_ids:sorted(ids),conflicts:uniqueConflicts,uncertainty:uniqueUncertainty});
}
