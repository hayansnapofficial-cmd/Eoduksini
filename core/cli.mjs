#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { validate } from './contracts.mjs';
import { loadProject, baseline, planTask, drift } from './project.mjs';
import { install } from './install.mjs';
import { resourcePlan, workerPlan, networkPlan, inspectRequirements } from './reuse.mjs';
import { controllerMain } from './controller/cli.mjs';
export function main(args=process.argv.slice(2)) {
  const [command,...rest]=args;
  if(command==='controller') return controllerMain(rest);
  const json=p=>JSON.parse(readFileSync(p,'utf8'));
  const planned=result=>{ if(result.status==='BLOCKED') process.exitCode=2; return result; };
  if(command==='resources' && rest.length===1) return planned(resourcePlan(json(rest[0])));
  if(command==='workers' && rest.length===1) return planned(workerPlan(json(rest[0])));
  if(command==='network' && rest.length===1) return networkPlan(json(rest[0]));
  if(command==='requirements' && rest.length===1) return inspectRequirements(json(rest[0]));
  if(command==='validate' && rest.length===2) { validate(rest[0],json(rest[1])); return {valid:true,contract:rest[0]}; }
  if(command==='inspect' && rest.length===2) return baseline(rest[0],loadProject(rest[1]));
  if(command==='plan' && rest.length===3) return planTask(rest[0],loadProject(rest[1]),json(rest[2]));
  if(command==='install' && rest.length===2) return install(rest[0],loadProject(rest[1]));
  if(command==='drift' && rest.length===3) {
    const result=drift(json(rest[2]),baseline(rest[0],loadProject(rest[1])));
    if(result.status!=='UNCHANGED') process.exitCode=2;
    return result;
  }
  throw new Error('Usage: eoduksini validate <kind> <json> | inspect <repo> <project.json> | plan <repo> <project.json> <task.json> | install <repo> <project.json> | drift <repo> <project.json> <baseline.json> | resources/workers/network/requirements <json>');
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try { console.log(JSON.stringify(await main(),null,2)); }
  catch(error) { console.error(JSON.stringify({status:'REJECTED',reason:error.message})); process.exitCode=1; }
}
