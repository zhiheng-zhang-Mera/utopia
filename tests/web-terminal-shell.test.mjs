/**
 * Web terminal shell — regression guards for two defects that a real browser found and the
 * unit suite did not.
 *
 * 1. `renderTerminal` returned `true` while the shell did `terminal = renderTerminal(...)`.
 *    Every later `terminal.isPage(...)` / `terminal.submit(...)` was therefore a silent no-op
 *    and none of the terminal pages could ever render.
 * 2. The Ask / Do page rendered its own `#ask-text` / `#ask-submit`, duplicating the ids of the
 *    always-visible shell bar. Id-based lookup became ambiguous, and the document-level click
 *    handler submitted a second time for a single user action.
 *
 * These are static/DOM-shape assertions: fast, and they fail if either defect returns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderTerminal, TERMINAL_PAGES, terminal } from '../apps/web/terminal.js';

const shellHtml = readFileSync(resolve('apps/web/index.html'), 'utf8');

/** Minimal container good enough for the markup builders, which only set innerHTML. */
function fakeContainer() {
  let html = '';
  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = String(value);
    },
    querySelector() {
      return null;
    },
    contains() {
      return false;
    },
  };
}

const idsIn = (html) => [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

test('renderTerminal returns the terminal controller, not a boolean', () => {
  const container = fakeContainer();
  const returned = renderTerminal(container, null, true, async () => ({}), { page: 'Ask/Do', go() {} });
  assert.equal(returned, terminal, 'the shell keeps this as its terminal handle');
  assert.equal(typeof returned.isPage, 'function');
  assert.equal(typeof returned.submit, 'function');
  assert.equal(typeof returned.render, 'function');
  assert.notEqual(returned, true);
});

test('every terminal page renders, and the page actually follows the shell', () => {
  for (const page of TERMINAL_PAGES) {
    const container = fakeContainer();
    renderTerminal(container, null, true, async () => ({}), { page, go() {} });
    assert.ok(container.innerHTML.length > 0, `${page} rendered nothing`);
  }

  // Re-rendering through the controller with a new page must switch pages. This is the
  // shell's real call shape, and it is what regressed: the controller ignored the hooks.
  const container = fakeContainer();
  renderTerminal(container, null, true, async () => ({}), { page: 'Rooms', go() {} });
  const roomsHtml = container.innerHTML;
  terminal.render(container, null, true, async () => ({}), { page: 'Ask/Do', go() {} });
  assert.notEqual(container.innerHTML, roomsHtml, 'the controller did not switch page');
  assert.match(container.innerHTML, /terminal-ask/, 'the Ask / Do page did not render');
});

test('the Ask / Do page does not duplicate any id owned by the shell', () => {
  const container = fakeContainer();
  renderTerminal(container, null, true, async () => ({}), { page: 'Ask/Do', go() {} });

  const shellIds = new Set(idsIn(shellHtml));
  const pageIds = idsIn(container.innerHTML);
  const collisions = pageIds.filter((id) => shellIds.has(id));
  assert.deepEqual(collisions, [], `duplicate ids: ${collisions.join(', ')}`);
  assert.ok(shellIds.has('ask-text') && shellIds.has('ask-submit'), 'the shell bar owns the Ask / Do entry');
  assert.ok(!pageIds.includes('ask-text') && !pageIds.includes('ask-submit'), 'the page must not re-render the bar');
});

test('no id is duplicated anywhere in the shell document', () => {
  const seen = new Set();
  const duplicates = [];
  for (const id of idsIn(shellHtml)) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  assert.deepEqual(duplicates, []);
});

test('the terminal module never attaches a second submit path to the shell bar', () => {
  const source = readFileSync(resolve('apps/web/terminal.js'), 'utf8');
  // The bar's submit button is owned by app.js's form handler. If terminal.js handles that id
  // again, one click posts twice.
  assert.ok(!/id\s*===\s*'ask-submit'/.test(source), 'terminal.js must not handle the shell submit id');
  assert.ok(!/id="ask-submit"/.test(source), 'terminal.js must not render the shell submit id');
  assert.ok(!/id="ask-text"/.test(source), 'terminal.js must not render the shell input id');
});

test('the shell bar is a real form so Enter submits it once, natively', () => {
  assert.match(shellHtml, /<form[^>]*id="ask-form"/, 'the bar must be a form');
  assert.match(shellHtml, /id="ask-submit"[^>]*type="submit"|type="submit"[^>]*id="ask-submit"/, 'the bar button must submit the form');
});
