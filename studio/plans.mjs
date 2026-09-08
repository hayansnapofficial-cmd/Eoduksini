const FEATURES=Object.freeze({
  core:Object.freeze({studio:true,controller:true,execution_ledger:true,semantic_fence:true,
    advanced_metering:false,economics:false,review_and_adoption:false}),
  pro:Object.freeze({studio:true,controller:true,execution_ledger:true,semantic_fence:true,
    advanced_metering:true,economics:true,review_and_adoption:true}),
  admin:Object.freeze({studio:true,controller:true,execution_ledger:true,semantic_fence:true,
    advanced_metering:true,economics:true,review_and_adoption:true})
});

export const PAID_PLAN_IDS=Object.freeze(['core','pro']);
export const isPaidPlan=value=>PAID_PLAN_IDS.includes(value);
export const planFeatures=planId=>FEATURES[planId]??Object.freeze({});

export const publicPlanCatalog=Object.freeze([
  Object.freeze({id:'core',name:'Core',price_usd:30,features:Object.freeze([
    'Controller 상태와 실행 원장','Semantic 충돌·불확실성','읽기 전용 Studio'
  ])}),
  Object.freeze({id:'pro',name:'Pro',price_usd:50,features:Object.freeze([
    'Core의 모든 기능','토큰·CPU·RAM 고급 계측','비용·전력·검수·채택 리포트'
  ])})
]);

export function adminEntitlement() {
  return {active:true,status:'admin',plan_id:'admin',plan_name:'Administrator',current_period_end:null,
    unlimited:true,features:FEATURES.admin};
}

export function subscriptionEntitlement({status='none',plan_id=null,current_period_end=null}={}) {
  const active=['active','trialing'].includes(status)&&isPaidPlan(plan_id);
  return {active,status,plan_id:active?plan_id:null,plan_name:active?(plan_id==='pro'?'Pro':'Core'):null,
    current_period_end,unlimited:false,features:active?FEATURES[plan_id]:{}};
}
