import test from 'node:test';
import assert from 'node:assert/strict';
import {documentSectionsToKnowledgeEntries,validateDocumentSections,validateTemporaryKnowledgeEntries} from '../index.mjs';

test('Road rejects missing array elements instead of producing null serialized entries',()=>{
 for(const sparse of [new Array(1),new Array(200)]){
  assert.equal(validateDocumentSections(sparse).ok,false);
  assert.equal(validateTemporaryKnowledgeEntries(sparse).ok,false);
  assert.throws(()=>documentSectionsToKnowledgeEntries(sparse),{code:'INVALID_DOCUMENT_SECTIONS'});
 }
});

test('Road preserves section order, deterministic IDs and explicit temporary unverified ownership',()=>{
 const sections=Object.freeze([Object.freeze({kind:'HEADING',heading:'Public note',text:'Utopia',start:0,end:6}),Object.freeze({kind:'PARAGRAPH',text:'Second',start:7,end:13})]);
 const expected=[{id:'document-0',title:'Public note',content:'Utopia',domain:'document',shelf:'temporary',tags:['document'],trust:'UNVERIFIED',updatedAt:'1970-01-01T00:00:00.000Z'},{id:'document-1',title:'Section 2',content:'Second',domain:'document',shelf:'temporary',tags:['document'],trust:'UNVERIFIED',updatedAt:'1970-01-01T00:00:00.000Z'}];
 const a=documentSectionsToKnowledgeEntries(sections),b=documentSectionsToKnowledgeEntries(sections);
 assert.deepEqual(a,expected);assert.deepEqual(b,expected);assert.notEqual(a,b);assert.equal(validateTemporaryKnowledgeEntries(a).ok,true);
 a[0].tags.push('local edit');assert.deepEqual(documentSectionsToKnowledgeEntries(sections),expected,'no shared mutable output or hidden store');
});
test('Road accepts empty documents and preserves empty heading and text without coercion',()=>{
 assert.deepEqual(documentSectionsToKnowledgeEntries([]),[]);
 const [entry]=documentSectionsToKnowledgeEntries([{kind:'PARAGRAPH',heading:'',text:'',start:0,end:0,level:1}]);assert.equal(entry.title,'');assert.equal(entry.content,'');
});
test('Road refuses malformed document boundaries and never accepts caller trust injection',()=>{
 for(const value of [null,{},[null],[{kind:'PARAGRAPH',text:42,start:0,end:1}],[{kind:'PAGE',text:'a',start:-1,end:1}],[{kind:'PAGE',text:'a',start:2,end:1}],[{kind:'PAGE',text:'a',start:0,end:1.2}],[{kind:'PAGE',text:'a',start:0,end:1,heading:123}]]){
  assert.equal(validateDocumentSections(value).ok,false);assert.throws(()=>documentSectionsToKnowledgeEntries(value),{code:'INVALID_DOCUMENT_SECTIONS'});
 }
 const entries=documentSectionsToKnowledgeEntries([{kind:'PAGE',text:'public',start:0,end:1,trust:'HIGH',domain:'private',shelf:'permanent',id:'injected'}]);assert.equal(entries[0].trust,'UNVERIFIED');assert.equal(entries[0].shelf,'temporary');assert.equal(entries[0].id,'document-0');
});
test('Road output validation rejects permanence, trust escalation and reordered IDs',()=>{
 const entries=documentSectionsToKnowledgeEntries([{kind:'PAGE',text:'public',start:0,end:1}]);
 for(const patch of [{trust:'HIGH'},{shelf:'permanent'},{domain:'other'},{id:'document-1'},{updatedAt:'today'},{tags:['other']},{content:3}])assert.equal(validateTemporaryKnowledgeEntries([{...entries[0],...patch}]).ok,false);
});
