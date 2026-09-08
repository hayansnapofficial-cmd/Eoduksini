const $=id=>document.getElementById(id),roles=['head','planner','coder','reviewer','validator','general'],assignmentRoles=['planner','coder','reviewer','validator'];let connections=[],models=[],nodes=[],writable=false;
const post=async(path,payload)=>{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Eoduksini-Request':'1'},body:JSON.stringify(payload)}),value=await response.json();
  if(!response.ok)throw new Error(value.code);return value};
const empty=text=>{const node=document.createElement('p');node.className='registry-empty';node.textContent=text;return node};
const bytes=value=>{const units=['B','KiB','MiB','GiB','TiB'];let amount=value,index=0;while(amount>=1024&&index<units.length-1){amount/=1024;index++}return `${amount.toFixed(index?1:0)} ${units[index]}`};
function connectionRow(value,catalog){const row=document.createElement('article'),copy=document.createElement('div'),name=document.createElement('strong'),meta=document.createElement('small'),status=document.createElement('span');
  name.textContent=value.display_name;meta.textContent=`${catalog.get(value.provider_id)??value.provider_id} · 비밀값 위치: CUSTOMER AGENT`;status.className='registry-status pending';status.textContent=value.status.replace('_',' ');
  copy.append(name,meta);row.append(copy,status);return row}
function modelRow(value){const row=document.createElement('article'),copy=document.createElement('div'),name=document.createElement('strong'),meta=document.createElement('small'),rolesNode=document.createElement('span');
  name.textContent=value.display_name;meta.textContent=value.provider_model_id;rolesNode.className='role-tags';rolesNode.textContent=value.role_capabilities.join(' · ');copy.append(name,meta);row.append(copy,rolesNode);return row}
function nodeRow(value){const row=document.createElement('article'),identity=document.createElement('div'),name=document.createElement('strong'),meta=document.createElement('small'),capacity=document.createElement('div'),status=document.createElement('span');
  name.textContent=value.display_name;meta.textContent=`${value.os} · ${value.arch} · Agent ${value.agent_version}`;capacity.className='node-capacity';capacity.textContent=`CPU ${value.cpu_logical} · RAM ${bytes(value.memory_bytes)} · GPU ${value.gpu_status}`;
  status.className=`registry-status ${value.connectivity==='online'?'online':'offline'}`;status.textContent=value.connectivity;identity.append(name,meta);row.append(identity,capacity,status);return row}
function refreshConnectionOptions(){const select=$('model-connection');select.replaceChildren();for(const value of connections){const option=document.createElement('option');option.value=value.connection_id;option.textContent=value.display_name;select.append(option)}
  $('model-form').querySelector('button').disabled=!writable||connections.length===0}
const addOption=(select,value,label)=>{const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option)};
function compatibleNodes(modelId){const model=models.find(value=>value.model_id===modelId),connection=connections.find(value=>value.connection_id===model?.connection_id);
  return nodes.filter(value=>value.status==='active'&&value.adapters.includes(connection?.provider_id))}
function fillNodeOptions(role,selected=null){const select=$(`assignment-node-${role}`),modelId=$(`assignment-model-${role}`).value;select.replaceChildren();addOption(select,'','노드 선택');
  for(const node of compatibleNodes(modelId))addOption(select,node.node_id,node.display_name);if(selected&&[...select.options].some(value=>value.value===selected))select.value=selected}
function renderProfile(profile){const heads=models.filter(value=>value.status==='active'&&(value.role_capabilities.includes('head')||value.role_capabilities.includes('general'))),head=$('head-model');
  head.replaceChildren();addOption(head,'','Head AI 선택');for(const model of heads)addOption(head,model.model_id,model.display_name);if(profile?.head_model_id)head.value=profile.head_model_id;
  $('profile-mode').value=profile?.mode??'automatic';for(const role of assignmentRoles){const modelSelect=$(`assignment-model-${role}`),assignment=profile?.assignments?.[role]??null;
    modelSelect.replaceChildren();addOption(modelSelect,'','자동/미지정');for(const model of models.filter(value=>value.status==='active'&&(value.role_capabilities.includes(role)||value.role_capabilities.includes('general'))))
      addOption(modelSelect,model.model_id,model.display_name);if(assignment)modelSelect.value=assignment.model_id;fillNodeOptions(role,assignment?.node_id)}
  $('profile-revision').textContent=profile?`R${profile.revision}`:'NEW';toggleProfileMode()}
function toggleProfileMode(){const automatic=$('profile-mode').value==='automatic';for(const role of assignmentRoles){$(`assignment-model-${role}`).disabled=!writable||automatic;
  $(`assignment-node-${role}`).disabled=!writable||automatic}$('head-model').disabled=!writable;$('profile-form').querySelector('button').disabled=!writable||models.length===0}
async function loadProfile(){const data=await fetch('/api/organization/orchestration-profile').then(value=>value.json());renderProfile(data.profile)}
async function reload(catalog){const [providerData,modelData]=await Promise.all([fetch('/api/organization/providers').then(value=>value.json()),fetch('/api/organization/models').then(value=>value.json())]);
  connections=providerData.connections??[];models=modelData.models??[];$('connection-count').textContent=String(connections.length);$('model-count').textContent=String(models.length);
  $('connections').replaceChildren(...(connections.length?connections.map(value=>connectionRow(value,catalog)):[empty('아직 등록한 공급자가 없습니다.') ]));
  $('models').replaceChildren(...(models.length?models.map(modelRow):[empty('아직 등록한 모델이 없습니다.') ]));refreshConnectionOptions()}
