import { mkdirSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const ACTIVE=new Set(['active','trialing']);
const SUBSCRIPTION=new Set(['active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused']);
const empty=()=>({schema_version:1,users:{},processed_webhook_ids:[]});
const validId=value=>typeof value==='string' && /^[1-9][0-9]{0,31}$/.test(value);
const safeText=(value,max=256)=>typeof value==='string' && value.length>0 && value.length<=max && value.isWellFormed();
const check=(condition,reason)=>{if(!condition) throw new Error(reason)};

function validate(data) {
  check(data && Object.keys(data).length===3 && data.schema_version===1 && data.users && typeof data.users==='object' &&
    !Array.isArray(data.users) && Object.keys(data.users).length<=10_000,
    'INVALID_ACCESS_STORE');
  check(Array.isArray(data.processed_webhook_ids) && data.processed_webhook_ids.length<=1000 &&
    data.processed_webhook_ids.every(id=>safeText(id,128)) &&
    new Set(data.processed_webhook_ids).size===data.processed_webhook_ids.length,'INVALID_ACCESS_STORE');
  for(const [id,user] of Object.entries(data.users)) {
    check(validId(id) && user && Object.keys(user).length===8 && user.github_id===id && safeText(user.login,128) &&
      (user.avatar_url===null || safeText(user.avatar_url,512)) &&
      (user.stripe_customer_id===null || safeText(user.stripe_customer_id,128)) &&
      (user.stripe_subscription_id===null || safeText(user.stripe_subscription_id,128)) &&
      (user.subscription_status===null || SUBSCRIPTION.has(user.subscription_status)) &&
      (user.current_period_end===null || (Number.isSafeInteger(user.current_period_end) && user.current_period_end>=0)) && safeText(user.updated_at,32),
    'INVALID_ACCESS_STORE');
  }
  return structuredClone(data);
}

export function createAccessStore(root) {
  check(isAbsolute(root) && resolve(root)===root,'ACCESS_ROOT_MUST_BE_ABSOLUTE');
  const parent=lstatSync(dirname(root),{throwIfNoEntry:false});check(parent?.isDirectory() && !parent.isSymbolicLink(),'UNSAFE_ACCESS_PARENT');
  const existing=lstatSync(root,{throwIfNoEntry:false});
  if(existing) check(existing.isDirectory() && !existing.isSymbolicLink(),'UNSAFE_ACCESS_ROOT');
  else mkdirSync(root,{mode:0o700});
  const file=join(root,'access.json');
  const stored=lstatSync(file,{throwIfNoEntry:false});
  if(stored) check(stored.isFile() && !stored.isSymbolicLink(),'UNSAFE_ACCESS_FILE');
  else writeFileSync(file,JSON.stringify(empty(),null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
  const load=()=>{check(lstatSync(file).size<=8*1024*1024,'ACCESS_STORE_TOO_LARGE');return validate(JSON.parse(readFileSync(file,'utf8')))};
  const save=data=>{
    data=validate(data);const temporary=join(root,`.access-${randomUUID()}.tmp`);
    writeFileSync(temporary,JSON.stringify(data,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
    renameSync(temporary,file);
  };
  let queue=Promise.resolve();
  const update=operation=>{const result=queue.then(()=>{const data=load(),value=operation(data);save(data);return value});queue=result.catch(()=>{});return result};
  return {
    user:id=>load().users[String(id)]??null,
    users:()=>Object.values(load().users).map(structuredClone),
    upsertIdentity(identity){return update(data=>{
      const id=String(identity.github_id),prior=data.users[id];check(validId(id) && safeText(identity.login,128),'INVALID_GITHUB_IDENTITY');
      data.users[id]={github_id:id,login:identity.login,avatar_url:identity.avatar_url??null,
        stripe_customer_id:prior?.stripe_customer_id??null,stripe_subscription_id:prior?.stripe_subscription_id??null,
        subscription_status:prior?.subscription_status??null,current_period_end:prior?.current_period_end??null,
        updated_at:new Date().toISOString()};return structuredClone(data.users[id]);
    })},
    applySubscription({event_id,github_id,customer_id,subscription_id,status,current_period_end}){return update(data=>{
      check(safeText(event_id,128) && validId(String(github_id)) && safeText(customer_id,128) && safeText(subscription_id,128) &&
        SUBSCRIPTION.has(status) && (current_period_end===null || (Number.isSafeInteger(current_period_end) && current_period_end>=0)),'INVALID_SUBSCRIPTION_EVENT');
      if(data.processed_webhook_ids.includes(event_id)) return {changed:false};
      const user=data.users[String(github_id)];check(user,'UNKNOWN_SUBSCRIPTION_USER');
      user.stripe_customer_id=customer_id;user.stripe_subscription_id=subscription_id;user.subscription_status=status;
      user.current_period_end=current_period_end;user.updated_at=new Date().toISOString();
      data.processed_webhook_ids.push(event_id);data.processed_webhook_ids=data.processed_webhook_ids.slice(-1000);
      return {changed:true};
    })},
    entitlement(id){const user=load().users[String(id)];return {active:Boolean(user && ACTIVE.has(user.subscription_status)),
      status:user?.subscription_status??'none',current_period_end:user?.current_period_end??null}}
  };
}
