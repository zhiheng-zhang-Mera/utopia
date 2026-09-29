import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Audit the Git delivery set without printing any matched value.
const config=JSON.parse(readFileSync('.runtime/local-config.json'));
const secrets=Object.values(config).filter(v=>typeof v==='string'&&v.length>8);
if(process.env.ADB){const serial=execFileSync(process.env.ADB,['get-serialno'],{windowsHide:true}).toString().trim();if(serial&&serial!=='unknown')secrets.push(serial);}
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z']).toString().split('\0').filter(Boolean);
const findings=[];
for(const file of files){
 const content=readFileSync(file);
 if(secrets.some(v=>content.includes(Buffer.from(v))))findings.push({file,kind:'PRIVATE_VALUE'});
 if(/\.(?:mjs|js|json|jsonl|xml|md|txt|ps1|kt|kts|yml|yaml)$/.test(file)&&/[A-Z]:[\\/](?:Users|CodexTemp|AndroidStudio|A-Utopia)[\\/]/i.test(content.toString()))findings.push({file,kind:'PRIVATE_ABSOLUTE_PATH'});
}
const manifest=JSON.parse(readFileSync('evidence/raw/v0.2/manifest.json'));
const manifestValid=manifest.files.every(row=>createHash('sha256').update(readFileSync('evidence/raw/v0.2/'+row.file)).digest('hex')===row.sha256);
const result={checkedAt:new Date().toISOString(),checkedFiles:files.length,knownPrivateValueKinds:process.env.ADB?['local credentials','connected device identifier']:['local credentials'],findings,manifestValid,limitations:['Exact known-value and selected private-path checks; not a general secret detector.','Images require separate visual review. Active pairing material must never be captured.']};
writeFileSync('.runtime/delivery-audit.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({checkedFiles:files.length,findingCount:findings.length,manifestValid}));
if(findings.length||!manifestValid)process.exitCode=1;
