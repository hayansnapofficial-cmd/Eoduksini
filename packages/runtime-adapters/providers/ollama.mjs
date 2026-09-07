import { readFileSync } from 'node:fs';
import { invocationContract } from '../../../core/metering.mjs';
import { resultContract } from '../../../core/controller/contracts.mjs';
import { runLinuxGnuTimeMetered } from '../observability/linux-gnu-time.mjs';

const check=(condition,reason)=>{if(!condition) throw new Error(reason);};

export function ollamaReceiptContract(value) {
  check(value && typeof value==='object' && !Array.isArray(value) && Object.getPrototypeOf(value)===Object.prototype,
    'INVALID_OLLAMA_RECEIPT');
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  check(keys.length===2 && keys.every(key=>typeof key==='string' && ['invocation','response_digest'].includes(key)) &&
    keys.every(key=>Object.hasOwn(descriptors[key],'value') && descriptors[key].enumerable),'INVALID_OLLAMA_RECEIPT');
  const invocation=invocationContract(descriptors.invocation.value),response_digest=descriptors.response_digest.value;
  check(typeof response_digest==='string' && /^[0-9a-f]{64}$/.test(response_digest),'INVALID_OLLAMA_RECEIPT');
  return {invocation,response_digest};
}

export async function runOllamaCommandMetered(command,options) {
  const observed=await runLinuxGnuTimeMetered(command,options);
  try {
    const receipt=ollamaReceiptContract(JSON.parse(readFileSync(options.transcript_path,'utf8')));
    return {...observed,invocations:[receipt.invocation]};
  } catch {
    return {result:resultContract({...observed.result,status:'RECOVERY_REQUIRED',reason:'PROVIDER_RECEIPT_INVALID'}),
      measurement:observed.measurement,invocations:[]};
  }
}
