import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioSnapshot, unconfiguredSnapshot } from './snapshot.mjs';
import { createAccessStore } from './access-store.mjs';
import { createAuth } from './auth.mjs';
import { createBilling } from './billing.mjs';

const asset=(file,type='text/html; charset=utf-8')=>({body:readFileSync(new URL('./public/'+file,import.meta.url)),type});
const publicAssets=new Map([['/',asset('home.html')],['/home.js',asset('home.js','text/javascript; charset=utf-8')],
  ['/styles.css',asset('styles.css','text/css; charset=utf-8')]]);
const protectedAssets=new Map([['/studio',asset('index.html')],['/app.js',asset('app.js','text/javascript; charset=utf-8')],
  ['/account',asset('account.html')],['/account.js',asset('account.js','text/javascript; charset=utf-8')]]);
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
const safeSession=value=>value?{authenticated:true,user:value.user,subscription:value.entitlement,admin:value.admin}:
  {authenticated:false,user:null,subscription:{active:false,status:'none',current_period_end:null},admin:false};
const body=async(request,limit)=>{const chunks=[];let length=0;for await(const chunk of request){length+=chunk.length;if(length>limit)throw new Error('BODY_TOO_LARGE');chunks.push(chunk)}return Buffer.concat(chunks)};
const denied=(request,response,code)=>request.url.startsWith('/api/')?send(response,code==='ADMIN_REQUIRED'?403:401,failure(code)):
  redirect(response,'/?access='+encodeURIComponent(code));

export function createStudioServer({stateRoot=null,snapshot=studioSnapshot,auth=null,billing=null,store=null,origin='http://127.0.0.1:4317'}={}) {
  if(stateRoot!==null && (!isAbsolute(stateRoot) || resolve(stateRoot)!==stateRoot)) throw new Error('STATE_ROOT_MUST_BE_ABSOLUTE');
  auth??={configured:false,session:()=>null,begin:()=>{throw new Error('AUTH_NOT_CONFIGURED')},logout:()=>'',complete:async()=>{throw new Error('AUTH_NOT_CONFIGURED')}};
  billing??={configured:false,checkout:async()=>{throw new Error('BILLING_NOT_CONFIGURED')},portal:async()=>{throw new Error('BILLING_NOT_CONFIGURED')},webhook:async()=>({handled:false})};
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
    if(pathname==='/auth/github' && request.method==='GET') {try{redirect(response,auth.begin())}catch{redirect(response,'/?error=auth_not_configured')}return}
    if(pathname==='/auth/github/callback' && request.method==='GET') {
      try {const result=await auth.complete({code:url.searchParams.get('code'),state:url.searchParams.get('state')});
        redirect(response,'/account',{'Set-Cookie':result.cookie})} catch {redirect(response,'/?error=login_failed')}return;
    }
    if(pathname==='/api/stripe/webhook' && request.method==='POST') {
      try {const payload=await body(request,1024*1024);await billing.webhook(payload,request.headers['stripe-signature']);send(response,200,json({received:true}))}
      catch {send(response,400,failure('INVALID_WEBHOOK'))}return;
    }
    if(publicAssets.has(pathname) && ['GET','HEAD'].includes(request.method)) {const value=publicAssets.get(pathname);send(response,200,value.body,value.type,head);return}
    const needsSession=protectedAssets.has(pathname)||adminAssets.has(pathname)||['/api/snapshot','/api/checkout','/api/portal','/api/logout','/api/admin/summary'].includes(pathname);
    if(needsSession && !session) {denied(request,response,'LOGIN_REQUIRED');return}
    if((adminAssets.has(pathname)||pathname==='/api/admin/summary') && !session.admin) {denied(request,response,'ADMIN_REQUIRED');return}
    if((pathname==='/studio'||pathname==='/app.js'||pathname==='/api/snapshot') && !session.entitlement.active) {denied(request,response,'SUBSCRIPTION_REQUIRED');return}
    if(request.method==='POST' && pathname!=='/api/stripe/webhook') {
      if(request.headers.origin!==origin || request.headers['x-eoduksini-request']!=='1') {send(response,403,failure('REQUEST_ORIGIN_REJECTED'));return}
    }
    if(pathname==='/api/logout' && request.method==='POST') {send(response,200,json({url:'/'}),undefined,false,{'Set-Cookie':auth.logout(request)});return}
    if(pathname==='/api/checkout' && request.method==='POST') {try{send(response,200,json({url:await billing.checkout(session)}))}catch{send(response,503,failure('CHECKOUT_UNAVAILABLE'))}return}
    if(pathname==='/api/portal' && request.method==='POST') {try{send(response,200,json({url:await billing.portal(session)}))}catch{send(response,503,failure('PORTAL_UNAVAILABLE'))}return}
    if(pathname==='/api/snapshot' && ['GET','HEAD'].includes(request.method)) {try{send(response,200,json(stateRoot===null?unconfiguredSnapshot():snapshot(stateRoot)),undefined,head)}catch{send(response,503,failure('CONTROLLER_STATE_UNAVAILABLE'),undefined,head)}return}
    if(pathname==='/api/admin/summary' && ['GET','HEAD'].includes(request.method)) {
      const users=store?.users?.()??[],active=users.filter(user=>['active','trialing'].includes(user.subscription_status)).length;
      send(response,200,json({schema_version:1,total_users:users.length,active_subscriptions:active,
        subscription_counts:users.reduce((out,user)=>{const key=user.subscription_status??'none';out[key]=(out[key]??0)+1;return out},{})}),undefined,head);return;
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
  const billing=createBilling({secretKey:environment.EODUKSINI_STRIPE_SECRET_KEY,webhookSecret:environment.EODUKSINI_STRIPE_WEBHOOK_SECRET,
    priceId:environment.EODUKSINI_STRIPE_PRICE_ID,origin,store});
  const server=createStudioServer({stateRoot,origin,auth,billing,store});server.listen(port,'127.0.0.1',()=>console.log(`Eoduksini Web: ${origin}`));return server;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) startStudio();
