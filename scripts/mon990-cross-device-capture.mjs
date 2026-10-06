import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync,execFile} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {createGateway} from '../services/dev-gateway/server.mjs';
const adb=process.env.MON990_ADB??'D:/Tools/UtopiaAndroidSdk/platform-tools/adb.exe', serial=process.env.MON990_SERIAL??'BICIPVNB5HS85H9T',pkg='city.utopia.control.mon990review';
const out=resolve('evidence/raw/mission-book/MON-990/alien-cross-device');await mkdir(out,{recursive:true});
const sourceSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const runAdb=(args,input,encoding='utf8')=>new Promise((resolve,reject)=>{const child=execFile(adb,['-s',serial,...args],{encoding,timeout:15000,maxBuffer:16*1024*1024},(err,out)=>err?reject(err):resolve(out));if(input!==undefined)child.stdin.end(input)});
const device=(...args)=>runAdb(args);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function dump(){await device('shell','uiautomator','dump','/sdcard/mon990-ui.xml');return await device('exec-out','cat','/sdcard/mon990-ui.xml')}
const interactions={taps:0,swipes:0};const delta=start=>({taps:interactions.taps-start.taps,swipes:interactions.swipes-start.swipes});
async function hit(xml,label,desc=false){const nodes=xml.match(/<node\b[^>]*>/g)??[];const attr=desc?'content-desc':'text';const n=nodes.find(n=>n.includes(attr+'="'+label+'"'));if(!n)return false;const b=n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);if(!b||+b[4]<=+b[2])return false;await device('shell','input','tap',String(Math.round((+b[1]+ +b[3])/2)),String(Math.round((+b[2]+ +b[4])/2)));interactions.taps++;return true}
async function tap(label,{desc=false,scroll=false}={}){for(let i=0;i<8;i++){if(await hit(await dump(),label,desc)){await pause(500);return}if(scroll){await device('shell','input','swipe','540','1830','540','750','350');interactions.swipes++;}else await pause(300)}throw Error('Native label not reachable: '+label)}
async function save(name){await writeFile(resolve(out,name+'.png'),await runAdb(['exec-out','screencap','-p'],undefined,null));await writeFile(resolve(out,name+'.xml'),await dump())}
const dir=await mkdtemp(resolve('.scratch-mon990-capture-'));let app,browser,port;
const owner=randomUUID(),worker=randomUUID();
try{
 app=await createGateway({dir,port:0,token:owner,nodeToken:worker,roomsDisabled:true,heartbeatTimeout:600000});port=new URL(app.url).port;
 const request=async(path,body,token=owner)=>{const r=await fetch(app.url+'/api/v0/'+path,{headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-City-Api-Version':'0','X-City-Schema-Version':'0'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(path+': '+r.status);return r.json()};
 await request('node/register',{id:'controlled-worker',displayName:'Controlled review worker',capabilities:['task.execute.safe','filesystem.temp']},worker);
 for(let i=0;i<140;i++)await request('tasks',{type:'WAIT'});
 const {task}=await request('node/claim',{id:'controlled-worker'},worker);
 await request('node/report',{id:'controlled-worker',taskId:task.id,state:'RUNNING',progress:40},worker);
 await request('node/report',{id:'controlled-worker',taskId:task.id,state:'FAILED',progress:60,error:'Controlled fixture endpoint refused work'},worker);
 await request('monitor/decisions',{kind:'SCOPE_CHANGE',taskRef:task.id,reason:'Controlled cross-surface review boundary'});
 for(let i=0;i<100&&app.decisions.metrics().concurrentDecisionTasks;i++)await pause(10);
 const {graph}=await request('monitor/graph?collapse=24');const failed=graph.events.find(e=>e.taskRef===task.id&&e.type==='TASK_FAILED');if(!failed)throw Error('Canonical failed evidence missing');
 await device('reverse','tcp:'+port,'tcp:'+port);
 await device('shell','am','force-stop',pkg);
 const prefs=`<?xml version="1.0" encoding="utf-8"?><map><string name="host">http://127.0.0.1:${port}</string><string name="token">${owner}</string><string name="cityId">${app.store.cityId}</string></map>`;
 await runAdb(['shell','run-as',pkg,'sh','-c',"'mkdir -p shared_prefs; cat > shared_prefs/city-connection.xml'"],prefs);
 await device('shell','am','start','-n',pkg+'/city.utopia.control.MainActivity');await pause(2000);const firstUi=await dump();if(firstUi.includes('发送通知'))await hit(firstUi,'拒绝');
 await tap('更多',{desc:true});await tap('全城工作');await pause(2500);await save('native-overview');
 const riskStart={...interactions};await tap('等待任务 · 失败',{scroll:true});await tap('查看风险证据');const riskInteractions=delta(riskStart);await save('native-two-step-failure-evidence');
 let proof=await dump();if(!proof.includes(failed.canonicalEventId)||!proof.includes('TASK_FAILED'))throw Error('Native exact failed evidence not visible');
 await tap('返回总览',{scroll:true});await device('shell','input','swipe','540','700','540','1850','400');const pathStart={...interactions};await tap('等待任务 · 失败',{scroll:true});await tap('查看设备分配路线',{scroll:true});await save('native-path');
 const edge=graph.edges.find(e=>e.from===task.id);const index=edge.evidenceRefs.indexOf(failed.canonicalEventId)+1;if(index<1)throw Error('Path did not retain canonical failed evidence');await tap('查看相关事件 '+index,{scroll:true});const pathInteractions=delta(pathStart);await save('native-three-step-path-evidence');proof=await dump();if(!proof.includes(failed.canonicalEventId))throw Error('Native path evidence wrong reference');
 await tap('返回总览',{scroll:true});await device('shell','input','swipe','540','700','540','1850','400');
 await tap('展开 排队中 · 127 项任务',{scroll:true});await save('native-expanded');if(!(await dump()).includes('等待任务 · 失败'))throw Error('Expanded graph hid active failure');await tap('收起 排队中 · 127 项任务',{scroll:true});
 await device('shell','input','swipe','540','700','540','1850','400');await tap('隐藏路线',{scroll:true});await pause(2500);await tap('等待任务 · 失败',{scroll:true});const filtered=await dump();if(filtered.includes('查看设备分配路线'))throw Error('Native path filter did not apply');await save('native-filtered-node');await tap('返回总览',{scroll:true});await device('shell','input','swipe','540','700','540','1850','400');await tap('全部路线',{scroll:true});await pause(2500);await tap('决定来源',{scroll:true});await tap('收据标记需所有者',{scroll:true});await save('native-owner-provenance');await tap('返回总览',{scroll:true});
 browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const page=await browser.newPage({locale:'en-US',viewport:{width:1440,height:1000}});await page.goto(app.url);await page.locator('#token').fill(owner);await page.locator('#connect').click();await page.locator('#connection.online').waitFor();await page.locator('nav [data-page="Monitor"]').click();await page.locator('.monitor-panel[data-loaded="true"]').waitFor();await page.screenshot({path:resolve(out,'web-overview.png'),fullPage:true});
 await page.locator('.monitor-panel [data-monitor-node="'+task.id+'"]').first().click();await page.locator('.monitor-inspector [data-monitor-edge]').first().click();await page.locator('.monitor-inspector [data-evidence="'+failed.canonicalEventId+'"]').click();const webEvidence=JSON.parse(await page.locator('#monitor-evidence pre').innerText());await page.screenshot({path:resolve(out,'web-three-step-evidence.png'),fullPage:true});
 await page.locator('#view [data-page="Decisions"]').click();await page.locator('#dec-table').waitFor();await page.locator('details[data-provenance] summary').first().click();await page.screenshot({path:resolve(out,'web-owner-provenance.png'),fullPage:true});
 const snapshot=await request('city');const canonicalTask=app.store.get('tasks',task.id);const decisionData=await request('monitor/decisions');await device('shell','input','swipe','540','700','540','1850','400');await tap('工作总览',{scroll:true});await app.close();await pause(8000);await save('native-offline');const offlineXml=await dump();if(!offlineXml.includes('连接已断开')||offlineXml.includes('等待任务 · 失败'))throw Error('Native offline scope did not clear graph');const apk=await readFile('apps/android/app/build/outputs/apk/debug/app-debug.apk');
 await writeFile(resolve(out,'runtime-capture.json'),JSON.stringify({sourceSha,measuredAt:new Date().toISOString(),host:process.env.COMPUTERNAME,fixture:'REAL_ISOLATED_GATEWAY_WITH_CONTROLLED_CANONICAL_NODE_REPORTS',cityId:app.store.cityId,device:{serial,model:(await device('shell','getprop','ro.product.model')).trim(),sdk:(await device('shell','getprop','ro.build.version.sdk')).trim(),package:pkg,variant:'monitorReviewVariant=true; applicationId/version suffix only',apkSha256:createHash('sha256').update(apk).digest('hex')},canonicalTask,canonicalSurfaces:snapshot.controlSurfaces,graph,decisions:decisionData,webEvidence,nativeRiskEvidence:{ref:failed.canonicalEventId,steps:2,interactions:riskInteractions,visibleUiVerified:true},nativePathEvidence:{ref:failed.canonicalEventId,steps:3,interactions:pathInteractions,visibleUiVerified:true},nativeCollapseFilter:"PASS: expanded failure remains visible; hidden-route inspector contains no assignment control",nativeOffline:"PASS: source cleared and disconnected notice visible",webPathEvidence:{ref:failed.canonicalEventId,steps:3},realProvider:'NOT_RUN',oppositeHostReview:'NOT_RUN',phoneExistingApps:'PRESERVED: ordinary and join590review not modified'},null,2)+'\n');
 console.log(JSON.stringify({sourceSha,cityId:app.store.cityId,physicalNative:'PASS',nativeRiskSteps:2,nativePathSteps:3,riskInteractions,pathInteractions,webPathSteps:3,visibleNodes:graph.visibleNodeIds.length,clusters:graph.clusters.length}));
}finally{await browser?.close();await device('shell','am','force-stop',pkg);if(port)await device('reverse','--remove','tcp:'+port);await app?.close();await rm(dir,{recursive:true,force:true})}
