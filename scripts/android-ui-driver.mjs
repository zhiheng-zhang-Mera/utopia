import {execFileSync} from 'node:child_process';
export const adb=process.env.ADB||'adb';
export const cmd=(...args)=>execFileSync(adb,args,{timeout:30000,maxBuffer:12*1024*1024}).toString();
export const pause=ms=>new Promise(r=>setTimeout(r,ms));
const decode=s=>s.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export function parseTree(xml){const nodes=[],stack=[];for(const m of xml.matchAll(/<node\b([^>]*?)(\/?)>|<\/node>/g)){if(m[0]==='</node>'){stack.pop();continue;}const n={parent:stack.at(-1),children:[]};for(const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g))n[a[1]]=decode(a[2]);n.box=(n.bounds?.match(/\d+/g)??[]).map(Number);if(n.parent)n.parent.children.push(n);nodes.push(n);if(!m[2])stack.push(n);}return nodes;}
export async function tree(){
 const activity=cmd('shell','dumpsys','activity','activities');if(/mResumedActivity[^\n]*CaptureActivity/.test(activity))throw Error('CAMERA_CAPTURE_PROHIBITED');
 for(let i=0;i<3;i++)try{cmd('shell','uiautomator','dump','/sdcard/utopia-services-ui.xml');return parseTree(cmd('shell','cat','/sdcard/utopia-services-ui.xml'));}catch(e){if(i===2)throw Error('UI_DUMP_UNAVAILABLE');await pause(300);}
}
const visible=n=>n.box?.length===4&&n.box[2]>n.box[0]&&n.box[3]>n.box[1];
export function tapNode(node){let n=node;while(n&&!visible(n))n=n.parent;if(!n)throw Error('NODE_NOT_VISIBLE');const b=n.box;cmd('shell','input','tap',String((b[0]+b[2])>>1),String((b[1]+b[3])>>1));}
export async function scroll(direction='down',nodes=null){nodes??=await tree();const n=nodes.find(n=>n.scrollable==='true'&&visible(n));if(!n)return false;const [x1,y1,x2,y2]=n.box,x=Math.round((x1+x2)/2),a=Math.round(y1+(y2-y1)*.2),b=Math.round(y1+(y2-y1)*.8);cmd('shell','input','swipe',String(x),String(direction==='down'?b:a),String(x),String(direction==='down'?a:b),'700');return true;}
export async function tap(text,{desc=false,attempts=5}={}){for(let i=0;i<attempts;i++){const nodes=await tree(),n=nodes.find(n=>(desc?n['content-desc']:n.text)===text&&(visible(n)||visible(n.parent)));if(n){tapNode(n);await pause(150);return;}if(i<attempts-1)await scroll('down',nodes);}throw Error('UI_TEXT_NOT_FOUND:'+text);}
export async function top(){const nodes=await tree();for(let i=0;i<3;i++)await scroll('up',nodes);}
export async function fill(label,value){let nodes=await tree();const text=n=>[n.text??'',...n.children.map(text)].join(' ');let n=nodes.find(n=>n.class==='android.widget.EditText'&&text(n).includes(label));if(!n){await scroll('down',nodes);nodes=await tree();n=nodes.find(n=>n.class==='android.widget.EditText'&&text(n).includes(label));}if(!n)throw Error('EDIT_FIELD_NOT_FOUND:'+label);tapNode(n);cmd('shell','input','keyevent',...Array(Math.max(1,n.text.length+2)).fill('22'));cmd('shell','input','keyevent',...Array(Math.max(1,n.text.length+2)).fill('67'));if(value)cmd('shell','input','text',"'"+value.replace(/ /g,'%s').replace(/'/g,"'\\''")+"'");cmd('shell','input','keyevent','4');}
export async function chooseFile(name,button='Choose document'){
 await tap(button);let nodes=await tree();const search=nodes.find(n=>['搜索','Search'].includes(n['content-desc'])&&visible(n));if(search){tapNode(search);await pause(100);cmd('shell','input','text',name);cmd('shell','input','keyevent','66');await pause(300);}
 for(let i=0;i<5;i++){nodes=await tree();const file=nodes.find(n=>n.text===name&&n.class==='android.widget.TextView'&&visible(n));if(file){tapNode(file);await pause(300);return;}await scroll('down',nodes);}throw Error('FILE_NOT_VISIBLE:'+name);
}
