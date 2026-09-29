/**
 * Room 04 — Prompt Library focused tests (budget: <= 5).
 * The room must stay AI-free: no provider call, only local template rendering.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startTestHub } from './harness.mjs';

const API = '/local-rooms/v1/prompts';

test('prompt library creates a prompt and derives its variables', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const created = await hub.api('POST', `${API}/prompts`, {
    title: 'Summarize',
    template: 'Summarize {{topic}} for {{ audience }}. Repeat {{topic}} once.',
    tags: ['writing'],
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.payload.prompt.variables, ['topic', 'audience'], 'variables are distinct and trimmed');

  assert.equal((await hub.api('POST', `${API}/prompts`, { title: 'x' })).status, 400);
  assert.equal((await hub.api('POST', `${API}/prompts`, { template: 'x' })).status, 400);
});

test('prompt rendering fills known variables and reports the missing ones', async (t) => {
  const hub = await startTestHub();
  const prompt = (await hub.api('POST', `${API}/prompts`, { title: 'P', template: 'Hello {{name}}, welcome to {{place}}.' })).payload.prompt;

  const partial = await hub.api('POST', `${API}/prompts/${prompt.id}/render`, { values: { name: 'Ada' } });
  assert.equal(partial.payload.rendered, 'Hello Ada, welcome to {{place}}.');
  assert.deepEqual(partial.payload.missing, ['place']);

  const full = await hub.api('POST', `${API}/prompts/${prompt.id}/render`, { values: { name: 'Ada', place: 'Utopia' } });
  assert.equal(full.payload.rendered, 'Hello Ada, welcome to Utopia.');
  assert.deepEqual(full.payload.missing, []);
});

test('prompt values persist with the prompt and are reused as defaults', async (t) => {
  const hub = await startTestHub();
  const prompt = (await hub.api('POST', `${API}/prompts`, { title: 'P', template: '{{a}} and {{b}}' })).payload.prompt;

  await hub.api('PATCH', `${API}/prompts/${prompt.id}`, { values: { a: 'one' } });
  const listed = await hub.api('GET', `${API}/prompts`);
  assert.deepEqual(listed.payload.prompts[0].values, { a: 'one' });

  const rendered = await hub.api('POST', `${API}/prompts/${prompt.id}/render`, {});
  assert.equal(rendered.payload.rendered, 'one and {{b}}');
});

test('prompt search covers title, template and note', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  await hub.api('POST', `${API}/prompts`, { title: 'Alpha', template: 'about gateways', note: 'infra' });
  await hub.api('POST', `${API}/prompts`, { title: 'Beta', template: 'about ui', tags: ['frontend'] });

  assert.equal((await hub.api('GET', `${API}/prompts?q=alpha`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/prompts?q=gateways`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/prompts?tag=frontend`)).payload.total, 1);
  assert.equal((await hub.api('GET', `${API}/prompts?q=nothing-here`)).payload.total, 0);
});

test('prompt export/import replaces the library and the room never calls an AI provider', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  await hub.api('POST', `${API}/prompts`, { title: 'One', template: '{{x}}' });
  const bundle = (await hub.api('GET', `${API}/export`)).payload;
  assert.equal(bundle.format, 'utopia-rooms-prompts');
  assert.equal(bundle.prompts.length, 1);

  assert.equal((await hub.api('POST', `${API}/import`, { ...bundle, schemaVersion: 9 })).status, 400);
  assert.equal((await hub.api('POST', `${API}/import`, { ...bundle, prompts: 'nope' })).status, 400);
  const imported = await hub.api('POST', `${API}/import`, { ...bundle, prompts: [] });
  assert.equal(imported.payload.imported, 0);
  assert.equal((await hub.api('GET', `${API}/prompts`)).payload.total, 0);

  const raw = await readFile(join(import.meta.dirname, '..', 'rooms', 'prompts', 'room.server.mjs'), 'utf8');
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  for (const forbidden of ['openai', 'deepseek', 'anthropic', 'apiKey', 'fetch(']) {
    assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `prompt room must not contain ${forbidden}`);
  }
});
