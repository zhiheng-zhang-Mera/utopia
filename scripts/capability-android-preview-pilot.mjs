import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tree,tap,top,scroll} from './android-ui-driver.mjs';
const report=JSON.parse(readFileSync('.runtime/v03/windows/runs.json'));
const proof=existsSync('.runtime/v03/android/preview.json')?JSON.parse(readFileSync('.runtime/v03/android/preview.json')):{startedAt:new Date().toISOString(),checks:[]};
for(const [name,imageName]of [['evidence-review','evidence-details'],['theme-generate','theme']]){
 if(proof.checks.some(c=>c.name===(name==='evidence-review'?'artifact-hashes-displayed':'theme-preview-and-validation-displayed')&&c.pass))continue;const row=report.rows.find(r=>r.case===name&&r.pass);await top();await tap('COMPLETED · '+row.invocationId);await top();let nodes=await tree();
 for(let i=0;i<4;i++){const text=nodes.map(n=>n.text).join('\n');if(name==='theme-generate'&&text.includes('Validation:'))break;if(name==='evidence-review'&&text.includes('Show result details'))break;await scroll('down',nodes);nodes=await tree();}
 if(name==='evidence-review'){await tap('Show result details');nodes=await tree();for(let i=0;i<4&&!nodes.some(n=>n.text?.includes('sha256'));i++){await scroll('down',nodes);nodes=await tree();}proof.checks.push({name:'artifact-hashes-displayed',invocationId:row.invocationId,initiator:'Windows',pass:nodes.some(n=>n.text?.includes('sha256'))});}
 else proof.checks.push({name:'theme-preview-and-validation-displayed',invocationId:row.invocationId,initiator:'Windows',pass:nodes.some(n=>n['content-desc']==='Theme preview')&&nodes.some(n=>n.text?.startsWith('Validation:'))});
 writeFileSync('.runtime/v03/android/'+imageName+'.png',execFileSync(process.env.ADB||'adb',['exec-out','screencap','-p'],{windowsHide:true}));
}
proof.status=[...new Map(proof.checks.map(c=>[c.name,c])).values()].every(c=>c.pass)?'PASS':'FAIL';proof.finishedAt=new Date().toISOString();writeFileSync('.runtime/v03/android/preview.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));if(proof.status!=='PASS')process.exitCode=1;
