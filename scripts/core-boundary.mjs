const ADAPTER_SCHEMA_REFERENCE=/adapters[\\/][a-z][a-z0-9_-]*(?:[\\/][^'"`\r\n]+)*[\\/]schemas[\\/]/i;
const CORE_SCHEMA_REFERENCE=/core[\\/]schemas[\\/]/i;

export function adapterToCoreSchemaCoupling(source) {
  if(typeof source!=='string') throw new Error('INVALID_BOUNDARY_SOURCE');
  return ADAPTER_SCHEMA_REFERENCE.test(source) && CORE_SCHEMA_REFERENCE.test(source);
}

export function assertNoAdapterToCoreSchemaCoupling(source,file) {
  if(typeof file!=='string' || !file) throw new Error('INVALID_BOUNDARY_FILE');
  if(adapterToCoreSchemaCoupling(source)) throw new Error('ADAPTER_TO_CORE_SCHEMA_COUPLING: '+file);
}
