import { readFileSync, readdirSync, realpathSync } from 'node:fs';

const INTEGER=/^(0|[1-9][0-9]*)$/;
const check=(condition,reason)=>{if(!condition) throw new Error(reason);};
const value=path=>readFileSync(path,'utf8').trim();
const time=value=>typeof value==='string' && new Date(value).toISOString()===value;

export function raplSnapshotContract(snapshot) {
  check(snapshot && typeof snapshot==='object' && !Array.isArray(snapshot) &&
    Object.keys(snapshot).length===4 && snapshot.schema_version===1 && time(snapshot.observed_at) &&
    typeof snapshot.boot_id==='string' && snapshot.boot_id.length>0 && Array.isArray(snapshot.zones) && snapshot.zones.length>0,
  'INVALID_RAPL_SNAPSHOT');
  const ids=new Set();
  for(const zone of snapshot.zones) {
    check(zone && typeof zone==='object' && !Array.isArray(zone) && Object.keys(zone).length===4 &&
      typeof zone.zone_id==='string' && /^intel-rapl:[0-9]+$/.test(zone.zone_id) && !ids.has(zone.zone_id) &&
      typeof zone.name==='string' && zone.name.length>0 && zone.name.length<=128 && zone.name.isWellFormed() &&
      typeof zone.energy_uj==='string' && INTEGER.test(zone.energy_uj) &&
      typeof zone.max_energy_range_uj==='string' && INTEGER.test(zone.max_energy_range_uj) &&
      BigInt(zone.max_energy_range_uj)>0n && BigInt(zone.energy_uj)<BigInt(zone.max_energy_range_uj),'INVALID_RAPL_SNAPSHOT');
    ids.add(zone.zone_id);
  }
  check(snapshot.zones.every((zone,index)=>index===0 || snapshot.zones[index-1].zone_id<zone.zone_id),
    'INVALID_RAPL_SNAPSHOT');
  return structuredClone(snapshot);
}

export function readRaplSnapshot() {
  check(process.platform==='linux','RAPL_LINUX_REQUIRED');
  const root='/sys/class/powercap',trusted='/sys/devices/virtual/powercap/intel-rapl/';
  let names;
  try {names=readdirSync(root).filter(name=>/^intel-rapl:[0-9]+$/.test(name)).sort();}
  catch(error) {throw new Error(error.code==='EACCES'?'ENERGY_SENSOR_PERMISSION_DENIED':'ENERGY_SENSOR_UNAVAILABLE');}
  check(names.length>0,'ENERGY_SENSOR_UNAVAILABLE');
  try {
    const zones=names.map(zone_id=>{
      const path=`${root}/${zone_id}`,real=realpathSync(path).replaceAll('\\','/');
      check(real.startsWith(trusted),'UNTRUSTED_ENERGY_SENSOR_PATH');
      return {zone_id,name:value(`${path}/name`),energy_uj:value(`${path}/energy_uj`),
        max_energy_range_uj:value(`${path}/max_energy_range_uj`)};
    });
    return raplSnapshotContract({schema_version:1,observed_at:new Date().toISOString(),
      boot_id:value('/proc/sys/kernel/random/boot_id'),zones});
  } catch(error) {
    if(error.code==='EACCES') throw new Error('ENERGY_SENSOR_PERMISSION_DENIED');
    if(/^UNTRUSTED_|^INVALID_/.test(error.message)) throw error;
    throw new Error('ENERGY_SENSOR_UNAVAILABLE');
  }
}

export function raplEnergyDelta(start,end) {
  start=raplSnapshotContract(start);end=raplSnapshotContract(end);
  check(start.boot_id===end.boot_id && Date.parse(end.observed_at)>=Date.parse(start.observed_at),
    'RAPL_SNAPSHOT_MISMATCH');
  check(start.zones.length===end.zones.length,'RAPL_SNAPSHOT_MISMATCH');
  let total=0n;
  for(let index=0;index<start.zones.length;index++) {
    const before=start.zones[index],after=end.zones[index];
    check(before.zone_id===after.zone_id && before.name===after.name &&
      before.max_energy_range_uj===after.max_energy_range_uj,'RAPL_SNAPSHOT_MISMATCH');
    const first=BigInt(before.energy_uj),last=BigInt(after.energy_uj),range=BigInt(before.max_energy_range_uj);
    total+=last>=first?last-first:range-first+last;
  }
  check(total<=BigInt(Number.MAX_SAFE_INTEGER),'RAPL_DELTA_TOO_LARGE');
  return {source_kind:'RAPL',measurement_scope:'COMPONENT_INTERVAL',interval_started_at:start.observed_at,
    interval_finished_at:end.observed_at,observed_energy_uj:total.toString(),observed_energy_kwh:Number(total)/3_600_000_000_000,
    component_note:'CPU package domains only; excludes GPU, memory outside package accounting, storage, fans and conversion losses'};
}
