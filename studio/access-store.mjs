import { mkdirSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPaidPlan, subscriptionEntitlement } from './plans.mjs';

const SUBSCRIPTION=new Set(['active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused']);
const PROVIDERS=new Set(['payapp','stripe']);
const empty=()=>({schema_version:4,users:{},organizations:{},memberships:{},processed_webhook_ids:[],billing_requests:{}});
const validId=value=>typeof value==='string'&&/^[1-9][0-9]{0,31}$/.test(value);
const validOrganizationId=value=>typeof value==='string'&&/^org-[1-9][0-9]{0,31}$/.test(value);
const safeText=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.isWellFormed();
const nullableText=(value,max=256)=>value===null||safeText(value,max);
const check=(condition,reason)=>{if(!condition)throw new Error(reason)};

function migrate(data) {
  if(data?.schema_version===1){const users={};
    for(const [id,user] of Object.entries(data.users??{}))users[id]={github_id:user.github_id,login:user.login,avatar_url:user.avatar_url??null,
      billing_provider:user.stripe_subscription_id||user.stripe_customer_id?'stripe':null,billing_customer_id:user.stripe_customer_id??null,
      billing_subscription_id:user.stripe_subscription_id??null,subscription_status:user.subscription_status??null,
      current_period_end:user.current_period_end??null,updated_at:user.updated_at};
    data={schema_version:2,users,processed_webhook_ids:data.processed_webhook_ids??[],billing_requests:{}}}
  if(data?.schema_version===2){const users={};
    for(const [id,user] of Object.entries(data.users??{}))users[id]={...user,plan_id:['active','trialing'].includes(user.subscription_status)?'core':null};
    const billing_requests={};for(const [id,request] of Object.entries(data.billing_requests??{}))billing_requests[id]={...request,plan_id:'core'};
    data={...data,schema_version:3,users,billing_requests}}
  if(data?.schema_version===3){const organizations={},memberships={};
    for(const user of Object.values(data.users??{})){const organization_id=`org-${user.github_id}`,now=user.updated_at;
      organizations[organization_id]={organization_id,name:`${user.login} Workspace`,slug:`github-${user.github_id}`,created_at:now,updated_at:now};
      memberships[`${organization_id}:${user.github_id}`]={organization_id,github_id:user.github_id,role:'owner',created_at:now}}
    data={...data,schema_version:4,organizations,memberships}}
  return data;
}

