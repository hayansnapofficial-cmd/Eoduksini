const $=id=>document.getElementById(id);
async function post(path,payload){const response=await fetch(path,{method:'POST',headers:{'X-Eoduksini-Request':'1',...(payload?{'Content-Type':'application/json'}:{})},
  ...(payload?{body:JSON.stringify(payload)}:{})}),value=await response.json();if(!response.ok)throw new Error(value.code);if(value.url)location.assign(value.url)}
async function load(){try{const session=await fetch('/api/session').then(value=>value.json());if(!session.authenticated){location.assign('/?access=LOGIN_REQUIRED');return}
  $('identity').textContent=`@${session.user.login}`;if(session.admin)$('admin-link').classList.remove('hidden');const active=session.subscription.active;
  $('plan-status').textContent=session.subscription.status.toUpperCase();$('plan-status').classList.toggle('active',active);
  $('plan-title').textContent=active?'Studio 구독 활성':'Studio 구독 필요';$('studio').classList.toggle('hidden',!active);$('subscribe').classList.toggle('hidden',active);
  $('phone-field').classList.toggle('hidden',active);if(!session.billing_configured)$('account-message').textContent='관리자가 페이앱 결제를 아직 연결하지 않았습니다.';
  const checkout=new URLSearchParams(location.search).get('checkout');if(checkout==='return')$('account-message').textContent='결제를 확인하고 있습니다. 페이앱 서버 통보 반영 후 Studio가 열립니다.';
}catch{$('account-message').textContent='계정 상태를 불러오지 못했습니다.'}}
$('subscribe').addEventListener('click',async()=>{const phone=$('phone').value.trim();if(!/^01(?:0|1|[6-9])-?[0-9]{3,4}-?[0-9]{4}$/.test(phone)){
  $('account-message').textContent='올바른 휴대전화 번호를 입력해 주세요.';return}try{await post('/api/checkout',{phone})}catch{$('account-message').textContent='결제 페이지를 열 수 없습니다.'}});
$('logout').addEventListener('click',()=>post('/api/logout'));load();
