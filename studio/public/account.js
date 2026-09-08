const $=id=>document.getElementById(id),money=new Intl.NumberFormat('ko-KR'),features={
  core:['Controller 상태와 실행 원장','Semantic 충돌·불확실성','읽기 전용 Studio'],
  pro:['Core의 모든 기능','토큰·CPU·RAM 고급 계측','비용·전력·검수·채택 리포트'],
  admin:['모든 Pro 기능','결제 상태와 무관한 영구 접근','사용량 제한 없음']};
let selectedPlan='core',catalog=[];
async function post(path,payload){const response=await fetch(path,{method:'POST',headers:{'X-Eoduksini-Request':'1',...(payload?{'Content-Type':'application/json'}:{})},
  ...(payload?{body:JSON.stringify(payload)}:{})}),value=await response.json();if(!response.ok)throw new Error(value.code);if(value.url)location.assign(value.url)}
const featureList=values=>{const list=document.createElement('ul');for(const value of values){const item=document.createElement('li');item.textContent=value;list.append(item)}return list};
function selectPlan(id){selectedPlan=id;for(const button of document.querySelectorAll('.plan-select')){const selected=button.dataset.plan===id;
  button.setAttribute('aria-pressed',String(selected));button.closest('.plan-option').classList.toggle('selected',selected)}
  const plan=catalog.find(value=>value.id===id);$('subscribe').disabled=!plan?.billing.available;$('account-message').textContent=plan?.billing.available?'':
    'USD 기준 가격은 확정됐지만 PayApp 원화 청구액은 아직 설정되지 않았습니다.'}
function planCard(plan){const card=document.createElement('article'),top=document.createElement('div'),name=document.createElement('h4'),price=document.createElement('strong'),
  unit=document.createElement('span'),billing=document.createElement('small'),button=document.createElement('button');card.className='plan-option';name.textContent=plan.name;
  price.textContent=`$${plan.price_usd}`;unit.textContent='/월';top.className='plan-price';top.append(price,unit);billing.textContent=plan.billing.amount===null?
    'PayApp 원화 금액 설정 대기':`PayApp ${money.format(plan.billing.amount)}원/월`;button.type='button';button.className='plan-select';button.dataset.plan=plan.id;
  button.textContent='이 플랜 선택';button.addEventListener('click',()=>selectPlan(plan.id));card.append(name,top,billing,featureList(plan.features),button);return card}
function showEntitlement(session){const entitlement=session.subscription,active=entitlement.active;$('plan-status').textContent=entitlement.status.toUpperCase();
  $('plan-status').classList.toggle('active',active);$('studio').classList.toggle('hidden',!active);$('subscribe').classList.toggle('hidden',active);
  $('phone-field').classList.toggle('hidden',active);$('plan-picker').classList.toggle('hidden',active);
  if(session.admin){$('plan-title').textContent='관리자 무제한';$('plan-detail').replaceChildren(featureList(features.admin));return}
  $('plan-title').textContent=active?`${entitlement.plan_name} 구독 활성`:'Studio 구독 필요';
  $('plan-detail').replaceChildren(document.createTextNode(active?`${entitlement.plan_name} 플랜 권한이 적용되었습니다.`:'Core 또는 Pro 플랜을 선택하세요.'))}
async function load(){try{const [session,planData]=await Promise.all([fetch('/api/session').then(value=>value.json()),fetch('/api/plans').then(value=>value.json())]);
  if(!session.authenticated){location.assign('/?access=LOGIN_REQUIRED');return}$('identity').textContent=`@${session.user.login}`;
  $('organization').textContent=session.organization?`${session.organization.name} · ${session.organization.role.toUpperCase()}`:'조직 연결 없음';if(session.admin)$('admin-link').classList.remove('hidden');
  catalog=planData.plans??[];const container=$('plans');container.replaceChildren(...catalog.map(planCard));showEntitlement(session);if(!session.subscription.active)selectPlan(catalog.some(plan=>plan.id==='core')?'core':catalog[0]?.id);
  const checkout=new URLSearchParams(location.search).get('checkout');if(checkout==='return')$('account-message').textContent='결제를 확인하고 있습니다. PayApp 서버 통보 반영 후 Studio가 열립니다.';
}catch{$('account-message').textContent='계정 상태를 불러오지 못했습니다.'}}
$('subscribe').addEventListener('click',async()=>{const phone=$('phone').value.trim();if(!/^01(?:0|1|[6-9])-?[0-9]{3,4}-?[0-9]{4}$/.test(phone)){
  $('account-message').textContent='올바른 휴대전화 번호를 입력해 주세요.';return}try{await post('/api/checkout',{phone,plan_id:selectedPlan})}catch(error){
    $('account-message').textContent=error.message==='INVALID_PLAN'?'선택한 플랜의 결제 설정을 확인해 주세요.':'결제 페이지를 열 수 없습니다.'}});
$('logout').addEventListener('click',()=>post('/api/logout'));load();
