import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioSnapshot, unconfiguredSnapshot } from './snapshot.mjs';
import { createAccessStore } from './access-store.mjs';
import { createAuth } from './auth.mjs';
import { createBilling } from './billing.mjs';
import { adminEntitlement, publicPlanCatalog, subscriptionEntitlement } from './plans.mjs';
import { providerCatalog } from './provider-catalog.mjs';

const asset=(file,type='text/html; charset=utf-8')=>({body:readFileSync(new URL('./public/'+file,import.meta.url)),type});
const publicAssets=new Map([['/',asset('home.html')],['/home.js',asset('home.js','text/javascript; charset=utf-8')],
  ['/styles.css',asset('styles.css','text/css; charset=utf-8')]]);
const protectedAssets=new Map([['/studio',asset('index.html')],['/app.js',asset('app.js','text/javascript; charset=utf-8')],
  ['/account',asset('account.html')],['/account.js',asset('account.js','text/javascript; charset=utf-8')],
  ['/account.css',asset('account.css','text/css; charset=utf-8')],['/settings',asset('settings.html')],
  ['/settings.js',asset('settings.js','text/javascript; charset=utf-8')],['/settings.css',asset('settings.css','text/css; charset=utf-8')]]);
const adminAssets=new Map([['/admin',asset('admin.html')],['/admin.js',asset('admin.js','text/javascript; charset=utf-8')]]);
const securityHeaders={
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin','Cache-Control':'no-store'
};
const json=value=>Buffer.from(JSON.stringify(value));
const send=(response,status,body,type='application/json; charset=utf-8',head=false,headers={})=>{
  response.writeHead(status,{...securityHeaders,...headers,'Content-Type':type,'Content-Length':body.length});response.end(head?undefined:body);
};
const failure=code=>json({schema_version:1,status:'ERROR',code});
const redirect=(response,location,headers={})=>{response.writeHead(303,{...securityHeaders,...headers,Location:location,'Content-Length':0});response.end()};
const safeSession=value=>value?{authenticated:true,user:value.user,organization:value.organization,organizations:value.organizations,
  subscription:value.entitlement,admin:value.admin}:
  {authenticated:false,user:null,organization:null,organizations:[],subscription:subscriptionEntitlement(),admin:false};
