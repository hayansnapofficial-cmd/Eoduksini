import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, realpathSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonical, digest } from '../contracts.mjs';
import { baseline } from '../project.mjs';
import { policyContract } from './contracts.mjs';
import { eventContract, initialState, reduce } from './state.mjs';

const MAX_EVENT_BYTES=256*1024,MAX_JOURNAL_BYTES=16*1024*1024,HEADROOM=64*1024;
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const durability=Object.freeze({scope:'file-sync/process-crash',directory_sync:process.platform==='linux'?'supported':'unsupported',power_loss_guaranteed:false});
const check=(condition,reason)=>{ if(!condition) throw new Error(reason); };

function absolutePath(path) {
  check(typeof path==='string' && isAbsolute(path) && !/^[/\\]{2}/.test(path) && !/[\x00-\x1f]/.test(path),'UNSAFE_PATH');
  const full=resolve(path);
  if(process.platform==='win32') {
    check(/^[a-z]:\\/i.test(full),'UNSAFE_PATH');
    check(!full.slice(3).split(sep).some(part=>/[. :]+$/.test(part) || part.includes(':')),'UNSAFE_PATH');
  }
  return full;
}
function statOrMissing(path) { try { return lstatSync(path); } catch(error) { if(error.code==='ENOENT') return null; throw error; } }
function inspectPath(path,{absent=false,file=false}={}) {
  const full=absolutePath(path),root=parse(full).root;
  let current=root; check(!lstatSync(current).isSymbolicLink(),'UNSAFE_PATH');
  const parts=full.slice(root.length).split(sep).filter(Boolean);
  for(let i=0;i<parts.length;i++) {
    current=join(current,parts[i]); const stat=statOrMissing(current),last=i===parts.length-1;
    if(last && absent && !stat) return join(realpathSync.native(dirname(current)),parts[i]);
    check(stat && !stat.isSymbolicLink() && (last && file?stat.isFile():stat.isDirectory()),'UNSAFE_PATH');
  }
  check(!absent,'STATE_EXISTS');
  return realpathSync.native(full);
}
function samePath(a,b) { return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b; }
function contains(parent,child) {
  const delta=relative(process.platform==='win32'?parent.toLowerCase():parent,process.platform==='win32'?child.toLowerCase():child);
  return delta==='' || (!delta.startsWith('..'+sep) && delta!=='..' && !isAbsolute(delta));
}
function separate(root,repo) { check(!contains(root,repo) && !contains(repo,root),'NESTED_STATE_PATH'); }
function syncDirectory(path) {
  if(process.platform!=='linux') return;
  const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function regularOpen(path,flags) {
  inspectPath(path,{file:true});
  const before=lstatSync(path),fd=openSync(path,flags|(constants.O_NOFOLLOW??0));
  try {
    const after=fstatSync(fd);
    check(after.isFile() && before.dev===after.dev && before.ino===after.ino && after.nlink===1,'UNSAFE_PATH');
    return fd;
  } catch(error) { closeSync(fd); throw error; }
}
function writeAll(fd,bytes) {
  for(let offset=0;offset<bytes.length;) {
    const written=writeSync(fd,bytes,offset,bytes.length-offset,null);
    check(Number.isSafeInteger(written) && written>0 && written<=bytes.length-offset,'JOURNAL_WRITE_FAILED');
    offset+=written;
  }
  fsyncSync(fd);
}
function makeEvent(state,seq,last_digest,type,payload) {
  const advancesEpoch=type==='RECOVERED' || (type==='SEMANTIC_ASSESSED' && payload?.assessment?.status!=='NON_OVERLAPPING');
  const candidate=eventContract({schema_version:1,seq:seq+1,prev_digest:last_digest,
    control_epoch:advancesEpoch?state.control_epoch+1:state?.control_epoch??1,type,payload,digest:'0'.repeat(64)});
  const {digest:ignored,...body}=candidate; return {...body,digest:digest(body)};
}

export function initializeStore(stateRoot,payload) {
  const root=inspectPath(stateRoot,{absent:true});
  let event=makeEvent(null,0,null,'INIT',payload);
  policyContract(event.payload.policy);
  const repo=inspectPath(event.payload.repo_root);
  separate(root,repo);
  if(event.payload.harness_revision)
    check(event.payload.harness_revision.source_git_sha===baseline(repo,event.payload.project).head,'INVALID_HARNESS_BINDING');
  // Persist the same physical identity used by request preparation, only after
  // descriptor validation and rejecting symbolic links in every component.
  event=makeEvent(null,0,null,'INIT',{...event.payload,repo_root:repo});
  const state=reduce(null,event),bytes=Buffer.from(canonical(event)+'\n');
  check(bytes.length<=MAX_EVENT_BYTES,'JSON_INPUT_TOO_LARGE');
  mkdirSync(root,{mode:0o700}); // Never overwrite an existing or partially initialized root.
  syncDirectory(dirname(root));
  mkdirSync(join(root,'evidence'),{mode:0o700});
  const fd=openSync(join(root,'events.jsonl'),'wx',0o600);
  try { writeAll(fd,bytes); } finally { closeSync(fd); }
  syncDirectory(root);
  return {state,seq:1,last_digest:event.digest,bytes:bytes.length,durability:{...durability},owner_present:false};
}

export function readStore(stateRoot) {
  const root=inspectPath(stateRoot),path=join(root,'events.jsonl');
  let state=initialState(),seq=0,last_digest=null,bytes;
  try {
    const fd=regularOpen(path,constants.O_RDONLY);
    try {
      const size=fstatSync(fd).size;
      check(size>0 && size<=MAX_JOURNAL_BYTES,'JOURNAL_CORRUPT');
      bytes=Buffer.alloc(size); let offset=0;
      while(offset<size) { const count=readSync(fd,bytes,offset,size-offset,null); check(count>0,'JOURNAL_CORRUPT'); offset+=count; }
      check(fstatSync(fd).size===size && bytes.at(-1)===10,'JOURNAL_CORRUPT');
    } finally { closeSync(fd); }
    const decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    for(const line of decoded.slice(0,-1).split('\n')) {
      check(line.length>0 && Buffer.byteLength(line)+1<=MAX_EVENT_BYTES,'JOURNAL_CORRUPT');
      const event=eventContract(JSON.parse(line));
      check(event.seq===seq+1 && event.prev_digest===last_digest,'JOURNAL_CORRUPT');
      state=reduce(state,event); seq=event.seq; last_digest=event.digest;
    }
    check(state!==null,'JOURNAL_CORRUPT');
  } catch(error) { throw new Error('JOURNAL_CORRUPT: '+error.message,{cause:error}); }
  const repo=inspectPath(state.repo_root); separate(root,repo);
  check(samePath(repo,state.repo_root),'NONCANONICAL_REPO_PATH');
  return {state,seq,last_digest,bytes:bytes.length,durability:{...durability},owner_present:statOrMissing(join(root,'owner'))!==null};
}

export async function withStore(stateRoot,callback) {
  const root=inspectPath(stateRoot),owner=join(root,'owner'),tokenPath=join(owner,'token');
  try { mkdirSync(owner,{mode:0o700}); }
  catch(error) { if(error.code==='EEXIST') throw new Error('OWNER_PRESENT'); throw error; }
  // Failure while creating the token leaves an explicit owner remnant, never an unowned retry.
  const token=randomBytes(32).toString('hex');
  const tokenFd=openSync(tokenPath,'wx',0o600);
  try { writeAll(tokenFd,Buffer.from(token)); } finally { closeSync(tokenFd); }
  syncDirectory(owner); syncDirectory(root);
  let valid=true,fd,meta;
  const preparedHere=new Set();
  function owned() {
    try {
      inspectPath(root); inspectPath(owner); const checkFd=regularOpen(tokenPath,constants.O_RDONLY);
      try { check(readFileSync(checkFd,'utf8')===token,'OWNER_LOST'); } finally { closeSync(checkFd); }
    } catch(error) { valid=false; throw new Error('OWNER_LOST: '+error.message,{cause:error}); }
  }
  function active() { check(valid,'SESSION_INVALID'); owned(); }
  try {
    owned(); meta=readStore(root); fd=regularOpen(join(root,'events.jsonl'),constants.O_WRONLY|constants.O_APPEND);
    const journalIdentity=fstatSync(fd);
    const session={
      get state() { return structuredClone(meta.state); },
      append(type,payload) {
        active();
        let event;
        try { event=makeEvent(meta.state,meta.seq,meta.last_digest,type,payload); }
        catch(error) { if(error.message==='JSON_INPUT_TOO_LARGE') valid=false; throw error; }
        if((type.startsWith('COMMAND_') || type==='FINISHED') && !preparedHere.has(event.payload.attempt_id)) throw new Error('RECOVERY_REQUIRED');
        const next=reduce(meta.state,event),bytes=Buffer.from(canonical(event)+'\n');
        try {
          check(bytes.length<=MAX_EVENT_BYTES && meta.bytes+bytes.length<=MAX_JOURNAL_BYTES &&
            (type!=='PREPARED' || meta.bytes+bytes.length+HEADROOM<=MAX_JOURNAL_BYTES),'JOURNAL_LIMIT');
          inspectPath(join(root,'events.jsonl'),{file:true});
          const pathStat=lstatSync(join(root,'events.jsonl')),fdStat=fstatSync(fd);
          check(pathStat.dev===journalIdentity.dev && pathStat.ino===journalIdentity.ino && fdStat.size===meta.bytes &&
            pathStat.size===meta.bytes && pathStat.nlink===1,'JOURNAL_CHANGED');
          owned(); writeAll(fd,bytes);
        } catch(error) { valid=false; throw error; }
        meta={...meta,state:next,seq:event.seq,last_digest:event.digest,bytes:meta.bytes+bytes.length};
        if(type==='PREPARED') preparedHere.add(event.payload.attempt_id);
        return structuredClone(next);
      },
      evidencePath(attemptId,index) {
        active();
        check(typeof attemptId==='string' && ID.test(attemptId) && !['constructor','prototype','__proto__'].includes(attemptId) &&
          Number.isSafeInteger(index) && index>=0 && index<16,'INVALID_EVIDENCE');
        check(preparedHere.has(attemptId) && Object.hasOwn(meta.state.attempts,attemptId),'UNKNOWN_ATTEMPT');
        check(index<meta.state.approvals[attemptId].request.commands.length,'INVALID_EVIDENCE');
        const evidence=inspectPath(join(root,'evidence')),directory=join(evidence,attemptId);
        if(!statOrMissing(directory)) { mkdirSync(directory,{mode:0o700}); syncDirectory(evidence); }
        inspectPath(directory);
        const path=join(directory,String(index)+'.bin');
        if(statOrMissing(path)) inspectPath(path,{file:true});
        return path;
      }
    };
    return await callback(session);
  } finally {
    valid=false;
    if(fd!==undefined) closeSync(fd);
    owned(); unlinkSync(tokenPath); rmdirSync(owner); syncDirectory(root);
  }
}