function validate(input) {
  const data=migrate(input);
  check(data&&Object.keys(data).length===6&&data.schema_version===4&&data.users&&typeof data.users==='object'&&!Array.isArray(data.users)&&
    Object.keys(data.users).length<=10_000&&data.billing_requests&&typeof data.billing_requests==='object'&&!Array.isArray(data.billing_requests)&&
    Object.keys(data.billing_requests).length<=10_000&&data.organizations&&typeof data.organizations==='object'&&!Array.isArray(data.organizations)&&
    Object.keys(data.organizations).length<=10_000&&data.memberships&&typeof data.memberships==='object'&&!Array.isArray(data.memberships)&&
    Object.keys(data.memberships).length<=50_000,'INVALID_ACCESS_STORE');
  check(Array.isArray(data.processed_webhook_ids)&&data.processed_webhook_ids.length<=1000&&
    data.processed_webhook_ids.every(id=>safeText(id,256))&&new Set(data.processed_webhook_ids).size===data.processed_webhook_ids.length,
    'INVALID_ACCESS_STORE');
  for(const [id,user] of Object.entries(data.users))check(validId(id)&&user&&Object.keys(user).length===10&&user.github_id===id&&safeText(user.login,128)&&
    nullableText(user.avatar_url,512)&&(user.billing_provider===null||PROVIDERS.has(user.billing_provider))&&nullableText(user.billing_customer_id,128)&&
    nullableText(user.billing_subscription_id,128)&&(user.subscription_status===null||SUBSCRIPTION.has(user.subscription_status))&&
    (user.plan_id===null||isPaidPlan(user.plan_id))&&(!['active','trialing'].includes(user.subscription_status)||isPaidPlan(user.plan_id))&&
    (user.current_period_end===null||(Number.isSafeInteger(user.current_period_end)&&user.current_period_end>=0))&&
    safeText(user.updated_at,32),
  'INVALID_ACCESS_STORE');
  for(const [id,request] of Object.entries(data.billing_requests))check(safeText(id,128)&&request&&Object.keys(request).length===9&&
    request.request_id===id&&validId(request.github_id)&&PROVIDERS.has(request.provider)&&Number.isSafeInteger(request.expected_price)&&
    request.expected_price>=0&&isPaidPlan(request.plan_id)&&nullableText(request.subscription_id,128)&&['pending','active','past_due','canceled'].includes(request.status)&&
    safeText(request.created_at,32)&&safeText(request.updated_at,32),'INVALID_ACCESS_STORE');
  for(const [id,organization] of Object.entries(data.organizations))check(validOrganizationId(id)&&organization&&Object.keys(organization).length===5&&
    organization.organization_id===id&&safeText(organization.name,128)&&safeText(organization.slug,128)&&
    /^github-[1-9][0-9]{0,31}$/.test(organization.slug)&&safeText(organization.created_at,32)&&safeText(organization.updated_at,32),'INVALID_ACCESS_STORE');
  for(const [id,membership] of Object.entries(data.memberships))check(membership&&Object.keys(membership).length===4&&
    id===`${membership.organization_id}:${membership.github_id}`&&validOrganizationId(membership.organization_id)&&validId(membership.github_id)&&
    data.organizations[membership.organization_id]&&data.users[membership.github_id]&&['owner','admin','member'].includes(membership.role)&&
    safeText(membership.created_at,32),'INVALID_ACCESS_STORE');
  return structuredClone(data);
}

