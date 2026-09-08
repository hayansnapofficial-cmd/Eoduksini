import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isPaidPlan, publicPlanCatalog } from './plans.mjs';

const API_URL='https://api.payapp.kr/oapi/apiLoad.html';
const ACTIVE_STATE='4',CANCELED_STATES=new Set(['8','9','16','31','32','64']),HOLD_STATES=new Set(['70','71','99']);
const safeEqual=(left,right)=>{const a=Buffer.from(String(left??'')),b=Buffer.from(String(right??''));return a.length===b.length&&timingSafeEqual(a,b)};
const validPhone=value=>typeof value==='string'&&/^01(?:0|1|[6-9])[0-9]{7,8}$/.test(value.replace(/[^0-9]/g,''));
const validDate=value=>typeof value==='string'&&/^20[0-9]{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/.test(value);
const validPayUrl=value=>{try{const url=new URL(value);return url.protocol==='https:'&&(url.hostname==='payapp.kr'||url.hostname.endsWith('.payapp.kr'))}catch{return false}};
const parseForm=text=>{const out={};for(const [key,value] of new URLSearchParams(text)){if(Object.hasOwn(out,key))throw new Error('DUPLICATE_PAYAPP_FIELD');out[key]=value}return out};

export function createBilling({userId,linkKey,linkValue,priceKrwByPlan={},planName='Eoduksini Studio',cycleDay='90',expiresOn,
  origin,store,fetchImpl=fetch,requestId=()=>randomUUID()}={}) {
  const prices=new Map(Object.entries(priceKrwByPlan).filter(([id])=>isPaidPlan(id)).map(([id,value])=>[id,Number(value)])
    .filter(([,value])=>Number.isSafeInteger(value)&&value>=1000));
  const commonConfigured=Boolean(userId&&linkKey&&linkValue&&typeof planName==='string'&&planName.length>0&&planName.length<=112&&
    /^(?:[1-9]|[12][0-9]|3[01]|90)$/.test(String(cycleDay))&&validDate(expiresOn)&&typeof origin==='string'&&
    origin.startsWith('https://')&&store),configured=commonConfigured&&prices.size>0;
  const plans=publicPlanCatalog.map(plan=>({...plan,billing:{provider:'payapp',currency:'KRW',amount:prices.get(plan.id)??null,
    available:commonConfigured&&prices.has(plan.id)}}));
  const checkout=async(session,{phone,plan_id}={})=>{
    if(!configured)throw new Error('BILLING_NOT_CONFIGURED');
    if(session.admin||session.entitlement?.unlimited||store.entitlement(session.user.github_id).active)throw new Error('SUBSCRIPTION_ALREADY_ACTIVE');
    if(!isPaidPlan(plan_id)||!prices.has(plan_id))throw new Error('INVALID_PLAN');
    if(!validPhone(phone))throw new Error('INVALID_PHONE');const price=prices.get(plan_id),plan=publicPlanCatalog.find(value=>value.id===plan_id);
    const id=requestId(),githubId=String(session.user.github_id);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new Error('INVALID_BILLING_REQUEST_ID');
    await store.createBillingRequest({request_id:id,github_id:githubId,provider:'payapp',expected_price:price,plan_id});
    const payload=new URLSearchParams({cmd:'rebillRegist',userid:userId,goodname:`${planName} ${plan.name}`,goodprice:String(price),
      recvphone:phone.replace(/[^0-9]/g,''),rebillCycleType:'Month',rebillCycleMonth:String(cycleDay),rebillExpire:expiresOn,
      feedbackurl:origin+'/api/payapp/feedback',failurl:origin+'/api/payapp/feedback',returnurl:origin+'/account?checkout=return',
      var1:githubId,var2:id,smsuse:'n',openpaytype:'card'});
    const response=await fetchImpl(API_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},
      body:payload,signal:AbortSignal.timeout(10_000)});
    if(!response.ok)throw new Error('PAYAPP_REQUEST_FAILED');
    const result=parseForm(await response.text());
    if(result.state!=='1'||!/^\d+$/.test(result.rebill_no??'')||!validPayUrl(result.payurl))throw new Error('PAYAPP_REQUEST_FAILED');
    await store.attachBillingSubscription({request_id:id,subscription_id:result.rebill_no});
    return result.payurl;
  };
  const feedback=async payload=>{
    if(!commonConfigured)throw new Error('BILLING_NOT_CONFIGURED');
    const value=parseForm(payload.toString('utf8')),state=String(value.pay_state??'');
    if(!safeEqual(value.userid,userId)||!safeEqual(value.linkkey,linkKey)||!safeEqual(value.linkval,linkValue)||
      !/^\d+$/.test(value.price??'')||!/^\d+$/.test(value.var1??'')||!/^[0-9a-f-]{36}$/i.test(value.var2??'')||
      !/^\d+$/.test(value.mul_no??'')||!/^\d+$/.test(value.rebill_no??''))throw new Error('INVALID_PAYAPP_FEEDBACK');
    const request=store.billingRequest(value.var2);
    if(!request||request.provider!=='payapp'||request.github_id!==value.var1||String(request.expected_price)!==value.price||
      (request.subscription_id!==null&&request.subscription_id!==value.rebill_no))throw new Error('INVALID_PAYAPP_FEEDBACK');
    const status=state===ACTIVE_STATE?'active':HOLD_STATES.has(state)?'past_due':CANCELED_STATES.has(state)?'canceled':null;
    if(status!==null)await store.applySubscription({event_id:`payapp:${value.mul_no}:${state}:${value.rebill_no}:${value.var2}`,
      provider:'payapp',github_id:value.var1,customer_id:userId,subscription_id:value.rebill_no,status,current_period_end:null,
      plan_id:request.plan_id,request_id:value.var2});
    return {handled:status!==null};
  };
  return {configured,checkout,feedback,plans};
}
