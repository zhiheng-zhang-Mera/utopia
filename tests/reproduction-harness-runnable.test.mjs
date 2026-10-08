// THE REPRODUCTION INSTRUMENT MUST RUN FROM A BARE CHECKOUT.
//
// The opposite host reproduces the study by fetching a branch and running one command. If that command needs a
// dependency installed first, the reproduction acquires a prerequisite that has nothing to do with the study - and a
// host that fails at `pnpm install` reports nothing about the City at all. So the harness is allowed Node builtins and
// nothing else, and that is checked here rather than remembered.
//
// This was a real defect and not a precaution: the harness imported `ws` for its control surface, so a fresh clone had
// to install the project before it could check anything. It now uses the global WebSocket Node ships, which differs in
// exactly one place (`on('open')` became `addEventListener('open')`), and the falsification script still passes 4/4
// because it really spawns the harness and really attaches the socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const read = file => readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');

test('HARNESS-RUNNABLE 1: the reproduction harness imports only Node builtins, so no install is needed',()=>{
  const source=read('scripts/rex890-opposite-host-reproduce.mjs');
  const specifiers=[...source.matchAll(/^\s*import\s+[^'"]*['"]([^'"]+)['"]/gm)].map(m=>m[1]);
  assert.ok(specifiers.length>0,'the harness must import something, or this check is vacuous');
  const external=specifiers.filter(s=>!s.startsWith('node:'));
  assert.deepEqual(external,[],`the harness must not depend on a package: ${external.join(', ')}`);
  // And its WebSocket must be the one Node ships, with a clear refusal when the runtime is too old to have it.
  assert.match(source,/globalThis\.WebSocket/,'the control surface must use the built-in WebSocket');
  assert.ok(!/from 'ws'/.test(source),'the ws package must not come back');
  assert.match(source,/addEventListener\('open'/,'the standard socket needs standard events, not the ws emitter API');
  assert.match(source,/Node 22 or newer/,'an old runtime must be refused by name rather than crashing obscurely');
});

test('HARNESS-RUNNABLE 2: the token comes from a FILE, never from the command line',()=>{
  // A credential on the command line lands in the process list and in shell history. The harness reads it from the
  // file named by --config (or CITY_TOKEN), and the option it documents for credentials is the file.
  const source=read('scripts/rex890-opposite-host-reproduce.mjs');
  assert.match(source,/--config <json with token>/,'the documented credential input is a file');
  assert.ok(!/flag\('token'/.test(source),'there must be no --token option');
  assert.ok(!/argv\[[^\]]*\]\s*[^;\n]*token/.test(source),'no positional argument may be read as a token');
});

test('HARNESS-RUNNABLE 3: the software identity is OBSERVED from the checkout, never hardcoded',()=>{
  // MEASURED DEFECT THIS PINS. The harness hardcoded `utopia@185d043e...` - the head the study was exported from - and
  // the manifest contract rendered it as `exact: true` on every campaign the harness started. Measured against the
  // City: a rehearsal running 6014f94 wrote a receipt declaring 185d043e with exact:true, and the campaign started
  // after the fix declares 6014f9473c698b9eebf34b25450103b079f12d7b. A reproduction instrument that states the wrong
  // software identity with `exact: true` manufactures the very provenance this programme exists to check.
  const source=read('scripts/rex890-opposite-host-reproduce.mjs');
  const refLine=source.split('\n').find(line=>line.includes('softwareRefs:'));
  assert.ok(refLine,'the manifest must carry softwareRefs');
  assert.ok(!/[0-9a-f]{40}/.test(refLine),`softwareRefs must not be a literal commit: ${refLine.trim()}`);
  // The identity is read from the checkout that is running, and the report says so.
  assert.match(source,/rev-parse',\s*\['?HEAD|'rev-parse', 'HEAD'|rev-parse HEAD/,'the identity must be read from the checkout');
  assert.match(source,/OBSERVED_FROM_CHECKOUT/,'the report must state that the identity was observed');
  assert.match(source,/treeClean/,'a dirty checkout must be recorded, not glossed over');
  // And an identity nobody can observe must STOP the execution instead of inventing one: the manifest contract demands
  // an exact 40-character ref, so there is no honest value to put there when the checkout cannot be read.
  assert.match(source,/SOFTWARE_IDENTITY_UNOBSERVABLE/,'an unobservable identity must refuse the execution');
  assert.match(source,/if \(!softwareHead\)/,'the refusal must actually gate the execution');
});

test('HARNESS-RUNNABLE 4: the mesh is the devices the runs named, not every node the City had registered',()=>{
  // MEASURED DEFECT THIS PINS. The harness read the host list straight out of the package's topology and declared a
  // TWO_HOST_MESH from it. A package exported while a THIRD node happened to be registered therefore listed three
  // nodes, and the City refused the manifest with TOPOLOGY_IMPOSSIBLE/hosts - so the independent execution never ran,
  // and the refusal described the City's node roster rather than anything about the reproduction. The devices that
  // actually executed the study's runs are the mesh the study used.
  const source=read('scripts/rex890-opposite-host-reproduce.mjs');
  assert.match(source,/rebuilt\.map\(r => r\.assignedNodeId\)/,'the mesh must be derived from the runs that executed');
  assert.match(source,/TOPOLOGY_NOT_FORMABLE_FROM_EVIDENCE/,'an unformable mesh must be named, not forced');
  assert.ok(!/const nodes = \(topology\?\.nodes \?\? \[\]\)\.map/.test(source),'the topology roster must not be the mesh');
});
