/**
 * UI-000 · candidate surface contract.
 *
 * Guards the temporary Owner-gate candidate surface (apps/web/candidates/):
 *
 *  1. the canonical facts module is internally consistent;
 *  2. every parity probe targets a real capability on a real surface;
 *  3. each candidate is a real, complete page set and uses NO Unicode/ASCII
 *     geometry glyph as an icon (a UI-000 hard rule);
 *  4. the three candidates are genuinely different, not one template recoloured;
 *  5. the candidate surface is isolated — the production Web shell must not
 *     reference it;
 *  6. the Room Hub theme skins exist and stay presentation-only.
 *
 * This test retires together with apps/web/candidates/ (see ./README.md there).
 * If the directory is gone AND the production shell is clean, it skips instead of
 * failing, so a later cleanup task cannot leave a permanently red suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CANDIDATES = resolve(ROOT, 'apps/web/candidates');
const PRESENT = existsSync(CANDIDATES);

const load = async (p) => readFile(resolve(ROOT, p), 'utf8');

test('UI-000 canonical facts are internally consistent', async () => {
  const facts = await import('../apps/web/candidates/shared/facts.js');
  const ids = facts.SURFACES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'surface ids must be unique');
  assert.deepEqual(facts.REQUIRED_SURFACES, ids);
  assert.equal(facts.PRIMARY_SURFACES.length + facts.ADVANCED_SURFACES.length, facts.SURFACES.length);

  const caps = facts.CAPABILITIES.map((c) => c.id);
  assert.equal(new Set(caps).size, caps.length, 'capability ids must be unique');
  for (const cap of facts.CAPABILITIES) {
    assert.ok(ids.includes(cap.surface), `${cap.id} is bound to unknown surface ${cap.surface}`);
    assert.ok(cap.label && cap.zh, `${cap.id} needs a bilingual label`);
  }
  for (const field of facts.TECHNICAL_FIELDS) {
    assert.ok(field.owners.length > 0, `${field.id} must be reachable from some capability`);
    for (const owner of field.owners) {
      assert.ok(caps.includes(owner), `${field.id} owner ${owner} is not a capability`);
    }
  }
  /* The demo snapshot must be shaped like the real Gateway payloads. */
  assert.equal(facts.DEMO.rooms.rooms.length, 10, 'the Room Pack has ten accepted rooms');
  assert.equal(facts.DEMO.rooms.count, 10);
  const room = facts.DEMO.rooms.rooms[0];
  for (const key of ['id', 'number', 'label', 'zh', 'summary', 'persistent', 'lifecycle']) {
    assert.ok(key in room, `room payload is missing ${key}`);
  }
  assert.ok(Array.isArray(facts.DEMO.city.nodes) && facts.DEMO.city.nodes.length > 0);
  assert.ok(Array.isArray(facts.DEMO.city.events));
  for (const state of ['confirmed', 'needsChoice', 'ambiguous', 'unmatched', 'working']) {
    assert.ok(facts.DEMO.ask[state], `ask state ${state} missing from the demo snapshot`);
  }
});

test('UI-000 parity probes only reference real surfaces and capabilities', async () => {
  const facts = await import('../apps/web/candidates/shared/facts.js');
  const probes = await import('../apps/web/candidates/shared/parity-probes.js');
  const surfaces = new Set(facts.REQUIRED_SURFACES);
  const caps = new Set(facts.REQUIRED_CAPABILITIES);
  assert.ok(probes.SURFACE_PROBES.length > 0);
  for (const probe of probes.SURFACE_PROBES) {
    assert.ok(surfaces.has(probe.surface), `probe targets unknown surface ${probe.surface}`);
    assert.ok(caps.has(probe.cap), `probe targets unknown capability ${probe.cap}`);
    assert.ok(probe.expect.length > 0);
  }
  for (const probe of probes.TECHNICAL_PROBES) {
    assert.ok(caps.has(probe.cap), `technical probe targets unknown capability ${probe.cap}`);
  }
  /* Every capability must be covered by at least one probe, or parity is a claim. */
  const covered = new Set([
    ...probes.SURFACE_PROBES.map((p) => p.cap),
    ...probes.TECHNICAL_PROBES.map((p) => p.cap),
  ]);
  for (const id of facts.REQUIRED_CAPABILITIES) {
    if (id.startsWith('ask-')) continue; /* covered by the ask-state probes */
    assert.ok(covered.has(id), `capability ${id} has no parity probe`);
  }
  /* Every shared-runtime action must be probed, or a dead control can return. */
  const runtime = await import('../apps/web/candidates/shared/runtime.js');
  for (const action of runtime.ACTIONS) {
    assert.ok(probes.ACTION_PROBES.some((p) => p.action === action), `runtime action ${action} has no action probe`);
  }
});

