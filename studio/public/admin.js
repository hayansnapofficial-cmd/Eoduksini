const $=id=>document.getElementById(id),number=new Intl.NumberFormat('ko-KR'),date=new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short'}),limit=50;
let offset=0,total=0,loading=false;
const labels={admin:'관리자',active:'활성',trialing:'체험',past_due:'결제 확인',canceled:'해지',unpaid:'미납',incomplete:'미완료',incomplete_expired:'만료',paused:'중지',none:'미구독'};
const statusClass=status=>['active','trialing'].includes(status)?'good':['past_due','unpaid','incomplete'].includes(status)?'warn':status==='none'?'neutral':'bad';
const cell=(text,className)=>{const value=document.createElement('td');value.textContent=text;if(className)value.className=className;return value};

function customerRow(customer) {
  const row=document.createElement('tr'),identity=document.createElement('td'),wrap=document.createElement('div'),avatar=document.createElement('img'),name=document.createElement('div'),login=document.createElement('strong'),id=document.createElement('small');
  wrap.className='customer-identity';avatar.className='customer-avatar';avatar.src=customer.avatar_url||'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="40"%3E%3Crect width="40" height="40" fill="%23293139"/%3E%3C/svg%3E';avatar.alt='';login.textContent=`@${customer.login}`;id.textContent=`GitHub ${customer.github_id}`;name.append(login,id);wrap.append(avatar,name);identity.append(wrap);row.append(identity);
  row.append(cell(customer.role==='admin'?'관리자':'고객',customer.role==='admin'?'access-good':''));
  row.append(cell(customer.subscription.plan_name??'—'));
  const subscription=document.createElement('td'),pill=document.createElement('span'),status=customer.subscription.status;
  pill.className=`customer-status ${statusClass(status)}`;pill.textContent=labels[status]??status;subscription.append(pill);row.append(subscription);
  row.append(cell(customer.subscription.active?'허용':'차단',customer.subscription.active?'access-good':'access-blocked'));
  row.append(cell(customer.billing_provider==='payapp'?'PayApp':customer.billing_provider??'—'));
  row.append(cell(date.format(new Date(customer.updated_at)),'customer-date'));return row;
}

function render(data) {
  const body=$('customers');body.replaceChildren();total=data.total;
  for(const customer of data.customers)body.append(customerRow(customer));
  if(!data.customers.length){const row=document.createElement('tr'),empty=cell('조건에 맞는 고객이 없습니다.','empty');empty.colSpan=7;row.append(empty);body.append(row)}
  const first=total?offset+1:0,last=Math.min(offset+limit,total);$('result-count').textContent=`${number.format(total)}명`;$('page').textContent=`${number.format(first)}–${number.format(last)} / ${number.format(total)}`;$('previous').disabled=offset===0;$('next').disabled=offset+limit>=total;
}

async function load({reset=false}={}) {
  if(loading)return;if(reset)offset=0;loading=true;$('admin-message').textContent='';$('refresh').disabled=true;
  try {const params=new URLSearchParams({q:$('query').value.trim(),status:$('status').value,limit:String(limit),offset:String(offset)}),[summary,customers]=await Promise.all([fetch('/api/admin/summary'),fetch(`/api/admin/customers?${params}`)]);if(!summary.ok||!customers.ok)throw new Error();const metrics=await summary.json(),data=await customers.json();$('users').textContent=number.format(metrics.total_users);$('active').textContent=number.format(metrics.active_subscriptions);$('admins').textContent=number.format(metrics.admin_accounts);$('conversion').textContent=metrics.total_users?`${Math.round(metrics.active_subscriptions/metrics.total_users*100)}%`:'0%';const counts=metrics.subscription_counts;$('attention').textContent=number.format(['past_due','unpaid','incomplete'].reduce((sum,key)=>sum+(counts[key]??0),0));render(data)}
  catch {$('admin-message').textContent='고객 정보를 불러오지 못했습니다.'}
  finally {loading=false;$('refresh').disabled=false}
}

$('filters').addEventListener('submit',event=>{event.preventDefault();load({reset:true})});
$('status').addEventListener('change',()=>load({reset:true}));
$('refresh').addEventListener('click',()=>load());
$('previous').addEventListener('click',()=>{offset=Math.max(0,offset-limit);load()});
$('next').addEventListener('click',()=>{if(offset+limit<total){offset+=limit;load()}});
load();
