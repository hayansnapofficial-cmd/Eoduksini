const $=id=>document.getElementById(id);
const number=new Intl.NumberFormat('ko-KR');
const compact=new Intl.NumberFormat('ko-KR',{notation:'compact',maximumFractionDigits:1});
const statusClass=value=>['SUCCEEDED','PASS','ADOPTED','COMPLETE','READY'].includes(value)?'good':
  ['FAILED','REJECTED','BLOCKED','RECOVERY_REQUIRED','MANUAL_DECISION_REQUIRED'].includes(value)?'bad':'warn';
const text=(id,value)=>{$(id).textContent=value};
const pill=value=>{const span=document.createElement('span');span.className=`pill ${statusClass(value)}`;span.textContent=value??'—';return span};
const money=value=>value?Object.entries(value.by_currency??{}).map(([currency,amount])=>`${number.format(amount)} ${currency}`).join(' · ')||'미산정':'미산정';

function renderAttempts(snapshot) {
  const body=$('attempts');body.replaceChildren();
  for(const attempt of snapshot.attempts) {
    const row=document.createElement('tr'),metering=attempt.metering;
    const values=[attempt.attempt_id,metering?.node_id??'—',attempt.status,metering?.review_status??'—',metering?.adoption_status??'—',
      metering?.execution_duration_ms===null || metering?.execution_duration_ms===undefined?'—':`${number.format(Math.round(metering.execution_duration_ms))} ms`];
    values.forEach((value,index)=>{const cell=document.createElement('td');cell.append(index>=2 && index<=4?pill(value):document.createTextNode(value));row.append(cell)});
    body.append(row);
  }
  $('attempts-empty').classList.toggle('hidden',snapshot.attempts.length>0);text('attempt-badge',String(snapshot.attempts.length));
}

function renderSemantics(snapshot) {
  const list=$('semantic-list');list.replaceChildren();
  const findings=snapshot.semantic_assessments.filter(item=>item.status!=='NON_OVERLAPPING');
  for(const item of findings) {
    const section=document.createElement('div');section.className='semantic-item';section.append(pill(item.status));
    const detail=document.createElement('p');
    const parts=[...item.conflicts.map(value=>`${value.field}: ${value.left} ↔ ${value.right}`),
      ...item.uncertainty.map(value=>`${value.subject}: ${value.reason}`)];
    detail.textContent=`${item.attempt_id} · ${parts.join(' / ')||'상세 기록 없음'}`;section.append(detail);list.append(section);
  }
  $('semantic-empty').classList.toggle('hidden',findings.length>0);text('semantic-badge',String(findings.length));
}

function render(snapshot) {
  const controller=snapshot.controller,ready=controller.status==='READY';
  $('connection').className=`signal ${snapshot.configured?'ok':'error'}`;text('connection',snapshot.configured?'로컬 연결':'설정 필요');
  text('controller-title',snapshot.configured?controller.status:'Controller 미설정');
  text('controller-detail',snapshot.configured?`${controller.project_id} · ${controller.node_id}`:'--state-root에 Controller 상태 디렉터리를 지정해 실행하세요.');
  text('epoch',controller.control_epoch??'—');text('attempt-count',number.format(snapshot.totals.attempts));
  text('status-breakdown',Object.entries(snapshot.status_counts).map(([key,value])=>`${key} ${value}`).join(' · ')||'기록 없음');
  const holds=snapshot.totals.pending_attempts+Number(controller.recovery_required)+Number(controller.semantic_review_required)+Number(controller.owner_present);
  text('hold-count',number.format(holds));text('hold-detail',ready?'차단 없음':'확인 필요');
  const tokens=snapshot.totals.observed_input_tokens+snapshot.totals.observed_output_tokens;
  text('token-count',compact.format(tokens));text('token-detail',`입력 ${compact.format(snapshot.totals.observed_input_tokens)} · 출력 ${compact.format(snapshot.totals.observed_output_tokens)}`);
  text('journal-seq',controller.journal_seq??'—');text('journal-detail',controller.journal_bytes===null?'크기 미확인':`${compact.format(controller.journal_bytes)} bytes`);
  text('project',controller.project_id??'—');text('node',controller.node_id??'—');text('updated',new Date(snapshot.generated_at).toLocaleString('ko-KR'));
  renderAttempts(snapshot);renderSemantics(snapshot);
  const econ=snapshot.economics;text('economics-state',econ?.status??'—');text('incomplete',econ?number.format(econ.incomplete_attempt_count):'—');
  text('energy',econ?.observed_energy?`${number.format(econ.observed_energy.kwh)} kWh`:'미측정');
  text('energy-cost',money(econ?.energy_cost));text('api-cost',money(econ?.estimated_api_counterfactual));
}

async function refresh() {
  const button=$('refresh');button.disabled=true;
  try {const response=await fetch('/api/snapshot',{cache:'no-store'});if(!response.ok) throw new Error('snapshot');render(await response.json());}
  catch { $('connection').className='signal error';text('connection','상태 오류');text('controller-title','Controller 상태를 읽을 수 없습니다');
    text('controller-detail','저널 경로와 무결성을 확인한 뒤 다시 시도하세요.'); }
  finally {button.disabled=false}
}

$('refresh').addEventListener('click',refresh);refresh();
setInterval(()=>{if(document.visibilityState==='visible') refresh()},10_000);