async function reloadNodes(){const data=await fetch('/api/organization/nodes').then(value=>value.json());nodes=data.nodes??[];$('node-count').textContent=String(nodes.length);
  $('nodes').replaceChildren(...(nodes.length?nodes.map(nodeRow):[empty('등록된 고객 노드가 없습니다.')]))}
async function load(){try{const [session,catalogData]=await Promise.all([fetch('/api/session').then(value=>value.json()),fetch('/api/provider-catalog').then(value=>value.json())]);
  if(!session.authenticated){location.assign('/?access=LOGIN_REQUIRED');return}writable=['owner','admin'].includes(session.organization.role);
  $('organization').textContent=`${session.organization.name} · ${session.organization.role.toUpperCase()}${writable?'':' · 읽기 전용'}`;
  const catalog=new Map(catalogData.providers.map(value=>[value.id,value.name]));for(const value of catalogData.providers){const option=document.createElement('option');option.value=value.id;option.textContent=`${value.name} · ${value.placement}`;$('provider').append(option)}
  if(!writable)for(const form of document.querySelectorAll('form'))for(const control of form.elements)control.disabled=true;
  await Promise.all([reload(catalog),reloadNodes()]);await loadProfile();$('provider-form').addEventListener('submit',async event=>{event.preventDefault();try{await post('/api/organization/providers',{provider_id:$('provider').value,display_name:$('connection-name').value.trim()});
    $('connection-name').value='';$('provider-message').textContent='등록했습니다. Agent가 자격증명을 확인할 때까지 대기 상태입니다.';await reload(catalog)}catch(error){$('provider-message').textContent=error.message==='ORGANIZATION_ADMIN_REQUIRED'?'조직 관리자 권한이 필요합니다.':'공급자 정보를 등록하지 못했습니다.'}});
  $('model-form').addEventListener('submit',async event=>{event.preventDefault();const selected=[...document.querySelectorAll('input[name=role]:checked')].map(value=>value.value);if(selected.length===0){$('model-message').textContent='역할을 하나 이상 선택하세요.';return}
    try{await post('/api/organization/models',{connection_id:$('model-connection').value,provider_model_id:$('provider-model-id').value.trim(),display_name:$('model-name').value.trim(),role_capabilities:selected});
      $('provider-model-id').value='';$('model-name').value='';$('model-message').textContent='모델을 등록했습니다.';await reload(catalog);await loadProfile()}catch{$('model-message').textContent='모델 정보를 확인해 주세요.'}});
  $('enrollment-form').addEventListener('submit',async event=>{event.preventDefault();try{const value=await post('/api/organization/node-enrollments',{display_name:$('node-name').value.trim()});
    $('enrollment-token').textContent=value.token;$('enrollment-result').classList.remove('hidden');$('node-name').value='';$('node-message').textContent='등록 토큰을 발급했습니다.'}
    catch(error){$('node-message').textContent=error.message==='ORGANIZATION_ADMIN_REQUIRED'?'조직 관리자 권한이 필요합니다.':'등록 토큰을 발급하지 못했습니다.'}});
  $('copy-token').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('enrollment-token').textContent);$('node-message').textContent='토큰을 복사했습니다.'}
    catch{$('node-message').textContent='복사할 수 없습니다. 토큰을 직접 선택해 주세요.'}});$('profile-mode').addEventListener('change',toggleProfileMode);
  $('profile-form').addEventListener('submit',async event=>{event.preventDefault();const mode=$('profile-mode').value,assignments={};for(const role of assignmentRoles){const model_id=$(`assignment-model-${role}`).value,node_id=$(`assignment-node-${role}`).value;
    assignments[role]=mode==='automatic'||(!model_id&&!node_id)?null:{model_id,node_id}}try{const value=await post('/api/organization/orchestration-profile',{mode,head_model_id:$('head-model').value,assignments});
      renderProfile(value.profile);$('profile-message').textContent='Orchestration Profile을 저장했습니다.'}catch{$('profile-message').textContent='모델 역할과 노드 Adapter 조합을 확인해 주세요.'}});setInterval(()=>reloadNodes().catch(()=>{}),30_000)
}catch{$('provider-message').textContent='Registry를 불러오지 못했습니다.'}}
for(const role of roles){const label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span');input.type='checkbox';input.name='role';input.value=role;if(role==='general')input.checked=true;text.textContent=role;label.append(input,text);$('roles').append(label)}
for(const role of assignmentRoles){const row=document.createElement('div'),title=document.createElement('strong'),modelLabel=document.createElement('label'),modelSelect=document.createElement('select'),nodeLabel=document.createElement('label'),nodeSelect=document.createElement('select');
  row.className='assignment-row';title.textContent=role.toUpperCase();modelSelect.id=`assignment-model-${role}`;nodeSelect.id=`assignment-node-${role}`;modelLabel.append('모델',modelSelect);nodeLabel.append('노드',nodeSelect);
  modelSelect.addEventListener('change',()=>fillNodeOptions(role));row.append(title,modelLabel,nodeLabel);$('assignments').append(row)}load();
