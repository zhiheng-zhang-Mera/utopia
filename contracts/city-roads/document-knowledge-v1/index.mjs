// Versioned, in-memory semantic Road. No filesystem, network, clock or store.
export const ROAD_VERSION=1;
export const MAX_DOCUMENT_SECTIONS=200;
const epoch='1970-01-01T00:00:00.000Z';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export class RoadContractError extends Error {
 constructor(code){super(code);this.code=code;this.status=400;}
}
export function validateDocumentSections(sections){
 const errors=[];
 if(!Array.isArray(sections)||sections.length>MAX_DOCUMENT_SECTIONS)return{ok:false,errors:['Expected at most 200 document sections']};
 Array.from(sections).forEach((s,i)=>{
  if(!object(s)){errors.push(`sections[${i}] must be an object`);return;}
  if(typeof s.kind!=='string'||!s.kind.trim())errors.push(`sections[${i}].kind must be nonempty text`);
  if(typeof s.text!=='string')errors.push(`sections[${i}].text must be text`);
  if(s.heading!==undefined&&typeof s.heading!=='string')errors.push(`sections[${i}].heading must be text when present`);
  if(!Number.isSafeInteger(s.start)||!Number.isSafeInteger(s.end)||s.start<0||s.end<s.start)errors.push(`sections[${i}] has invalid source bounds`);
 });
 return{ok:errors.length===0,errors};
}
export function validateTemporaryKnowledgeEntries(entries){
 const errors=[];
 if(!Array.isArray(entries)||entries.length>MAX_DOCUMENT_SECTIONS)return{ok:false,errors:['Expected at most 200 temporary entries']};
 Array.from(entries).forEach((e,i)=>{
  if(!object(e)||e.id!==`document-${i}`||typeof e.title!=='string'||typeof e.content!=='string'||e.domain!=='document'||e.shelf!=='temporary'||e.trust!=='UNVERIFIED'||e.updatedAt!==epoch||!Array.isArray(e.tags)||e.tags.length!==1||e.tags[0]!=='document')errors.push(`entries[${i}] violates the temporary document contract`);
 });
 return{ok:errors.length===0,errors};
}
export function documentSectionsToKnowledgeEntries(sections){
 if(!validateDocumentSections(sections).ok)throw new RoadContractError('INVALID_DOCUMENT_SECTIONS');
 return sections.map((s,i)=>({id:'document-'+i,title:s.heading??'Section '+(i+1),content:s.text,domain:'document',shelf:'temporary',tags:['document'],trust:'UNVERIFIED',updatedAt:epoch}));
}
