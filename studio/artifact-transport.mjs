import { createHash } from 'node:crypto';

const HASH=/^[0-9a-f]{64}$/,KEY=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/,check=(condition,reason)=>{if(!condition)throw new Error(reason)};
const safe=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.isWellFormed()&&value.trim()===value&&
  !/[\u0000-\u001f\u007f]/.test(value);
const b64=(value,bytes)=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))return false;const decoded=Buffer.from(value,'base64url');
  return decoded.length===bytes&&decoded.toString('base64url')===value};
const KEYS=['schema_version','organization_id','task_id','producer_dispatch_id','producer_attempt_id','dispatch_epoch','key_id','algorithm','iv',
  'ciphertext','auth_tag','plaintext_digest','plaintext_bytes','ciphertext_digest'];

export function artifactPackageContract(input) {
  check(input&&typeof input==='object'&&!Array.isArray(input)&&Object.getPrototypeOf(input)===Object.prototype,'INVALID_ARTIFACT_PACKAGE');
  const descriptors=Object.getOwnPropertyDescriptors(input),names=Reflect.ownKeys(descriptors);check(names.length===KEYS.length&&names.every(name=>typeof name==='string'&&
    KEYS.includes(name)&&Object.hasOwn(descriptors[name],'value')&&descriptors[name].enumerable),'INVALID_ARTIFACT_PACKAGE');const value=structuredClone(input);
  check(value.schema_version===1&&safe(value.organization_id,64)&&safe(value.task_id,128)&&safe(value.producer_dispatch_id,256)&&
    safe(value.producer_attempt_id,128)&&Number.isSafeInteger(value.dispatch_epoch)&&value.dispatch_epoch>=1&&KEY.test(value.key_id)&&
    value.algorithm==='A256GCM'&&b64(value.iv,12)&&b64(value.auth_tag,16)&&Number.isSafeInteger(value.plaintext_bytes)&&
    value.plaintext_bytes>=1&&value.plaintext_bytes<=49_152&&b64(value.ciphertext,value.plaintext_bytes)&&HASH.test(value.plaintext_digest)&&
    HASH.test(value.ciphertext_digest)&&createHash('sha256').update(Buffer.from(value.ciphertext,'base64url')).digest('hex')===value.ciphertext_digest,
  'INVALID_ARTIFACT_PACKAGE');return value;
}

export const artifactId=artifact=>`artifact-${artifactPackageContract(artifact).ciphertext_digest}`;
export const artifactPackageFromRecord=record=>artifactPackageContract(Object.fromEntries(KEYS.map(key=>[key,record[key]])));

export function artifactRecordContract(input) {const recordKeys=[...KEYS,'artifact_id','producer_node_id','created_at'];
  check(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===recordKeys.length&&recordKeys.every(key=>Object.hasOwn(input,key)),
    'INVALID_ARTIFACT_RECORD');const packageValue=artifactPackageFromRecord(input);
  check(input.artifact_id===artifactId(packageValue)&&safe(input.producer_node_id,128)&&safe(input.created_at,32)&&Number.isFinite(Date.parse(input.created_at)),
    'INVALID_ARTIFACT_RECORD');return structuredClone(input)}
