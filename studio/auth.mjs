import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const token=bytes=>randomBytes(bytes).toString('base64url');
const equal=(left,right)=>{const a=Buffer.from(left??''),b=Buffer.from(right??'');return a.length===b.length && timingSafeEqual(a,b)};
const cookieValue=(request,name)=>String(request.headers.cookie??'').split(';').map(value=>value.trim().split('='))
  .find(([key])=>key===name)?.[1]??null;

export function createAuth({clientId,clientSecret,origin,store,adminIds=[],fetchImpl=fetch,now=Date.now}={}) {
  const configured=Boolean(clientId && clientSecret && origin && store),flows=new Map(),sessions=new Map();
  const secure=origin?.startsWith('https://')??false;
  const cookie=(value,maxAge)=>`eoduksini_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`;
  const begin=()=>{
    if(!configured) throw new Error('AUTH_NOT_CONFIGURED');
    for(const [key,value] of flows) if(value.expires_at<=now()) flows.delete(key);
    if(flows.size>=1024) throw new Error('TOO_MANY_OAUTH_FLOWS');
    const state=token(32),verifier=token(48),challenge=createHash('sha256').update(verifier).digest('base64url');
    flows.set(state,{verifier,expires_at:now()+10*60_000});
    const url=new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id',clientId);url.searchParams.set('redirect_uri',origin+'/auth/github/callback');
    url.searchParams.set('state',state);url.searchParams.set('code_challenge',challenge);url.searchParams.set('code_challenge_method','S256');
    return url.href;
  };
  const complete=async({code,state})=>{
    const flow=flows.get(state);flows.delete(state);
    if(!flow || flow.expires_at<=now() || typeof code!=='string' || code.length>256) throw new Error('INVALID_OAUTH_CALLBACK');
    const exchange=await fetchImpl('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},
      body:JSON.stringify({client_id:clientId,client_secret:clientSecret,code,redirect_uri:origin+'/auth/github/callback',code_verifier:flow.verifier})});
    if(!exchange.ok) throw new Error('GITHUB_TOKEN_EXCHANGE_FAILED');const grant=await exchange.json();
    if(typeof grant.access_token!=='string') throw new Error('GITHUB_TOKEN_EXCHANGE_FAILED');
    const profileResponse=await fetchImpl('https://api.github.com/user',{headers:{Accept:'application/vnd.github+json',
      Authorization:`Bearer ${grant.access_token}`,'X-GitHub-Api-Version':'2022-11-28'}});
    if(!profileResponse.ok) throw new Error('GITHUB_IDENTITY_FAILED');const profile=await profileResponse.json();
    const user=await store.upsertIdentity({github_id:String(profile.id),login:profile.login,avatar_url:profile.avatar_url??null});
    for(const [key,value] of sessions) if(value.expires_at<=now()) sessions.delete(key);
    if(sessions.size>=4096) throw new Error('TOO_MANY_SESSIONS');
    const id=token(32);sessions.set(id,{github_id:user.github_id,expires_at:now()+8*60*60_000});
    return {cookie:cookie(id,8*60*60),user};
  };
  const session=request=>{
    const id=cookieValue(request,'eoduksini_session'),record=id?sessions.get(id):null;
    if(!record || record.expires_at<=now()) {if(id) sessions.delete(id);return null;}
    const user=store.user(record.github_id);if(!user) return null;
    const entitlement=store.entitlement(record.github_id),admin=adminIds.some(id=>equal(String(id),user.github_id));
    return {user:{github_id:user.github_id,login:user.login,avatar_url:user.avatar_url},entitlement,admin};
  };
  const logout=request=>{const id=cookieValue(request,'eoduksini_session');if(id) sessions.delete(id);return cookie('',0)};
  return {configured,begin,complete,session,logout};
}
