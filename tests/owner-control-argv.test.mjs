import test from 'node:test';
import assert from 'node:assert/strict';
const view=await import('../apps/web/remote-operation.js');
import {prepareOwnerControlAsk} from '../services/dev-gateway/owner-control-intents.mjs';
test('Web argv JSON preserves empty args, whitespace, punctuation and quoted newlines',()=>{
 assert.equal(typeof view.parseRemoteArgv,'function');
 assert.deepEqual(view.parseRemoteArgv('["", "a; b", " line\\nbreak "]'),['','a; b',' line\nbreak ']);
 assert.deepEqual(view.parseRemoteArgv('-e\nprocess.exit(0)'),['-e','process.exit(0)']);
 assert.throws(()=>view.parseRemoteArgv('[7]'));assert.throws(()=>view.parseRemoteArgv('[broken]'));
});
test('an explicit empty argv is valid and does not require invented arguments',()=>{
 const out=prepareOwnerControlAsk({text:'run git on Alien; argv []'},{isOwner:true,nodes:[{id:'a',displayName:'Alien'}],remoteOperation:{enabled:true,allowlist:['git']}});
 assert.deepEqual(out.draft.operation.argv,[]);assert.ok(!out.draft.missingFields.includes('valid argv JSON'));
});