test('UI-000 candidates are real, glyph-free and genuinely different', { skip: !PRESENT && 'candidate surface retired' }, async () => {
  const facts = await import('../apps/web/candidates/shared/facts.js');
  const probes = await import('../apps/web/candidates/shared/parity-probes.js');
  const entries = await readdir(CANDIDATES, { withFileTypes: true });
  const found = entries.filter((e) => e.isDirectory() && facts.CANDIDATE_IDS.includes(e.name)).map((e) => e.name);
  assert.deepEqual(found.sort(), [...facts.CANDIDATE_IDS].sort(), 'every declared candidate must exist');

  const styling = {};
  for (const id of facts.CANDIDATE_IDS) {
    const html = await load(`apps/web/candidates/${id}/index.html`);
    const css = await load(`apps/web/candidates/${id}/${id}.css`);
    const js = await load(`apps/web/candidates/${id}/app.js`);

    assert.match(html, new RegExp(`data-candidate="${id}"`), `${id}: html must declare its candidate id`);
    assert.match(html, new RegExp(`href="\\./${id}\\.css"`), `${id}: html must link its stylesheet`);
    assert.match(html, /href="\.\.\/shared\/favicon\.svg"/, `${id}: html must reference the shared icon`);
    assert.match(html, /type="module" src="\.\/app\.js"/, `${id}: html must load its module`);
    assert.match(js, /surfaces:\s*SURFACES\.map/, `${id}: app must declare the full surface set`);
    assert.match(js, /revealAll/, `${id}: app must expose the demoted-value reveal hook`);
    /* A control that renders but does nothing is a false affordance, and it turns
       "same functional facts" into a claim. Review found 17 of them. */
    assert.ok(!/=>\s*\{\s*\}/.test(js), `${id}: contains a control with an empty handler (dead control)`);
    assert.match(js, /from '\.\.\/shared\/runtime\.js'/, `${id}: every control must act on the shared runtime`);

    for (const source of [html, css, js]) {
      for (const glyph of probes.FORBIDDEN_GLYPHS) {
        assert.ok(!source.includes(glyph), `${id}: Unicode geometry glyph ${glyph} used as an icon`);
      }
    }
    /* A real icon system, not glyphs. */
    assert.ok(js.includes("from '../shared/icons.js'"), `${id}: must use the shared SVG icon set`);

    const root = /:root\s*\{([\s\S]*?)\}/.exec(css);
    assert.ok(root, `${id}: stylesheet must define a token block`);
    const token = (name) => new RegExp(`--${name}:\\s*([^;]+);`).exec(root[1])?.[1].trim();
    styling[id] = { bg: token('bg') ?? token('paper'), accent: token('accent'), radius: token('radius') };
    assert.ok(styling[id].bg, `${id}: must define a background token`);
    assert.ok(styling[id].accent, `${id}: must define an accent token`);
  }

  /* "明显不同，而非换色": background, accent and shape must all differ pairwise. */
  for (const key of ['bg', 'accent', 'radius']) {
    const values = facts.CANDIDATE_IDS.map((id) => styling[id][key]);
    assert.equal(new Set(values).size, values.length, `candidates share a ${key}: ${values.join(', ')} — that is a recolour, not a direction`);
  }
});

test('UI-000 candidate surface is isolated from the production shell', async () => {
  const shell = await load('apps/web/index.html');
  const shellJs = await load('apps/web/app.js');
  for (const source of [shell, shellJs]) {
    assert.ok(!source.includes('candidates'), 'the production Web shell must not reference the candidate surface');
  }
  assert.equal(existsSync(resolve(ROOT, 'apps/web/candidates/index.html')), PRESENT,
    'the candidate chooser must exist exactly when the surface exists');
});

test('UI-000 Room Hub theme skins are presentation-only', { skip: !PRESENT && 'candidate surface retired' }, async () => {
  const hub = await load('apps/rooms/hub/public/index.html');
  for (const id of ['a', 'b', 'c']) {
    const css = await load(`apps/rooms/hub/public/themes/${id}.css`);
    assert.match(css, /--bg:/, `${id}: theme must override the hub background token`);
    assert.match(css, /--accent:/, `${id}: theme must override the hub accent token`);
    /* A theme may only restyle; it must not reach into room behaviour. */
    assert.ok(!/display:\s*none\s*!important/.test(css), `${id}: theme must not hide product UI`);
    assert.ok(!/position:\s*fixed/.test(css), `${id}: theme must not reposition the shell`);
  }
  assert.match(hub, /themes\/' \+ id \+ '\.css'/, 'the hub must load a theme when ?theme= is present');
  for (const id of ['a', 'b', 'c']) {
    assert.ok(hub.includes(`id !== '${id}'`), `the hub must accept theme ${id}`);
  }
});
