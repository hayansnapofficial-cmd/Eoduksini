import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const NAME=/^[a-z][a-z0-9-]{0,63}$/;
const check=(condition,reason)=>{ if(!condition) throw new Error(reason); };
const compare=(left,right)=>left<right?-1:left>right?1:0;

export function adapterProjectPaths(root) {
  const directory=join(root,'adapters'),stat=lstatSync(directory);
  check(stat.isDirectory() && !stat.isSymbolicLink(),'INVALID_ADAPTER_DIRECTORY');
  const entries=readdirSync(directory,{withFileTypes:true}).sort((left,right)=>compare(left.name,right.name));
  check(entries.length>0,'NO_ADAPTERS');
  return entries.map(entry=>{
    check(entry.isDirectory() && !entry.isSymbolicLink() && NAME.test(entry.name),'INVALID_ADAPTER_ENTRY: '+entry.name);
    const path=join(directory,entry.name,'project.json'),projectStat=lstatSync(path);
    check(projectStat.isFile() && !projectStat.isSymbolicLink(),'INVALID_ADAPTER_PROJECT: '+entry.name);
    return {name:entry.name,path,relative_path:'adapters/'+entry.name+'/project.json'};
  });
}
