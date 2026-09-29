import {chromium} from 'playwright';
import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
const config=JSON.parse(readFileSync('.runtime/local-config.json'));
const {url}=JSON.parse(readFileSync('.runtime/processes.json'));
const browser=await chromium.launch({channel:'msedge',headless:false});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
await page.goto(url+'/pairing');
await page.getByLabel('Pairing token').fill(config.token);
await page.getByRole('button',{name:'Connect',exact:true}).click();
await page.locator('#generate-pairing').waitFor();
// Private transient IPC. Never capture screenshots or print pairing material.
page.on('response',async response=>{if(response.url().endsWith('/pairing/session')&&response.ok())writeFileSync('.runtime/active-pairing.json',JSON.stringify(await response.json()));});
await page.locator('#generate-pairing').click();
console.log('Pairing display ready; no screenshots or secret output.');
setInterval(async()=>{if(existsSync('.runtime/refresh-pairing')){unlinkSync('.runtime/refresh-pairing');await page.locator('#generate-pairing').click();console.log('Session refreshed');}},500);
process.on('SIGINT',async()=>{if(existsSync('.runtime/active-pairing.json'))unlinkSync('.runtime/active-pairing.json');await browser.close();process.exit();});
