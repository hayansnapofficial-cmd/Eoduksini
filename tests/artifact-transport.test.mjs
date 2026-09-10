import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decryptArtifact, encryptArtifact } from '../agent/artifact-crypto.mjs';
import { artifactPackageContract } from '../studio/artifact-transport.mjs';

const envelope={organization_id:'org-42',task_id:'TASK-1',dispatch_id:'TASK-1:head',attempt_id:'attempt-11111111-1111-4111-8111-111111111111',dispatch_epoch:3};

test('artifact encryption binds plaintext and dispatch metadata while the server package stays opaque',()=>{const prior=process.env.EODUKSINI_ARTIFACT_KEY,
    priorId=process.env.EODUKSINI_ARTIFACT_KEY_ID;process.env.EODUKSINI_ARTIFACT_KEY=Buffer.alloc(32,9).toString('base64url');
  process.env.EODUKSINI_ARTIFACT_KEY_ID='tenant-key-1';try{const artifact=encryptArtifact('bounded role result',envelope);
    assert.equal(decryptArtifact(artifact),'bounded role result');assert.equal(JSON.stringify(artifact).includes('bounded role result'),false);
    assert.equal(artifact.plaintext_digest,createHash('sha256').update('bounded role result').digest('hex'));
    const ciphertext=Buffer.from(artifact.ciphertext,'base64url');ciphertext[0]^=1;const tampered={...artifact,ciphertext:ciphertext.toString('base64url'),
      ciphertext_digest:createHash('sha256').update(ciphertext).digest('hex')};assert.throws(()=>decryptArtifact(tampered));
    process.env.EODUKSINI_ARTIFACT_KEY=Buffer.alloc(32,8).toString('base64url');assert.throws(()=>decryptArtifact(artifact));
    const accessor={...artifact};Object.defineProperty(accessor,'ciphertext',{enumerable:true,get:()=>artifact.ciphertext});
    assert.throws(()=>artifactPackageContract(accessor),/INVALID_ARTIFACT_PACKAGE/)
  }finally{if(prior===undefined)delete process.env.EODUKSINI_ARTIFACT_KEY;else process.env.EODUKSINI_ARTIFACT_KEY=prior;
    if(priorId===undefined)delete process.env.EODUKSINI_ARTIFACT_KEY_ID;else process.env.EODUKSINI_ARTIFACT_KEY_ID=priorId}});