export function createAccessStore(root) {
  check(isAbsolute(root)&&resolve(root)===root,'ACCESS_ROOT_MUST_BE_ABSOLUTE');
  const parent=lstatSync(dirname(root),{throwIfNoEntry:false});check(parent?.isDirectory()&&!parent.isSymbolicLink(),'UNSAFE_ACCESS_PARENT');
  const existing=lstatSync(root,{throwIfNoEntry:false});
  if(existing)check(existing.isDirectory()&&!existing.isSymbolicLink(),'UNSAFE_ACCESS_ROOT');else mkdirSync(root,{mode:0o700});
  const file=join(root,'access.json'),stored=lstatSync(file,{throwIfNoEntry:false});
  if(stored)check(stored.isFile()&&!stored.isSymbolicLink(),'UNSAFE_ACCESS_FILE');
  else writeFileSync(file,JSON.stringify(empty(),null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
  const raw=()=>{check(lstatSync(file).size<=8*1024*1024,'ACCESS_STORE_TOO_LARGE');return JSON.parse(readFileSync(file,'utf8'))};
  const save=data=>{data=validate(data);const temporary=join(root,`.access-${randomUUID()}.tmp`);
    writeFileSync(temporary,JSON.stringify(data,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});renameSync(temporary,file)};
  if(raw().schema_version!==4)save(migrate(raw()));
  const load=()=>validate(raw());let queue=Promise.resolve();
  const update=operation=>{const result=queue.then(()=>{const data=load(),value=operation(data);save(data);return value});queue=result.catch(()=>{});return result};
  return {
    user:id=>load().users[String(id)]??null,users:()=>Object.values(load().users).map(structuredClone),
    organizations:()=>Object.values(load().organizations).map(structuredClone),
    organizationsForUser(id){const data=load(),githubId=String(id);return Object.values(data.memberships).filter(value=>value.github_id===githubId)
      .map(value=>({...structuredClone(data.organizations[value.organization_id]),role:value.role})).sort((left,right)=>left.organization_id.localeCompare(right.organization_id))},
    billingRequest:id=>load().billing_requests[String(id)]??null,
    upsertIdentity(identity){return update(data=>{const id=String(identity.github_id),prior=data.users[id];check(validId(id)&&safeText(identity.login,128),'INVALID_GITHUB_IDENTITY');
      data.users[id]={github_id:id,login:identity.login,avatar_url:identity.avatar_url??null,billing_provider:prior?.billing_provider??null,
        billing_customer_id:prior?.billing_customer_id??null,billing_subscription_id:prior?.billing_subscription_id??null,
        subscription_status:prior?.subscription_status??null,current_period_end:prior?.current_period_end??null,updated_at:new Date().toISOString(),
        plan_id:prior?.plan_id??null};
      const organization_id=`org-${id}`,membership_id=`${organization_id}:${id}`;if(!data.organizations[organization_id]){
        const now=data.users[id].updated_at;data.organizations[organization_id]={organization_id,name:`${identity.login} Workspace`,slug:`github-${id}`,created_at:now,updated_at:now}}
      if(!data.memberships[membership_id])data.memberships[membership_id]={organization_id,github_id:id,role:'owner',created_at:data.users[id].updated_at};
      return structuredClone(data.users[id])})},
    createBillingRequest(request){return update(data=>{check(safeText(request.request_id,128)&&validId(String(request.github_id))&&
      PROVIDERS.has(request.provider)&&Number.isSafeInteger(request.expected_price)&&request.expected_price>=0&&isPaidPlan(request.plan_id)&&
      data.users[String(request.github_id)]&&
      !data.billing_requests[request.request_id],'INVALID_BILLING_REQUEST');const now=new Date().toISOString();
      data.billing_requests[request.request_id]={request_id:request.request_id,github_id:String(request.github_id),provider:request.provider,
        expected_price:request.expected_price,plan_id:request.plan_id,subscription_id:null,status:'pending',created_at:now,updated_at:now};
      return structuredClone(data.billing_requests[request.request_id])})},
    attachBillingSubscription({request_id,subscription_id}){return update(data=>{const request=data.billing_requests[request_id];
      check(request&&safeText(subscription_id,128)&&(request.subscription_id===null||request.subscription_id===subscription_id),'INVALID_BILLING_REQUEST');
      request.subscription_id=subscription_id;request.updated_at=new Date().toISOString();return structuredClone(request)})},
    applySubscription({event_id,provider,github_id,customer_id,subscription_id,status,current_period_end,plan_id,request_id=null}){return update(data=>{
      check(safeText(event_id,256)&&PROVIDERS.has(provider)&&validId(String(github_id))&&nullableText(customer_id,128)&&safeText(subscription_id,128)&&
        SUBSCRIPTION.has(status)&&isPaidPlan(plan_id)&&(current_period_end===null||(Number.isSafeInteger(current_period_end)&&current_period_end>=0)),
      'INVALID_SUBSCRIPTION_EVENT');
      if(data.processed_webhook_ids.includes(event_id))return {changed:false};const user=data.users[String(github_id)];check(user,'UNKNOWN_SUBSCRIPTION_USER');
      if(request_id!==null){const request=data.billing_requests[request_id];check(request&&request.github_id===String(github_id)&&request.provider===provider&&
        request.plan_id===plan_id&&(request.subscription_id===null||request.subscription_id===subscription_id),'INVALID_BILLING_REQUEST');request.subscription_id=subscription_id;
        request.status=status;request.updated_at=new Date().toISOString()}
      user.billing_provider=provider;user.billing_customer_id=customer_id;user.billing_subscription_id=subscription_id;
      user.subscription_status=status;user.current_period_end=current_period_end;user.plan_id=plan_id;user.updated_at=new Date().toISOString();
      data.processed_webhook_ids.push(event_id);data.processed_webhook_ids=data.processed_webhook_ids.slice(-1000);return {changed:true}})},
    entitlement(id){const user=load().users[String(id)];return subscriptionEntitlement({status:user?.subscription_status??'none',
      plan_id:user?.plan_id??null,current_period_end:user?.current_period_end??null})}
  };
}
