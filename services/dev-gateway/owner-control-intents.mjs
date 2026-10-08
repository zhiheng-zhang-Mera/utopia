// Natural-language owner controls prepare editable drafts. This module has no executor.
const TYPES={REMOTE_OPERATION:'OWNER_REMOTE_OPERATION',AGENT_JOB:'AGENT_JOB'};
const fail=(code,status,message)=>{const error=new Error(message);Object.assign(error,{code,status});throw error;};
const label=kind=>kind==='REMOTE_OPERATION'?'Remote operation / 远程执行':'Agent job / Agent 作业';
export function ownerControlTargets(context){
 return Object.entries(TYPES).map(([kind,operation])=>{
  const enabled=kind==='REMOTE_OPERATION'?context.remoteOperation?.enabled:context.agentJob?.enabled;
  const available=context.isOwner===true&&enabled===true;
  return {route:'CITY_TASK',target:'city.task',operation,label:label(kind),description:'Prepare an editable draft; review required fields and type confirmation before dispatch. / 先准备草稿，补齐参数并明确确认后执行。',example:kind==='REMOTE_OPERATION'?'在 Alien 上运行 git 查看版本':'让 Alien 的 Agent 检查项目测试',mutating:true,sideEffect:true,available,unavailableReason:available?null:context.isOwner!==true?'City owner required / 需要 City Owner':'Disabled by City owner / City Owner 尚未启用'};
 });
}
function quotedField(text,keys){
 const match=new RegExp('(?:'+keys+')\\s*[:=：]?\\s*("(?:\\\\.|[^"\\\\])*"|“[^”]*”|\'[^\']*\')','i').exec(text);
 if(!match)return '';
 try{return match[1].startsWith('"')?JSON.parse(match[1]):match[1].slice(1,-1);}catch{return '';}
}
function explicitArgv(text){
 const match=/\bargv\s*[:=]?\s*/i.exec(text);if(!match)return null;
 const rest=text.slice(match.index+match[0].length);let quoted=false,escape=false,depth=0;
 for(let i=0;i<rest.length;i++){
  const c=rest[i];if(escape){escape=false;continue;}if(quoted&&c==='\\'){escape=true;continue;}if(c==='"'){quoted=!quoted;continue;}
  if(!quoted){if(c==='[')depth++;if(c===']'&&--depth===0){try{const result=JSON.parse(rest.slice(0,i+1));return Array.isArray(result)&&result.every(v=>typeof v==='string')?result:[];}catch{return [];}}}
 }
 return [];
}
function nodeChoice(text,nodes){
 const explicit=quotedField(text,'device|node|设备|目标');
 const requested=explicit||/\bon\s+([\w.-]+)/i.exec(text)?.[1]||/在\s*(.*?)\s*上/.exec(text)?.[1]||/让\s*(.*?)\s*(?:的\s*)?(?:Agent|智能体)/i.exec(text)?.[1]||'';
 let matches=[];
 if(requested){const key=requested.trim().toLowerCase();const exact=nodes.filter(n=>n.id?.toLowerCase()===key||n.displayName?.toLowerCase()===key);matches=exact.length?exact:nodes.filter(n=>n.displayName?.toLowerCase().includes(key));}
 else matches=nodes.filter(n=>n.displayName&&text.toLowerCase().includes(n.displayName.toLowerCase()));
 return {targetDeviceRef:matches.length===1?matches[0].id:'',nodeMatchState:matches.length===1?'MATCHED':matches.length>1?'AMBIGUOUS':'MISSING',deviceCandidates:(matches.length?matches:nodes).map(n=>({id:n.id,displayName:n.displayName,online:n.online===true}))};
}
export function prepareOwnerControlAsk(request,context){
 const text=typeof request?.text==='string'?request.text.trim():'';
 const selected=request?.selection?.route==='CITY_TASK'&&request?.selection?.target==='city.task'?request.selection.operation:null;
 let kind=selected==='AGENT_JOB'?'AGENT_JOB':selected==='OWNER_REMOTE_OPERATION'?'REMOTE_OPERATION':null;
 if(!kind){
  if(/(?:让|请|ask|tell|let|give|send|create).*(?:\bagent\b|智能体)|(?:agent\s+job|Agent\s*作业)/i.test(text))kind='AGENT_JOB';
  else if(/远程.*(?:运行|执行|操作)|remote\s+(?:operation|run|execution)|在.*上\s*(?:运行|执行)|\b(?:run|execute|start)\s+\S+\s+on\s+/i.test(text))kind='REMOTE_OPERATION';
 }
 if(!kind)return null;
 if(text.length>1000)fail('ASK_TEXT_TOO_LONG',400,'Owner-control request must be at most 1000 characters');
 if(context.isOwner!==true)fail(kind==='AGENT_JOB'?'AGENT_JOB_OWNER_REQUIRED':'REMOTE_OPERATION_OWNER_REQUIRED',403,'These controls require the City owner');
 const target=ownerControlTargets(context).find(t=>t.operation===TYPES[kind]);
 const base={text,route:'CITY_TASK',target:'city.task',operation:TYPES[kind],candidates:[],confirmation:null,action:null,router:'DETERMINISTIC_RULES',deterministic:true,llm:false};
 if(!target.available)return {...base,status:'UNAVAILABLE',draft:null,message:target.unavailableReason};
 const choice=nodeChoice(text,context.nodes??[]);const purpose=quotedField(text,'purpose|目的');
 let operation=null,job=null,missingFields=choice.targetDeviceRef?[]:['targetDeviceRef'];
 if(kind==='REMOTE_OPERATION'){
  const executable=quotedField(text,'executable|程序')||/(?:run|execute|start|运行|执行)\s+([A-Za-z0-9_.-]+)/i.exec(text)?.[1]||'';
  const explicit=explicitArgv(text);const argv=explicit??(/(?:查看版本|--version|\bversion\b)/i.test(text)&&executable==='git'?['--version']:[]);
  operation={executable,argv,cwd:quotedField(text,'cwd|目录'),purpose};
  for(const field of ['executable','cwd','purpose'])if(!operation[field])missingFields.push(field);
  if(executable&&!(context.remoteOperation?.allowlist??[]).includes(executable))missingFields.push('allowlisted executable');
  if(explicit!==null&&explicit.length===0)missingFields.push('valid argv JSON');
 }else{
  job={title:quotedField(text,'title|标题'),instruction:quotedField(text,'instruction|指令')||/(?:\bagent\b|智能体)\s*[:：]?\s*(.+)$/i.exec(text)?.[1]||'',purpose,inputs:[]};
  for(const field of ['title','instruction','purpose'])if(!job[field])missingFields.push(field);
 }
 return {...base,status:'DRAFT_REQUIRED',message:'Nothing executed. Review the draft, fill required fields, and confirm on the control page. / 尚未执行；请检查草稿、补齐必填项并确认。',draft:{kind,requestText:text,...choice,operation,job,missingFields}};
}
