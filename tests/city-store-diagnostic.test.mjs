// F-1, THE LAST OPEN ITEM IN THE STARTUP-STORE FAMILY: the canonical store is the one place where refusing to start
// is CORRECT, and this guard is about the refusal being USABLE rather than about removing it.
//
// Measured on unmodified main b06504f, one directory where `city.sqlite` belongs produced:
//   Error: unable to open database file          code ERR_SQLITE_ERROR, no path, no reason, no guidance
// which is unfalsifiable for an operator: it does not say which store, why, or what to do. The family rule is not
// "never fail"; it is "never fail silently or uninformatively". This file pins BOTH halves: the City must still refuse
// to start, and the refusal must be typed and actionable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';

test('the canonical store refuses to start the City, with a typed refusal that names the path and the reason', async () => {
  const dir = await mkdtemp(resolve('.scratch-store-diagnostic-'));
  let app = null;
  try {
    await mkdir(join(dir, 'city.sqlite'), {recursive: true});
    let thrown = null;
    try { app = await createGateway({dir, port: 0, token: 'diag-owner', nodeToken: 'diag-node', roomsDisabled: true}); }
    catch (error) { thrown = error; }
    assert.ok(thrown, 'a directory where the canonical database belongs must stop the City');
    assert.equal(thrown.code, 'CITY_STORE_UNAVAILABLE', `the refusal must be typed, not a raw sqlite error: ${thrown.code}`);
    assert.equal(thrown.name, 'StoreUnavailableError');
    assert.equal(thrown.status, 503, 'and it must be reportable as a storage condition rather than a bad request');
    assert.ok(String(thrown.message).includes(join(dir, 'city.sqlite')), `the message must name the path an operator has to fix: ${thrown.message}`);
    assert.match(String(thrown.message), /ENOTDIR|EEXIST|EACCES|ERR_SQLITE_ERROR/, 'and the underlying reason');
    assert.match(String(thrown.message), /refuses to start/i, 'and what the City decided, so the decision is not mistaken for a crash');
    assert.equal(thrown.detail?.file, join(dir, 'city.sqlite'));
    assert.ok(thrown.detail?.reason, 'the reason is machine-readable as well as written');
    assert.ok(thrown.cause instanceof Error, 'the underlying error is preserved as the cause');
  } finally {
    await app?.close().catch(() => {});
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {});
  }
});

test('a corrupted canonical database is refused the same typed way, not as a raw sqlite failure', async () => {
  const dir = await mkdtemp(resolve('.scratch-store-diagnostic-'));
  let app = null;
  try {
    // A file full of noise where the database belongs: the open may succeed and the SCHEMA step is what fails, which
    // is the other half of "the store is unusable" and must not surface as an unexplained sqlite error either.
    await writeFile(join(dir, 'city.sqlite'), 'this is not a sqlite database, it is a text file with a database name');
    let thrown = null;
    try { app = await createGateway({dir, port: 0, token: 'diag-owner', nodeToken: 'diag-node', roomsDisabled: true}); }
    catch (error) { thrown = error; }
    assert.ok(thrown, 'a file that is not a database must stop the City');
    assert.equal(thrown.code, 'CITY_STORE_UNAVAILABLE', `a corrupt store is a store that cannot be opened: ${thrown.code} / ${thrown.message}`);
  } finally {
    await app?.close().catch(() => {});
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {});
  }
});

test('CONTROL: a healthy runtime starts the City, so the refusals above are about the store and not the fixture', async () => {
  const dir = await mkdtemp(resolve('.scratch-store-diagnostic-'));
  let app = null;
  try {
    app = await createGateway({dir, port: 0, token: 'diag-owner', nodeToken: 'diag-node', roomsDisabled: true});
    assert.ok(app.store.cityId, 'the control City must actually have a canonical store');
    assert.equal(app.store.list('tasks').length, 0);
  } finally {
    await app?.close().catch(() => {});
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {});
  }
});
