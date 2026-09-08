const $=id=>document.getElementById(id),roles=['head','planner','coder','reviewer','validator','general'];let connections=[],writable=false;
const post=async(path,payload)=>{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Eoduksini-Request':'1'},body:JSON.stringify(payload)}),value=await response.json();
  if(!response.ok)throw new Error(value.code);return value};
const empty=text=>{const node=document.createElement('p');node.className='registry-empty';node.textContent=text;return node};
function connectionRow(value,catalog){const row=document.createElement('article'),copy=document.createElement('div'),name=document.createElement('strong'),meta=document.createElement('small'),status=document.createElement('span');
  name.textContent=value.display_name;meta.textContent=`${catalog.get(value.provider_id)??value.provider_id} · 비밀값 위치: CUSTOMER AGENT`;status.className='registry-status pending';status.textContent=value.status.replace('_',' ');
  copy.append(name,meta);row.append(copy,status);return row}
function modelRow(value){const row=document.createElement('article'),copy=document.createElement('div'),name=document.createElement('strong'),meta=document.createElement('small'),rolesNode=document.createElement('span');
  name.textContent=value.display_name;meta.textContent=value.provider_model_id;rolesNode.className='role-tags';rolesNode.textContent=value.role_capabilities.join(' · ');copy.append(name,meta);row.append(copy,rolesNode);return row}
function refreshConnectionOptions(){const select=$('model-connection');select.replaceChildren();for(const value of connections){const option=document.createElement('option');option.value=value.connection_id;option.textContent=value.display_name;select.append(option)}
  $('model-form').querySelector('button').disabled=!writable||connections.length===0}
async function reload(catalog){const [providerData,modelData]=await Promise.all([fetch('/api/organization/providers').then(value=>value.json()),fetch('/api/organization/models').then(value=>value.json())]);
  connections=providerData.connections??[];const models=modelData.models??[];$('connection-count').textContent=String(connections.length);$('model-count').textContent=String(models.length);
  $('connections').replaceChildren(...(connections.length?connections.map(value=>connectionRow(value,catalog)):[empty('아직 등록한 공급자가 없습니다.') ]));
  $('models').replaceChildren(...(models.length?models.map(modelRow):[empty('아직 등록한 모델이 없습니다.') ]));refreshConnectionOptions()}
async function load(){try{const [session,catalogData]=await Promise.all([fetch('/api/session').then(value=>value.json()),fetch('/api/provider-catalog').then(value=>value.json())]);
  if(!session.authenticated){location.assign('/?access=LOGIN_REQUIRED');return}writable=['owner','admin'].includes(session.organization.role);
  $('organization').textContent=`${session.organization.name} · ${session.organization.role.toUpperCase()}${writable?'':' · 읽기 전용'}`;
  const catalog=new Map(catalogData.providers.map(value=>[value.id,value.name]));for(const value of catalogData.providers){const option=document.createElement('option');option.value=value.id;option.textContent=`${value.name} · ${value.placement}`;$('provider').append(option)}
  if(!writable)for(const form of document.querySelectorAll('form'))for(const control of form.elements)control.disabled=true;
  await reload(catalog);$('provider-form').addEventListener('submit',async event=>{event.preventDefault();try{await post('/api/organization/providers',{provider_id:$('provider').value,display_name:$('connection-name').value.trim()});
    $('connection-name').value='';$('provider-message').textContent='등록했습니다. Agent가 자격증명을 확인할 때까지 대기 상태입니다.';await reload(catalog)}catch(error){$('provider-message').textContent=error.message==='ORGANIZATION_ADMIN_REQUIRED'?'조직 관리자 권한이 필요합니다.':'공급자 정보를 등록하지 못했습니다.'}});
  $('model-form').addEventListener('submit',async event=>{event.preventDefault();const selected=[...document.querySelectorAll('input[name=role]:checked')].map(value=>value.value);if(selected.length===0){$('model-message').textContent='역할을 하나 이상 선택하세요.';return}
    try{await post('/api/organization/models',{connection_id:$('model-connection').value,provider_model_id:$('provider-model-id').value.trim(),display_name:$('model-name').value.trim(),role_capabilities:selected});
      $('provider-model-id').value='';$('model-name').value='';$('model-message').textContent='모델을 등록했습니다.';await reload(catalog)}catch{$('model-message').textContent='모델 정보를 확인해 주세요.'}})
}catch{$('provider-message').textContent='Registry를 불러오지 못했습니다.'}}
for(const role of roles){const label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span');input.type='checkbox';input.name='role';input.value=role;if(role==='general')input.checked=true;text.textContent=role;label.append(input,text);$('roles').append(label)}load();
