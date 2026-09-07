import { closeSync, constants, openSync, readFileSync } from 'node:fs';
import { attachCommandResources } from '../../../core/metering.mjs';
import { runCommandMetered } from '../../../core/controller/runner.mjs';

const FORMAT='EODUKSINI_GNU_TIME_V1\t%U\t%S\t%M';
const check=(condition,reason)=>{if(!condition) throw new Error(reason);};

export function linuxBootId(path='/proc/sys/kernel/random/boot_id') {
  try {
    const value=readFileSync(path,'utf8').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)?value:null;
  } catch { return null; }
}

export function parseGnuTime(value) {
  check(typeof value==='string' && value.length<=1024,'INVALID_GNU_TIME_EVIDENCE');
  const lines=value.trim().split(/\r?\n/).filter(Boolean);
  check(lines.length===1,'INVALID_GNU_TIME_EVIDENCE');
  const fields=lines[0].split('\t');
  check(fields.length===4 && fields[0]==='EODUKSINI_GNU_TIME_V1','INVALID_GNU_TIME_EVIDENCE');
  const cpu_user_seconds=Number(fields[1]),cpu_system_seconds=Number(fields[2]),memoryKib=Number(fields[3]);
  check(Number.isFinite(cpu_user_seconds) && cpu_user_seconds>=0 && Number.isFinite(cpu_system_seconds) &&
    cpu_system_seconds>=0 && Number.isSafeInteger(memoryKib) && memoryKib>=0,'INVALID_GNU_TIME_EVIDENCE');
  const memory_peak_bytes=memoryKib*1024;
  check(Number.isSafeInteger(memory_peak_bytes),'INVALID_GNU_TIME_EVIDENCE');
  return {cpu_user_seconds,cpu_system_seconds,memory_peak_bytes};
}

export async function runLinuxGnuTimeMetered(command,options,{timeExecutable='/usr/bin/time',bootIdPath}={}) {
  check(process.platform==='linux' && typeof options?.transcript_path==='string','GNU_TIME_UNAVAILABLE');
  const resourcePath=options.transcript_path+'.gnu-time';
  let descriptor;
  try {
    descriptor=openSync(resourcePath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
    closeSync(descriptor);descriptor=undefined;
  } catch {
    if(descriptor!==undefined) try {closeSync(descriptor);} catch {}
    throw new Error('RESOURCE_EVIDENCE_CREATE_FAILED');
  }
  const wrapped={executable:timeExecutable,argv:['-q','-a','-o',resourcePath,'-f',FORMAT,'--',command.executable,...command.argv],cwd:command.cwd};
  const observed=await runCommandMetered(wrapped,{...options,boot_id:linuxBootId(bootIdPath)});
  if(!observed.result.close_observed) return observed;
  try {
    observed.measurement=attachCommandResources(observed.measurement,parseGnuTime(readFileSync(resourcePath,'utf8')));
  } catch {}
  return observed;
}
