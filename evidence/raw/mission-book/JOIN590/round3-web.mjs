import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
let input='';for await(const chunk of process.stdin)input+=chunk;
const {host,token}=JSON.parse(input);
const id='Q-24ebb6d9-ea60-47bc-944b-e7e4da530819';
const sha='1d75256ecf08d63f10f8fe9832a7a2f2212cf78d6b55498d7e0a909e4b6eec1b';
if(host!=='http://172.31.12.151:4391')throw new Error('Unexpected proof origin');
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();
 await page.goto(host,{waitUntil:'domcontentloaded'});
 if(new URL(page.url()).origin!==host)throw new Error('Unexpected browser origin');
 await page.evaluate(({token})=>{sessionStorage.setItem('city-token',token);localStorage.setItem('utopia.clientLabel','Alien-codex JOIN590 review');},{token});
 await page.reload({waitUntil:'domcontentloaded'});
 await page.locator(`[data-task="${id}"]`).first().waitFor({timeout:20000});
 await page.locator(`[data-task="${id}"]`).first().click();
 const detail=page.locator('#detail');await detail.waitFor();
 const text=await detail.innerText();
 const canonical=await page.evaluate(async({token,id})=>{
  const h={Authorization:'Bearer '+token,'X-City-Api-Version':'0','X-City-Schema-Version':'0'};
  const r=await fetch('/api/v0/tasks/'+id,{headers:h});const task=await r.json();
  const e=await(await fetch('/api/v0/events',{headers:h})).json();
  return {status:r.status,id:task.id,state:task.state,assignedNodeId:task.assignedNodeId,result:task.result,events:e.events.filter(e=>e.taskId===id).map(e=>({seq:e.seq,type:e.type,taskId:e.taskId}))};
 },{token,id});
 const proof={origin:new URL(page.url()).origin,browserTaskIdVisible:text.includes(id),browserResultHashVisible:text.includes(sha),browserResultStateVisible:/COMPLETED|完成/.test(text),canonical};
 await writeFile('.runtime/evidence/JOIN590-device/round3-web-task-proof.json',JSON.stringify(proof,null,2));
 await detail.screenshot({path:'.runtime/evidence/JOIN590-device/round3-web-task.png'});
 console.log(JSON.stringify(proof));
}finally{await browser.close();}
