import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioSnapshot, unconfiguredSnapshot } from './snapshot.mjs';

const assets=new Map([
  ['/',{file:'./public/index.html',type:'text/html; charset=utf-8'}],
  ['/index.html',{file:'./public/index.html',type:'text/html; charset=utf-8'}],
  ['/app.js',{file:'./public/app.js',type:'text/javascript; charset=utf-8'}],
  ['/styles.css',{file:'./public/styles.css',type:'text/css; charset=utf-8'}]
].map(([path,value])=>[path,{...value,body:readFileSync(new URL(value.file,import.meta.url))}]));
const securityHeaders={
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin','Cache-Control':'no-store'
};
const json=value=>Buffer.from(JSON.stringify(value));
const send=(response,status,body,type='application/json; charset=utf-8',head=false)=>{
  response.writeHead(status,{...securityHeaders,'Content-Type':type,'Content-Length':body.length});response.end(head?undefined:body);
};
const failure=(status,code)=>json({schema_version:1,status:'ERROR',code});

export function createStudioServer({stateRoot=null,snapshot=studioSnapshot}={}) {
  if(stateRoot!==null && (!isAbsolute(stateRoot) || resolve(stateRoot)!==stateRoot)) throw new Error('STATE_ROOT_MUST_BE_ABSOLUTE');
  const server=createServer((request,response)=>{
    const head=request.method==='HEAD';
    if(!['GET','HEAD'].includes(request.method)) {send(response,405,failure(405,'METHOD_NOT_ALLOWED'));return;}
    let pathname;
    try {pathname=new URL(request.url,'http://127.0.0.1').pathname;} catch {send(response,400,failure(400,'INVALID_REQUEST'));return;}
    if(pathname==='/api/health') {send(response,200,json({schema_version:1,status:'OK',configured:stateRoot!==null}),undefined,head);return;}
    if(pathname==='/api/snapshot') {
      try {send(response,200,json(stateRoot===null?unconfiguredSnapshot():snapshot(stateRoot)),undefined,head);}
      catch {send(response,503,failure(503,'CONTROLLER_STATE_UNAVAILABLE'),undefined,head);}
      return;
    }
    const asset=assets.get(pathname);
    if(!asset) {send(response,404,failure(404,'NOT_FOUND'),undefined,head);return;}
    send(response,200,asset.body,asset.type,head);
  });
  server.requestTimeout=10_000;server.headersTimeout=5_000;server.keepAliveTimeout=5_000;server.maxHeadersCount=64;
  return server;
}

function argumentsFrom(argv) {
  let stateRoot=null,port=4317;
  for(let index=0;index<argv.length;index+=2) {
    const key=argv[index],value=argv[index+1];
    if(value===undefined) throw new Error('MISSING_ARGUMENT_VALUE');
    if(key==='--state-root') {if(!isAbsolute(value)) throw new Error('STATE_ROOT_MUST_BE_ABSOLUTE');stateRoot=resolve(value);}
    else if(key==='--port') {port=Number(value);if(!Number.isSafeInteger(port) || port<1024 || port>65535) throw new Error('INVALID_PORT');}
    else throw new Error('UNKNOWN_ARGUMENT');
  }
  return {stateRoot,port};
}

export function startStudio(argv=process.argv.slice(2)) {
  const {stateRoot,port}=argumentsFrom(argv),server=createStudioServer({stateRoot});
  server.listen(port,'127.0.0.1',()=>console.log(`Eoduksini Studio: http://127.0.0.1:${port}`));
  return server;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) startStudio();
