import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
const adb=process.env.ADB||'adb';
const cmd=(...args)=>execFileSync(adb,args,{maxBuffer:8*1024*1024});
mkdirSync('.runtime/evidence',{recursive:true});
const [action,arg]=process.argv.slice(2);
if(action==='tree'||action==='tap'){
 cmd('shell','uiautomator','dump','/sdcard/utopia-ui.xml');
 const xml=cmd('shell','cat','/sdcard/utopia-ui.xml').toString();
 writeFileSync('.runtime/evidence/ui.xml',xml);
 if(action==='tree'&&arg)writeFileSync('.runtime/evidence/'+arg+'.xml',xml);
 const nodes=[...xml.matchAll(/<node\s+([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));
 if(action==='tree')console.log(nodes.filter(n=>n.text||n['content-desc']||n.class==='android.widget.EditText').map(n=>({text:n.password==='true'?'[password]':n.text,description:n['content-desc'],class:n.class,bounds:n.bounds})));else{
 const node=nodes.find(n=>n.text===arg||n['content-desc']===arg);if(!node)throw new Error('UI target not found: '+arg);const b=node.bounds.match(/\d+/g).map(Number);cmd('shell','input','tap',String(Math.floor((b[0]+b[2])/2)),String(Math.floor((b[1]+b[3])/2)));console.log('Tapped '+arg);
 }
}else if(action==='screenshot'){writeFileSync('.runtime/evidence/'+(arg||'android')+'.png',cmd('exec-out','screencap','-p'));console.log('Screenshot saved');}
else if(action==='pair'){
 // Typing goes through the real Settings UI; token is never printed or committed.
 const config=JSON.parse(readFileSync('.runtime/local-config.json'));
 cmd('shell','input','text',config.token);console.log('Pairing token entered');
}else throw new Error('Use tree, tap, screenshot or pair');
