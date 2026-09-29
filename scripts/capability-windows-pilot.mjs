import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {capabilityFixtures} from './capability-fixtures.mjs';
const outputDir=process.env.UTOPIA_WINDOWS_EVIDENCE_DIR??'.runtime/v03/windows';
const fixtures=await capabilityFixtures();const config=JSON.parse(readFileSync('.runtime/local-config.json')),{url}=JSON.parse(readFileSync('.runtime/processes.json'));
const browser=await chromium.launch({channel:'msedge',headless:false}),page=await browser.newPage({locale:'en-US',viewport:{width:1440,height:1050}});
const report={codeSha:execFileSync('git',['rev-parse','HEAD']).toString().trim(),driverSha256:createHash('sha256').update(readFileSync('scripts/capability-windows-pilot.mjs')).digest('hex'),startedAt:new Date().toISOString(),surface:'Headed Microsoft Edge; all invocations through visible Services controls',rows:[]};
mkdirSync(outputDir,{recursive:true});
let response=null;page.on('response',async r=>{if(r.url().includes('/capabilities/')&&r.url().endsWith('/invoke'))response=await r.json();});
const choose=async id=>{response=null;await page.locator('[data-service="'+id+'"]').click();};
async function invoke(name,expected='COMPLETED',button='#service-invoke',inputHash=null){response=null;await page.locator(button).click();await page.waitForFunction(()=>['COMPLETED','FAILED'].includes(document.querySelector('#service-state')?.textContent));await page.waitForTimeout(80);const state=await page.locator('#service-state').innerText(),text=await page.locator('#service-result').textContent();const row={case:name,capabilityId:response?.capabilityId??null,operationId:response?.operationId??null,startedAt:response?.startedAt??null,finishedAt:response?.finishedAt??null,latencyMs:response?.finishedAt?Date.parse(response.finishedAt)-Date.parse(response.startedAt):null,inputClass:response?.inputClass??null,inputBytes:response?.inputBytes??null,expected,status:state,pass:state===expected,invocationId:response?.invocationId??null,resultDigest:response?.resultDigest??null,errorCode:response?.errorCode??(state==='FAILED'?JSON.parse(text).errorCode:null),inputSha256:inputHash};if(name==='sample.xlsx')row.formulaWarningObserved=/formula/i.test(text);if(response?.result?.bundle)row.integrityRoot=response.result.bundle.integrityRoot;report.rows.push(row);writeFileSync(outputDir+'/runs.json',JSON.stringify(report,null,2));if(!row.pass)throw Error('WINDOWS_CASE_FAILED:'+name);return row;}
try{
 await page.goto(url);await page.locator('#token').fill(config.token);await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'ONLINE'}).waitFor();await page.locator('[data-page="Services"]').click();
 for(const name of ['sample.txt','sample.json','sample.yaml','sample.docx','sample.xlsx','sample.pdf','malformed.json','oversize.txt','truncated.pdf']){
  await choose('planning.document.intake');await page.locator('#service-file').setInputFiles(resolve('.runtime/v03/fixtures/'+name));await invoke(name,name.startsWith('sample.')?'COMPLETED':'FAILED','#service-invoke',createHash('sha256').update(fixtures[name]).digest('hex'));
 }
 await choose('planning.document.intake');await page.locator('#service-file').setInputFiles(resolve('.runtime/v03/fixtures/sample.txt'));await invoke('document-for-knowledge');await page.locator('#document-to-knowledge').click();await invoke('document-to-knowledge');
 await choose('planning.knowledge.query');await page.locator('#use-document').uncheck();await invoke('knowledge-temporary');
 for(const ref of ['owner/repo','owner/repo@main','https://github.com/owner/repo/tree/main/skills/demo','https://github.com/owner/repo/blob/main/skills/demo/SKILL.md','https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md','owner/repo@main/../../escape']){await choose('engineering.skill.inspect');await page.locator('#skill-ref').fill(ref);await invoke('skill-ref:'+ref,ref.includes('..')?'FAILED':'COMPLETED');}
 for(const name of ['valid-SKILL.md','malformed-SKILL.md']){await choose('engineering.skill.inspect');await page.locator('#skill-operation').selectOption('validate');await page.locator('#skill-text').fill(fixtures[name].toString());await invoke(name,name.startsWith('valid')?'COMPLETED':'FAILED');}
 for(const name of ['valid.tar','unsafe.tar']){await choose('engineering.skill.inspect');await page.locator('#skill-operation').selectOption('archive');await page.locator('#service-file').setInputFiles(resolve('.runtime/v03/fixtures/'+name));await invoke(name,name==='valid.tar'?'COMPLETED':'FAILED');}
 await choose('engineering.skill.inspect');await page.locator('#skill-operation').selectOption('catalog');await page.locator('#skill-ref').fill('');await invoke('offline-catalog');
 await choose('research.evidence.review');await invoke('evidence-review');await page.screenshot({path:outputDir+'/evidence.png',fullPage:true});await invoke('evidence-tamper','FAILED','#service-tamper');
 await choose('presentation.theme.lab');await invoke('theme-generate');await page.screenshot({path:outputDir+'/theme.png',fullPage:true});
 report.finishedAt=new Date().toISOString();report.status='PASS';
}catch(error){report.status='FAIL';report.failure=String(error.message).split('\n')[0];process.exitCode=1;}
finally{writeFileSync(outputDir+'/runs.json',JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({status:report.status,rows:report.rows.length,failed:report.rows.filter(r=>!r.pass).map(r=>r.case),failure:report.failure}));}
