import { chromium } from 'playwright';
import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
const config=JSON.parse(readFileSync('.runtime/local-config.json'));
const {url}=JSON.parse(readFileSync('.runtime/processes.json'));
const browser=await chromium.launch({channel:'msedge',headless:false});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
await page.goto(url);await page.getByLabel('Pairing token').fill(config.token);await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByText('ONLINE',{exact:true}).waitFor();
mkdirSync('.runtime/evidence',{recursive:true});
await page.screenshot({path:'.runtime/evidence/web-home.png',fullPage:true});
const existing=page.getByRole('button',{name:/Q-/});
if(await existing.count()){await existing.first().click();await page.screenshot({path:'.runtime/evidence/web-task.png',fullPage:true});writeFileSync('.runtime/evidence/web-task-ui.txt',await page.locator('#detail').innerText());}
writeFileSync('.runtime/browser-ready.json',JSON.stringify({url,connected:true}));
console.log('Visible Web Control Surface connected');
// Keep this real browser surface open through physical-device acceptance.
process.on('SIGINT',async()=>{await browser.close();process.exit();});
setInterval(async()=>{try{await page.screenshot({path:'.runtime/evidence/web-live.png',fullPage:true});const data=await page.evaluate(async()=>{const r=await fetch('/api/v0/city',{headers:{Authorization:'Bearer '+sessionStorage.getItem('city-token'),'X-City-Api-Version':'0','X-City-Schema-Version':'0'}});return r.json();});writeFileSync('.runtime/evidence/web-snapshot.json',JSON.stringify(data,null,2));}catch{}},4000);
