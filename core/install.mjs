import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectContract, digest } from './contracts.mjs';
import { contained, repository } from './project.mjs';
// Registration only. No hook/AGENTS replacement, command execution, fetch, or database access.
export function install(root, project) {
  project=projectContract(project); root=repository(root);
  const directory=contained(root,'.eoduksini',{allowMissing:true});
  if(existsSync(directory)) {
    const file=contained(root,'.eoduksini/project.json',{allowMissing:true});
    if(existsSync(file)) {
      if(digest(projectContract(JSON.parse(readFileSync(file,'utf8'))))!==digest(project)) throw new Error('ADAPTER_ALREADY_REGISTERED');
      return {status:'UNCHANGED',project_id:project.project_id};
    }
  } else mkdirSync(directory);
  const file=join(directory,'project.json');
  try { writeFileSync(file,JSON.stringify(project,null,2)+'\n',{flag:'wx'}); }
  catch(error) { if(error.code==='EEXIST') throw new Error('ADAPTER_ALREADY_REGISTERED'); throw error; }
  return {status:'INSTALLED',project_id:project.project_id,adapter_digest:digest(project)};
}
