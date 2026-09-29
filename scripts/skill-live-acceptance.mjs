import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createCatalog,renderCatalogSkill} from '../city/02-engineering/02-worker-gateway/skill-intake/catalog.mjs';
import {parseSkillText} from '../city/02-engineering/02-worker-gateway/skill-intake/format.mjs';
let status=null,failureCategory=null;
const fetchJson=async url=>{
  const token=execFileSync('gh',['auth','token'],{stdio:['ignore','pipe','ignore']}).toString().trim();
  let response;
  try{response=await fetch(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20000)});}
  catch{failureCategory='NETWORK_OR_TIMEOUT';throw Error(failureCategory);}
  status=response.status;
  if(!response.ok){failureCategory=({401:'AUTH_REQUIRED',403:'ACCESS_OR_RATE_LIMIT',429:'RATE_LIMIT'})[status]||'HTTP_FAILURE';throw Error(failureCategory);}
  return response.json();
};
const catalog=createCatalog({fetchJson,searchLimit:5});
const offline=await catalog.search();
const live=await catalog.search({includeLive:true});
const fallback=await createCatalog({fetchJson:async()=>{throw Error('CONTROLLED_EXTERNAL_FAILURE');}}).search({includeLive:true});
const report={requestClass:'GitHub Code Search filename:SKILL.md',timestamp:new Date().toISOString(),codeSha:execFileSync('git',['rev-parse','HEAD']).toString().trim(),workingTreeDirty:!!execFileSync('git',['status','--porcelain']).toString().trim(),status:live.liveStatus==='ok'?'PASS':'BLOCKED_EXTERNAL',httpStatus:status,resultCount:live.live?.length??0,failureCategory,offlineCount:offline.offline.total,offlineResultPreserved:JSON.stringify(live.offline)===JSON.stringify(offline.offline),controlledFailureAdditive:fallback.liveStatus==='failed'&&JSON.stringify(fallback.offline)===JSON.stringify(offline.offline),skillInspectUsable:!!parseSkillText(renderCatalogSkill(catalog.get('bundled-commit-message'))).ok};
mkdirSync('evidence/raw/v0.3',{recursive:true});writeFileSync('evidence/raw/v0.3/skill-live-acceptance.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
if(!report.offlineResultPreserved||!report.controlledFailureAdditive||!report.skillInspectUsable)process.exitCode=1;
