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
