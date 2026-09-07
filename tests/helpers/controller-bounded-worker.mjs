// TEST ONLY: the real direct child survives a narrowly simulated failed kill.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createController } from '../../core/controller/controller.mjs';

const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const realSpawn=childProcess.spawn;
childProcess.spawn=(...args)=>{
  const child=realSpawn(...args);
  child.kill=()=>false;
  return child;
};
syncBuiltinESMExports();
const started=performance.now();
const result=await createController().run(config.stateRoot,config.input);
process.stdout.write(JSON.stringify({result,elapsed_ms:performance.now()-started})+'\n');
// Natural event-loop exit is the assertion target. No process.exit or IPC handle.
