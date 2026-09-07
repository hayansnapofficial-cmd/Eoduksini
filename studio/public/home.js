const $=id=>document.getElementById(id),params=new URLSearchParams(location.search);
const messages={LOGIN_REQUIRED:'로그인이 필요합니다.',SUBSCRIPTION_REQUIRED:'Studio를 사용하려면 활성 구독이 필요합니다.',ADMIN_REQUIRED:'관리자 권한이 필요합니다.'};
async function load(){try{const session=await fetch('/api/session').then(value=>value.json());
  if(session.authenticated){$('login').classList.add('hidden');$('continue').classList.remove('hidden');$('account-link').classList.remove('hidden');if(session.admin)$('admin-link').classList.remove('hidden')}
  else if(!session.auth_configured){$('login').setAttribute('aria-disabled','true');$('login').addEventListener('click',event=>event.preventDefault());$('access-message').textContent='관리자가 GitHub 로그인을 아직 연결하지 않았습니다.'}
  const access=params.get('access'),error=params.get('error');if(access)$('access-message').textContent=messages[access]??'접근 권한을 확인해 주세요.';if(error)$('access-message').textContent='로그인을 완료하지 못했습니다. 다시 시도해 주세요.'
}catch{$('access-message').textContent='인증 서버 상태를 확인할 수 없습니다.'}}load();
