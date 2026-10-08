import test from 'node:test';
import assert from 'node:assert/strict';
import {renderTerminal} from '../apps/web/terminal.js';

test('credential replacement clears a completed owner draft and ignores old in-flight replies',async()=>{
 const host={innerHTML:'',querySelector:()=>null,contains:()=>false};
 let reply;
 const oldApi=async path=>path==='ask'?await new Promise(resolve=>{reply=resolve;}):{};
 const render=(credential,api)=>renderTerminal(host,null,true,api,{page:'Ask/Do',credentialContext:credential});
 const terminal=render('owner-a',oldApi);
 terminal.submit('run git on Alien');
 render('member-b',async()=>({}));
 reply({ask:{status:'DRAFT_REQUIRED',draft:{kind:'REMOTE_OPERATION',requestText:'old owner request'}}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(host.innerHTML.includes('ask-owner-draft'),false,'old Owner reply must not survive credential replacement');
 let immediate=async path=>path==='ask'?{ask:{status:'DRAFT_REQUIRED',draft:{kind:'REMOTE_OPERATION'}}}:{};
 render('owner-c',immediate);terminal.submit('run git on Alien');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(host.innerHTML.includes('ask-owner-draft'),true);
 render('member-d',async()=>({}));
 assert.equal(host.innerHTML.includes('ask-owner-draft'),false,'completed Owner draft must be cleared');
});