const body=async(request,limit)=>{const chunks=[];let length=0;for await(const chunk of request){length+=chunk.length;if(length>limit)throw new Error('BODY_TOO_LARGE');chunks.push(chunk)}return Buffer.concat(chunks)};
const jsonBody=async(request,limit=4096)=>{if(String(request.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')
  throw new Error('INVALID_CONTENT_TYPE');return JSON.parse((await body(request,limit)).toString('utf8'))};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const denied=(request,response,code)=>request.url.startsWith('/api/')?send(response,code==='ADMIN_REQUIRED'?403:401,failure(code)):
  redirect(response,'/?access='+encodeURIComponent(code));
const SUBSCRIPTION_FILTERS=new Set(['all','none','active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused']);
const customerPage=(users,url,isAdminId=()=>false,organizationsForUser=()=>[])=>{
  const q=(url.searchParams.get('q')??'').trim().toLocaleLowerCase('en-US'),status=url.searchParams.get('status')??'all';
  const limit=Number(url.searchParams.get('limit')??50),offset=Number(url.searchParams.get('offset')??0);
  if(q.length>128||!SUBSCRIPTION_FILTERS.has(status)||!Number.isSafeInteger(limit)||limit<1||limit>100||
    !Number.isSafeInteger(offset)||offset<0||offset>10_000)throw new Error('INVALID_CUSTOMER_QUERY');
  const filtered=users.filter(user=>{
    const subscription=user.subscription_status??'none';
    return (status==='all'||subscription===status)&&(!q||user.login.toLocaleLowerCase('en-US').includes(q)||user.github_id.includes(q));
  }).sort((left,right)=>right.updated_at.localeCompare(left.updated_at)||left.github_id.localeCompare(right.github_id));
  return {schema_version:2,total:filtered.length,offset,limit,customers:filtered.slice(offset,offset+limit).map(user=>({
    github_id:user.github_id,login:user.login,avatar_url:user.avatar_url,billing_provider:user.billing_provider,
    role:isAdminId(user.github_id)?'admin':'customer',subscription:isAdminId(user.github_id)?adminEntitlement():subscriptionEntitlement({
      status:user.subscription_status??'none',plan_id:user.plan_id??null,current_period_end:user.current_period_end}),
    organizations:organizationsForUser(user.github_id).map(value=>({organization_id:value.organization_id,name:value.name,role:value.role})),
    updated_at:user.updated_at}))};
};
const projectSnapshot=(value,entitlement)=>{
  const features=entitlement.features??{};if(features.advanced_metering&&features.economics&&features.review_and_adoption)
    return {...value,access:{plan_id:entitlement.plan_id,unlimited:entitlement.unlimited},capabilities:features};
  return {...value,access:{plan_id:entitlement.plan_id,unlimited:entitlement.unlimited},capabilities:features,
    totals:{...value.totals,observed_input_tokens:null,observed_output_tokens:null},economics:null,
    attempts:value.attempts.map(attempt=>({...attempt,metering:attempt.metering?{execution_duration_ms:attempt.metering.execution_duration_ms}:null}))};
};

export function createStudioServer({stateRoot=null,snapshot=studioSnapshot,auth=null,billing=null,store=null,origin='http://127.0.0.1:4317'}={}) {
  if(stateRoot!==null && (!isAbsolute(stateRoot) || resolve(stateRoot)!==stateRoot)) throw new Error('STATE_ROOT_MUST_BE_ABSOLUTE');
  auth??={configured:false,session:()=>null,begin:()=>{throw new Error('AUTH_NOT_CONFIGURED')},logout:()=>'',complete:async()=>{throw new Error('AUTH_NOT_CONFIGURED')}};
  billing??={configured:false,checkout:async()=>{throw new Error('BILLING_NOT_CONFIGURED')},feedback:async()=>({handled:false})};
  const handler=async(request,response)=>{
    const head=request.method==='HEAD';let url;
    try {url=new URL(request.url,origin)} catch {send(response,400,failure('INVALID_REQUEST'));return}
    const pathname=url.pathname,session=auth.session(request);
    if(pathname==='/api/health' && ['GET','HEAD'].includes(request.method)) {
      send(response,200,json({schema_version:1,status:'OK',controller_configured:stateRoot!==null,auth_configured:auth.configured,
        billing_configured:billing.configured}),undefined,head);return;
    }
    if(pathname==='/api/session' && ['GET','HEAD'].includes(request.method)) {send(response,200,json({schema_version:1,...safeSession(session),
      auth_configured:auth.configured,billing_configured:billing.configured}),undefined,head);return}
    if(pathname==='/api/plans' && ['GET','HEAD'].includes(request.method)) {send(response,200,json({schema_version:1,
      plans:billing.plans??publicPlanCatalog.map(plan=>({...plan,billing:{provider:'payapp',currency:'KRW',amount:null,available:false}}))}),undefined,head);return}
    if(pathname==='/api/provider-catalog' && ['GET','HEAD'].includes(request.method)) {send(response,200,json({schema_version:1,providers:providerCatalog}),undefined,head);return}
    if(pathname==='/auth/github' && request.method==='GET') {try{redirect(response,auth.begin())}catch{redirect(response,'/?error=auth_not_configured')}return}
    if(pathname==='/auth/github/callback' && request.method==='GET') {
      try {const result=await auth.complete({code:url.searchParams.get('code'),state:url.searchParams.get('state')});
        redirect(response,'/account',{'Set-Cookie':result.cookie})} catch {redirect(response,'/?error=login_failed')}return;
    }
    if(pathname==='/api/payapp/feedback' && request.method==='POST') {
      try {if(String(request.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/x-www-form-urlencoded')throw new Error('INVALID_CONTENT_TYPE');
        const payload=await body(request,64*1024);await billing.feedback(payload);send(response,200,Buffer.from('SUCCESS'),'text/plain; charset=utf-8')}
      catch {send(response,400,failure('INVALID_PAYMENT_FEEDBACK'))}return;
    }
    if(publicAssets.has(pathname) && ['GET','HEAD'].includes(request.method)) {const value=publicAssets.get(pathname);send(response,200,value.body,value.type,head);return}
    const needsSession=protectedAssets.has(pathname)||adminAssets.has(pathname)||
      ['/api/snapshot','/api/organization','/api/checkout','/api/logout','/api/admin/summary','/api/admin/customers'].includes(pathname);
    const registryApi=['/api/organization/providers','/api/organization/models'].includes(pathname);
    if((needsSession||registryApi) && !session) {denied(request,response,'LOGIN_REQUIRED');return}
    if((adminAssets.has(pathname)||pathname.startsWith('/api/admin/')) && !session.admin) {denied(request,response,'ADMIN_REQUIRED');return}
    if((pathname==='/studio'||pathname==='/app.js'||pathname==='/settings'||pathname==='/settings.js'||pathname==='/settings.css'||pathname==='/api/snapshot'||registryApi) && !session.entitlement.active) {denied(request,response,'SUBSCRIPTION_REQUIRED');return}
    if(request.method==='POST' && pathname!=='/api/payapp/feedback') {
      if(request.headers.origin!==origin || request.headers['x-eoduksini-request']!=='1') {send(response,403,failure('REQUEST_ORIGIN_REJECTED'));return}
    }
    if(pathname==='/api/logout' && request.method==='POST') {send(response,200,json({url:'/'}),undefined,false,{'Set-Cookie':auth.logout(request)});return}
    if(pathname==='/api/organization' && ['GET','HEAD'].includes(request.method)) {send(response,200,json({schema_version:1,
      organization:session.organization,organizations:session.organizations}),undefined,head);return}
    if(pathname==='/api/organization/providers' && ['GET','HEAD'].includes(request.method)) {send(response,200,json({schema_version:1,
      connections:store.providerConnections(session.organization.organization_id)}),undefined,head);return}
    if(pathname==='/api/organization/models' && ['GET','HEAD'].includes(request.method)) {send(response,200,json({schema_version:1,
      models:store.models(session.organization.organization_id)}),undefined,head);return}
    if(pathname==='/api/organization/providers' && request.method==='POST') {if(!['owner','admin'].includes(session.organization.role)){send(response,403,failure('ORGANIZATION_ADMIN_REQUIRED'));return}
      try{const payload=await jsonBody(request);if(!exact(payload,['provider_id','display_name']))throw new Error('INVALID_PROVIDER_CONNECTION');
        send(response,200,json({schema_version:1,...await store.createProviderConnection({organization_id:session.organization.organization_id,...payload})}))}
      catch(error){const code=['INVALID_PROVIDER_CONNECTION','INVALID_CONTENT_TYPE','BODY_TOO_LARGE'].includes(error?.message)?error.message:'INVALID_PROVIDER_CONNECTION';send(response,400,failure(code))}return}
    if(pathname==='/api/organization/models' && request.method==='POST') {if(!['owner','admin'].includes(session.organization.role)){send(response,403,failure('ORGANIZATION_ADMIN_REQUIRED'));return}
      try{const payload=await jsonBody(request);if(!exact(payload,['connection_id','provider_model_id','display_name','role_capabilities']))throw new Error('INVALID_MODEL');
        send(response,200,json({schema_version:1,...await store.createModel({organization_id:session.organization.organization_id,...payload})}))}
      catch(error){const known=['INVALID_MODEL','MODEL_ALREADY_EXISTS','INVALID_CONTENT_TYPE','BODY_TOO_LARGE'],code=known.includes(error?.message)?error.message:'INVALID_MODEL';
        send(response,error?.message==='MODEL_ALREADY_EXISTS'?409:400,failure(code))}return}
    if(pathname==='/api/checkout' && request.method==='POST') {try{if(String(request.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')throw new Error('INVALID_CONTENT_TYPE');
      const payload=JSON.parse((await body(request,1024)).toString('utf8'));send(response,200,json({url:await billing.checkout(session,payload)}))}
      catch(error){const known={INVALID_PHONE:400,INVALID_PLAN:400,SUBSCRIPTION_ALREADY_ACTIVE:409},code=Object.hasOwn(known,error?.message)?error.message:'CHECKOUT_UNAVAILABLE';
        send(response,known[code]??503,failure(code))}return}
    if(pathname==='/api/snapshot' && ['GET','HEAD'].includes(request.method)) {try{const value=stateRoot===null?unconfiguredSnapshot():snapshot(stateRoot);
      send(response,200,json(projectSnapshot(value,session.entitlement)),undefined,head)}catch{send(response,503,failure('CONTROLLER_STATE_UNAVAILABLE'),undefined,head)}return}
    if(pathname==='/api/admin/summary' && ['GET','HEAD'].includes(request.method)) {
      const users=store?.users?.()??[],active=users.filter(user=>['active','trialing'].includes(user.subscription_status)).length,
        admins=users.filter(user=>auth.isAdminId?.(user.github_id)).length;
      send(response,200,json({schema_version:3,total_users:users.length,total_organizations:store?.organizations?.().length??0,
        active_subscriptions:active,admin_accounts:admins,
        plan_counts:users.reduce((out,user)=>{if(['active','trialing'].includes(user.subscription_status)&&user.plan_id)out[user.plan_id]=(out[user.plan_id]??0)+1;return out},{}),
        subscription_counts:users.reduce((out,user)=>{const key=user.subscription_status??'none';out[key]=(out[key]??0)+1;return out},{})}),undefined,head);return;
    }
    if(pathname==='/api/admin/customers' && ['GET','HEAD'].includes(request.method)) {
      try {send(response,200,json(customerPage(store?.users?.()??[],url,auth.isAdminId,store?.organizationsForUser)),undefined,head)}
      catch {send(response,400,failure('INVALID_CUSTOMER_QUERY'),undefined,head)}return;
    }
    const value=protectedAssets.get(pathname)??adminAssets.get(pathname);
    if(value && ['GET','HEAD'].includes(request.method)) {send(response,200,value.body,value.type,head);return}
    send(response,request.method==='GET'||request.method==='HEAD'?404:405,failure(request.method==='GET'||request.method==='HEAD'?'NOT_FOUND':'METHOD_NOT_ALLOWED'));
  };
  const server=createServer((request,response)=>handler(request,response).catch(()=>{if(!response.headersSent)send(response,500,failure('INTERNAL_ERROR'));else response.destroy()}));
  server.requestTimeout=15_000;server.headersTimeout=5_000;server.keepAliveTimeout=5_000;server.maxHeadersCount=64;return server;
}

function argumentsFrom(argv) {
  let stateRoot=null,accessRoot=null,port=4317;
  for(let index=0;index<argv.length;index+=2) {const key=argv[index],value=argv[index+1];if(value===undefined)throw new Error('MISSING_ARGUMENT_VALUE');
    if(key==='--state-root'){if(!isAbsolute(value))throw new Error('STATE_ROOT_MUST_BE_ABSOLUTE');stateRoot=resolve(value)}
    else if(key==='--access-root'){if(!isAbsolute(value))throw new Error('ACCESS_ROOT_MUST_BE_ABSOLUTE');accessRoot=resolve(value)}
    else if(key==='--port'){port=Number(value);if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('INVALID_PORT')}
    else throw new Error('UNKNOWN_ARGUMENT')}
  return {stateRoot,accessRoot,port};
}

export function startStudio(argv=process.argv.slice(2),environment=process.env) {
  const {stateRoot,accessRoot,port}=argumentsFrom(argv),origin=environment.EODUKSINI_PUBLIC_ORIGIN??`http://127.0.0.1:${port}`;
  const originUrl=new URL(origin);if(originUrl.origin!==origin || !['http:','https:'].includes(originUrl.protocol) ||
    (originUrl.protocol==='http:' && !['127.0.0.1','[::1]'].includes(originUrl.hostname))) throw new Error('INVALID_PUBLIC_ORIGIN');
  const store=accessRoot?createAccessStore(accessRoot):null;
  const auth=createAuth({clientId:environment.EODUKSINI_GITHUB_CLIENT_ID,clientSecret:environment.EODUKSINI_GITHUB_CLIENT_SECRET,
    origin,store,adminIds:(environment.EODUKSINI_ADMIN_GITHUB_IDS??'').split(',').map(value=>value.trim()).filter(Boolean)});
  const billing=createBilling({userId:environment.EODUKSINI_PAYAPP_USER_ID,linkKey:environment.EODUKSINI_PAYAPP_LINK_KEY,
    linkValue:environment.EODUKSINI_PAYAPP_LINK_VALUE,priceKrwByPlan:{core:environment.EODUKSINI_PAYAPP_CORE_PRICE_KRW,
      pro:environment.EODUKSINI_PAYAPP_PRO_PRICE_KRW},
    planName:environment.EODUKSINI_PAYAPP_PLAN_NAME,cycleDay:environment.EODUKSINI_PAYAPP_CYCLE_DAY,
    expiresOn:environment.EODUKSINI_PAYAPP_EXPIRES_ON,origin,store});
  const server=createStudioServer({stateRoot,origin,auth,billing,store});server.listen(port,'127.0.0.1',()=>console.log(`Eoduksini Web: ${origin}`));return server;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) startStudio();
