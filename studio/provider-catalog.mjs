export const providerCatalog=Object.freeze([
  {id:'openai',name:'OpenAI / GPT',protocol:'openai-responses',placement:'cloud'},
  {id:'anthropic',name:'Anthropic / Claude',protocol:'anthropic-messages',placement:'cloud'},
  {id:'google',name:'Google / Gemini',protocol:'google-generative-language',placement:'cloud'},
  {id:'moonshot',name:'Moonshot / Kimi',protocol:'openai-compatible',placement:'cloud'},
  {id:'deepseek',name:'DeepSeek',protocol:'openai-compatible',placement:'cloud'},
  {id:'ollama',name:'Ollama',protocol:'ollama',placement:'local'},
  {id:'openai-compatible',name:'OpenAI 호환 공급자',protocol:'openai-compatible',placement:'cloud_or_local'}
].map(value=>Object.freeze({...value,model_source:'customer_agent'})));

const identifiers=new Set(providerCatalog.map(value=>value.id));
export const isProviderId=value=>identifiers.has(value);
