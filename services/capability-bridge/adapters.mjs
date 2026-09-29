import {fileBytes,refuse,objectInput,MAX_FILE_BYTES,digest} from '../../contracts/capability-bridge-v1/protocol.mjs';
const base=new URL('../../city/',import.meta.url);
const moduleAt=path=>import(new URL(path,base));

export async function invokeAdapter(id,operation,input){
 objectInput(input);
 switch(id){
  case 'planning.document.intake':return document(input);
  case 'planning.knowledge.query':return knowledge(input,operation);
  case 'engineering.skill.inspect':return skill(input,operation);
  case 'research.evidence.review':return evidence(input,operation);
  case 'presentation.theme.lab':if(operation!=='generate')refuse('OPERATION_BLOCKED');return theme(input);
  default:refuse('CAPABILITY_NOT_FOUND');
 }
}
async function document(input){
 const bytes=fileBytes(input),fileName=String(input.fileName??'document.txt').replace(/^.*[\\/]/,'').slice(0,200);
 const ext=fileName.split('.').at(-1).toLowerCase();
 const c=await moduleAt('09-planning-knowledge/02-document-intake/ingestion-core/ingestion-core.mjs');
 const prefix='09-planning-knowledge/02-document-intake/document-readers/';
 let sections=[],warnings=[],encoding='binary',stats={},format=ext;
 const limits={maxBytes:MAX_FILE_BYTES,maxTotalBytes:8*1024*1024,maxEntryBytes:4*1024*1024,maxPages:40,maxRowsPerSheet:2000,maxColumns:64,maxEntries:256};
 if(ext==='docx'){const r=await(await moduleAt(prefix+'docx.mjs')).extractDocx(bytes,limits);sections=r.paragraphs.map((p,i)=>({kind:'PARAGRAPH',text:typeof p==='string'?p:p.text,start:i,end:i+1}));warnings=r.warnings??[];}
 else if(ext==='xlsx'){const r=await(await moduleAt(prefix+'xlsx.mjs')).extractXlsx(bytes,limits);sections=c.parseTextSections(r.markdown);warnings=r.warnings??[];stats={sheets:r.sheets.length};}
 else if(ext==='pdf'){const r=await(await moduleAt(prefix+'pdf.mjs')).extractPdf(bytes,limits);sections=r.pages.map((p,i)=>({kind:'PAGE',text:p.text,start:i,end:i+1}));warnings=r.warnings??[];stats={pages:r.pages.length};}
 else{
  const decoded=c.decodeText(bytes);encoding=decoded.encoding;warnings=decoded.warnings;const detected=c.detectFormat(fileName);format=detected.format;
  if(detected.kind==='unknown')refuse('UNSUPPORTED_FORMAT');
  if(detected.kind==='structured'){const r=await c.ingestStructured(decoded.text,fileName);if(!r.ok)refuse(r.code==='INTERNAL_ERROR'?'CORRUPT_INPUT':r.code);sections=r.sections;warnings.push(...r.warnings);}
  else if(detected.kind==='table')sections=c.sectionsFromDelimited(c.parseDelimited(decoded.text,{delimiter:c.detectDelimiter(decoded.text,fileName)}));
  else if(detected.kind==='markup')sections=c.parseXmlText(decoded.text).sections;
  else sections=c.parseTextSections(decoded.text);
 }
 // Readers own parsing. The bridge only normalizes their consumer envelope.
 return{fileName,format,encoding,sections,warnings,stats:{...stats,bytes:bytes.length,sections:sections.length},inputDigest:digest(input.base64)};
}
async function knowledge(input,operation){
 const c=await moduleAt('09-planning-knowledge/01-knowledge-service/knowledge-core/retrieval/knowledge-core.mjs');
 let entries=input.entries??[];
 if(operation==='fromDocument'){
  if(!Array.isArray(input.document?.sections))refuse('DOCUMENT_REQUIRED');
  entries=input.document.sections.map((s,i)=>({id:'document-'+i,title:s.heading??'Section '+(i+1),content:String(s.text??''),domain:'document',shelf:'temporary',tags:['document'],trust:'UNVERIFIED',updatedAt:'1970-01-01T00:00:00.000Z'}));
 }
 if(!Array.isArray(entries)||entries.length>200)refuse('INVALID_ENTRIES');
 for(const e of entries){if(!e||typeof e.id!=='string'||typeof e.title!=='string'||typeof e.content!=='string'||!Array.isArray(e.tags)||!e.tags.every(t=>typeof t==='string')||!(e.trust in c.TRUST_ORDER))refuse('INVALID_ENTRY');}
 const budget=Number(input.budget??8000);if(!Number.isInteger(budget)||budget<1||budget>50000)refuse('INVALID_BUDGET');
 const query={maxChars:budget};if(input.trustFloor)query.trustAtLeast=input.trustFloor;if(input.domain)query.domain=input.domain;if(input.tags)query.tags=input.tags;
 if(query.trustAtLeast&&!(query.trustAtLeast in c.TRUST_ORDER))refuse('INVALID_TRUST');
 const r=c.planRetrieval(String(input.query??''),entries,query);
 return{matches:r.entries,query:r.query,metadata:c.conflictReport(entries),temporary:true,budgetSemantics:'Donor retains the first match even when it alone exceeds the character budget.'};
}
async function skill(input,operation){
 const prefix='02-engineering/02-worker-gateway/skill-intake/';
 if(operation==='catalog')return(await moduleAt(prefix+'catalog.mjs')).createCatalog().search({query:String(input.query??''),includeLive:input.includeLive===true});
 if(operation==='validate'){const r=(await moduleAt(prefix+'format.mjs')).parseSkillText(String(input.text??''));if(!r.ok)refuse('INVALID_SKILL');return r;}
 if(operation==='archive'){
  let buffer=fileBytes(input);if(buffer[0]===31&&buffer[1]===139){const {gunzipSync}=await import('node:zlib');try{buffer=gunzipSync(buffer,{maxOutputLength:4*1024*1024});}catch{refuse('UNSAFE_ARCHIVE');}}
  try{const c=await moduleAt(prefix+'archive.mjs'),f=await moduleAt(prefix+'format.mjs');c.readEntries(buffer,{rejectUnsafePaths:true});const result=c.inspectArchive({buffer,stripComponents:0,maxBytes:MAX_FILE_BYTES,parseDocument:f.parseSkillText});if(result.refusedCount)refuse('UNSAFE_ARCHIVE');return result;}catch{refuse('UNSAFE_ARCHIVE');}
 }
 const c=await moduleAt(prefix+'source.mjs');let ref;try{if(/(^|[\\/])\.\.([\\/]|$)/.test(decodeURIComponent(String(input.ref??'')+'/'+String(input.subpath??''))))refuse('INVALID_REFERENCE');const parsed=c.parseGithubReference(String(input.ref??''));if(!parsed.ok)refuse('INVALID_REFERENCE');ref=parsed.ref;if(input.subpath)ref.subpath=c.normalizeSubpath(input.subpath);if(ref.subpath)c.normalizeSubpath(ref.subpath);}catch{refuse('INVALID_REFERENCE');}
 if(!ref||ref.ok===false)refuse('INVALID_REFERENCE');const plan=c.resolutionPlan(ref);if(!plan.ok)refuse('INVALID_REFERENCE');return{normalizedRef:ref,resolutionPlan:plan,description:c.describeRef(ref),resolvable:true,installationSupported:false};
}
async function evidence(input,operation){
 const c=await moduleAt('06-research/01-research-institute/evidence-engine/evidence-engine.mjs');
 let task=input.task,artifacts=input.artifacts,disputes=input.disputes??[];
 if(input.sample!==true&&!task)refuse('TASK_REQUIRED');
 if(input.sample===true){task={id:'sample-review',prompt:'Review generated public sample',providerIds:['sample-provider']};const content='Generated sample artifact; no external truth claim.';const synthesis=JSON.stringify({claims:[{text:'The sample cites a generated artifact.',evidenceLabels:['Proposal A']}]});artifacts=[{id:'sample-a',taskId:task.id,providerId:'sample-provider',kind:'proposal',content,contentHash:c.sha256(content),capturedAt:'2026-01-01T00:00:00.000Z'},{id:'sample-s',taskId:task.id,providerId:'sample-provider',kind:'synthesis',content:synthesis,contentHash:c.sha256(synthesis),capturedAt:'2026-01-01T00:00:00.000Z'}];}
 if(!Array.isArray(artifacts)||artifacts.length>100)refuse('INVALID_ARTIFACTS');
 if(operation==='tamper'){artifacts=structuredClone(artifacts);if(!artifacts[0]?.contentHash)refuse('STORED_HASH_REQUIRED');artifacts[0].content+=' altered';}
 let counter=0;const bundle=c.buildEvidenceBundle({task,artifacts,disputes,idFactory:()=>`claim-${++counter}`,now:()=> '2026-01-01T00:00:00.000Z'});
 return{bundle,summary:c.describeBundle(bundle),scope:'Integrity and declared references only; claims are not externally verified.'};
}
async function theme(input){
 const prefix='11-entertainment/01-entertainment-centre/theme-engine/';
 const palette={base:'#0f1115',layer1:'#151922',layer2:'#1b2130',accent:'#4d93f8',accent2:'#7aa7ff',label:'#e8ecf3',...input.palette};
 if(!Object.values(palette).every(v=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)))refuse('INVALID_PALETTE');
 const style=String(input.style??'research'),seed=String(input.seed??'utopia').slice(0,100);
 const factory=await moduleAt(prefix+'assets/procedural/factory.mjs'),png=await moduleAt(prefix+'raster/png.mjs'),contract=await moduleAt(prefix+'contract/contract.mjs'),validator=await moduleAt(prefix+'validation/validator.mjs');
 const tokens={...contract.defaultTokens(),'color.bg.base':palette.base,'color.bg.layer1':palette.layer1,'color.bg.layer2':palette.layer2,'color.accent.primary':palette.accent,'color.label.primary':palette.label};
 const readability=validator.validateReadability(tokens),overlay=validator.validateOverlayPlan(input.overlay??{}),surfaces=validator.validateSurfacePlan(input.surfaces??{surfaces:[]});
 const validation=validator.summarize([...validator.validateTokens(tokens),...readability,...overlay,...surfaces]);
 const previewPngBase64=png.canvasToPng(factory.renderWallpaper({palette,style,seed,width:384,height:216})).toString('base64');
 return{palette,style,seed,tokens,previewPngBase64,validation,readability,overlay,protectedSurface:surfaces,globalApply:false,builder:'DEFERRED_SCOPE_ALLOCATION'};
}
