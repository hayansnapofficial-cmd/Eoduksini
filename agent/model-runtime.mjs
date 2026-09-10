import { executionPromptWithArtifact } from '../studio/model-execution.mjs';

const check=(condition,reason)=>{if(!condition)throw new Error(reason)};
const loopback=value=>{const url=new URL(value);check(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&
  /^\d{1,5}$/.test(url.port)&&Number(url.port)<=65535&&url.pathname==='/'&&!url.search&&!url.hash,'INVALID_OLLAMA_ENDPOINT');return url.origin};
async function boundedJson(response,maximum=2_097_152) {check(response.ok&&response.body,'PROVIDER_HTTP_FAILED');const reader=response.body.getReader(),decoder=new TextDecoder();
  let text='',bytes=0;for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;check(bytes<=maximum,'PROVIDER_RESPONSE_LIMIT');text+=decoder.decode(value,{stream:true})}
  text+=decoder.decode();return JSON.parse(text)}

export const ollamaConfig=value=>({provider_id:'ollama',endpoint:loopback(value),adapter_version:'1'});

export async function invokeConfiguredModel({config,binding,envelope,predecessor_text=null}) {
  check(config.provider_id==='ollama'&&binding.provider_id==='ollama','UNSUPPORTED_PROVIDER_ADAPTER');
  const inventory=await fetch(config.endpoint+'/api/tags',{signal:AbortSignal.timeout(10_000)}).then(response=>boundedJson(response,1_048_576)),
    installed=Array.isArray(inventory.models)&&inventory.models.find(value=>value?.name===binding.provider_model_id);
  check(installed&&/^[0-9a-f]{64}$/.test(installed.digest??''),'PROVIDER_MODEL_NOT_INSTALLED');
  const prompt=executionPromptWithArtifact(envelope,predecessor_text),
    response=await fetch(config.endpoint+'/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      model:binding.provider_model_id,prompt,stream:false,think:false,options:{temperature:0,num_predict:2048}}),signal:AbortSignal.timeout(100_000)}),value=await boundedJson(response);
  check(value.model===binding.provider_model_id&&typeof value.response==='string'&&value.response.trim().length>0&&Buffer.byteLength(value.response,'utf8')<=64*1024&&
    Number.isSafeInteger(value.prompt_eval_count)&&value.prompt_eval_count>=0&&Number.isSafeInteger(value.eval_count)&&value.eval_count>=0,
  'INVALID_PROVIDER_RESPONSE');return {text:value.response,input_tokens:value.prompt_eval_count,output_tokens:value.eval_count,
    model_revision:installed.digest};
}
