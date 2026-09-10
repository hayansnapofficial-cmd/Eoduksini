import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { canonical } from '../core/contracts.mjs';
import { artifactPackageContract } from '../studio/artifact-transport.mjs';

const check=(condition,reason)=>{if(!condition)throw new Error(reason)};
const transportKey=()=>{const encoded=process.env.EODUKSINI_ARTIFACT_KEY,key_id=process.env.EODUKSINI_ARTIFACT_KEY_ID;
  check(typeof encoded==='string'&&/^[A-Za-z0-9_-]{43}$/.test(encoded)&&typeof key_id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(key_id),
    'ARTIFACT_KEY_REQUIRED');const key=Buffer.from(encoded,'base64url');check(key.length===32&&key.toString('base64url')===encoded,'ARTIFACT_KEY_REQUIRED');return {key,key_id}};
const metadata=envelope=>({organization_id:envelope.organization_id,task_id:envelope.task_id,
  producer_dispatch_id:envelope.producer_dispatch_id??envelope.dispatch_id,producer_attempt_id:envelope.producer_attempt_id??envelope.attempt_id,
  dispatch_epoch:envelope.dispatch_epoch});
const aad=value=>Buffer.from(canonical({...metadata(value),key_id:value.key_id,algorithm:'A256GCM',plaintext_digest:value.plaintext_digest,
  plaintext_bytes:value.plaintext_bytes}),'utf8');

export function encryptArtifact(text,envelope) {check(typeof text==='string'&&text.isWellFormed(),'INVALID_ARTIFACT_PLAINTEXT');const plaintext=Buffer.from(text,'utf8');
  check(plaintext.length>=1&&plaintext.length<=49_152,'ARTIFACT_PLAINTEXT_LIMIT');const {key,key_id}=transportKey(),iv=randomBytes(12),base={...metadata(envelope),
    key_id,plaintext_digest:createHash('sha256').update(plaintext).digest('hex'),plaintext_bytes:plaintext.length},cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(aad(base));const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);return artifactPackageContract({schema_version:1,...base,
    algorithm:'A256GCM',iv:iv.toString('base64url'),ciphertext:ciphertext.toString('base64url'),auth_tag:cipher.getAuthTag().toString('base64url'),
    ciphertext_digest:createHash('sha256').update(ciphertext).digest('hex')})}

export function decryptArtifact(input) {const value=artifactPackageContract(input),{key,key_id}=transportKey();check(value.key_id===key_id,'ARTIFACT_KEY_MISMATCH');
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64url'));decipher.setAAD(aad(value));decipher.setAuthTag(Buffer.from(value.auth_tag,'base64url'));
  const plaintext=Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64url')),decipher.final()]);check(plaintext.length===value.plaintext_bytes&&
    createHash('sha256').update(plaintext).digest('hex')===value.plaintext_digest,'ARTIFACT_PLAINTEXT_MISMATCH');const text=plaintext.toString('utf8');
  check(Buffer.from(text,'utf8').equals(plaintext)&&text.isWellFormed(),'INVALID_ARTIFACT_PLAINTEXT');return text}
