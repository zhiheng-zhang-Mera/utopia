/**
 * UTOPIA · Automation District — computer-use target guard suite.
 *
 * Every vector here restates the DS-Hns donor `app/computer-use/target.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the normalization shapes, the fixed
 * selector → accessibility → semantic → window → bbox → visual → point ladder, the
 * 3 px / 10 px movement tolerances, the geometry, the three match predicates and
 * the two typed refusals with their exact messages.
 *
 * The donor's defects are carried unchanged, so they are pinned here as well — see
 * the "donor defects" section at the end and `DONOR.json` `knownDifferences`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODES,
  TARGET_KINDS,
  TARGET_MOVEMENT,
  ComputerUseError,
  centerOf,
  containsPoint,
  describeTarget,
  distance,
  matchesAccessibility,
  matchesSemantic,
  matchesWindow,
  normalizeTarget,
  resolveTarget,
  revalidate,
  targetKinds,
} from '../index.mjs';

// ---------------------------------------------------------------------------
// fixtures

/** The donor's own message for a target with no addressing rung at all (96 characters). */
const NO_RUNG_MESSAGE = 'a target must carry at least one of: selector, accessibility, semantic, window, bbox, point, ref';

/** A world with one element of every kind, so a rung can be isolated. */
function world() {
  return {
    controls: [
      { id: 'save', selector: '#save', name: 'Save', text: 'Save', bbox: { x: 10, y: 20, width: 100, height: 40 } },
      { id: 'cancel', selector: '#cancel', name: 'Cancel', bbox: { x: 200, y: 20, width: 80, height: 40 } },
    ],
    visibleTargets: [
      { id: 'canvas', name: 'Drawing canvas', bbox: { x: 0, y: 0, width: 800, height: 600 } },
    ],
    ax: [
      { ref: 'w:1/0', role: 'button', name: 'Save', controlType: 'Button', automationId: 'saveButton', className: 'Primary' },
      { ref: 'w:1/1', role: 'edit', name: 'Search', controlType: 'Edit', automationId: 'searchBox' },
    ],
    windows: [
      { handle: '42', processId: 100, className: 'Notepad', title: 'Untitled - Notepad' },
      { handle: '43', processId: 200, className: 'Chrome_WidgetWin_1', title: 'Docs - Google Chrome' },
    ],
  };
}

// ---------------------------------------------------------------------------
// contracts

test('the ladder is the donor ladder: seven kinds, ranks 1..7, labels unchanged', () => {
  assert.deepEqual(TARGET_KINDS, [
    { kind: 'selector', rank: 1, label: 'DOM selector' },
    { kind: 'accessibility', rank: 2, label: 'accessibility node' },
    { kind: 'semantic', rank: 3, label: 'semantic element' },
    { kind: 'window', rank: 4, label: 'window' },
    { kind: 'bbox', rank: 5, label: 'bounding box' },
    { kind: 'visual', rank: 6, label: 'visual target' },
    { kind: 'point', rank: 7, label: 'visual coordinate' },
  ]);
  assert.equal(TARGET_KINDS.length, 7);
  assert.equal(Object.isFrozen(TARGET_KINDS), true, 'the ladder is frozen, as in the donor');
  assert.deepEqual(TARGET_MOVEMENT, { stablePx: 3, updatePx: 10 });
  assert.equal(Object.isFrozen(TARGET_MOVEMENT), true);
  assert.deepEqual(CODES, { TARGET_INVALID: 'TARGET_INVALID', TARGET_NOT_FOUND: 'TARGET_NOT_FOUND' });
});

test('both target refusals are non-retryable and carry the donor fields', () => {
  const thrown = (fn) => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return null;
  };
  const invalid = thrown(() => normalizeTarget(''));
  assert.ok(invalid instanceof ComputerUseError);
  assert.equal(invalid.name, 'ComputerUseError');
  assert.equal(invalid.code, 'TARGET_INVALID');
  assert.equal(invalid.retryable, false);
  assert.equal(invalid.controllerId, null);
  assert.equal(invalid.state, null);
  assert.deepEqual(invalid.toJSON(), {
    code: 'TARGET_INVALID',
    message: 'a target string may not be empty',
    retryable: false,
    controllerId: null,
    state: null,
    details: {},
  });

  const notFound = resolveTarget(normalizeTarget('#nope'), world()).error;
  assert.equal(notFound.code, 'TARGET_NOT_FOUND');
  assert.equal(notFound.retryable, false);
  assert.equal(notFound.name, 'ComputerUseError');
  assert.equal(notFound instanceof Error, true);
});

// ---------------------------------------------------------------------------
// normalization

test('a string target is trimmed and split between selector and semantic text', () => {
  assert.deepEqual(normalizeTarget('  Save  '), {
    semantic: { text: 'Save' },
    kinds: ['semantic'],
    rank: 3,
    primaryKind: 'semantic',
  });
  assert.deepEqual(normalizeTarget('  #save  '), {
    selector: '#save',
    kinds: ['selector'],
    rank: 1,
    primaryKind: 'selector',
  });
  assert.equal(normalizeTarget('button[type=submit]').selector, 'button[type=submit]');
  assert.equal(normalizeTarget('div > span').selector, 'div > span');
  assert.equal(normalizeTarget('radix-menu').selector, 'radix-menu');
  // "log in" carries a space and no #, so it is text, not a selector
  assert.deepEqual(normalizeTarget('log in').semantic, { text: 'log in' });
  assert.deepEqual(normalizeTarget('.primary').semantic, undefined);
  assert.equal(normalizeTarget('.primary').selector, '.primary');
});

test('an empty or blank string target is refused with the donor message', () => {
  assert.throws(() => normalizeTarget(''), {
    name: 'ComputerUseError',
    code: 'TARGET_INVALID',
    message: 'a target string may not be empty',
  });
  assert.throws(() => normalizeTarget('   '), { code: 'TARGET_INVALID', message: 'a target string may not be empty' });
  assert.throws(() => normalizeTarget('\t\n'), { code: 'TARGET_INVALID', message: 'a target string may not be empty' });
});

test('a non-string, non-object, non-array target is refused with the donor message', () => {
  for (const [input, received] of [[null, 'object'], [undefined, 'undefined'], [42, 'number'], [true, 'boolean']]) {
    assert.throws(() => normalizeTarget(input), (error) => {
      assert.equal(error.code, 'TARGET_INVALID');
      assert.equal(error.message, 'a target must be a string, object or array of candidates');
      assert.deepEqual(error.details, { received });
      return true;
    });
  }
});

test('an object with no addressing rung is refused with the donor message and the raw target', () => {
  assert.throws(() => normalizeTarget({}), (error) => {
    assert.equal(error.code, 'TARGET_INVALID');
    assert.equal(error.message, NO_RUNG_MESSAGE);
    assert.equal(NO_RUNG_MESSAGE.length, 96);
    assert.deepEqual(error.details, { received: {} });
    return true;
  });
  // a description alone is not a way to find anything
  assert.throws(() => normalizeTarget({ description: 'the blue button' }), { message: NO_RUNG_MESSAGE });
  // an empty candidate list adds no rung
  assert.throws(() => normalizeTarget({ candidates: [] }), { message: NO_RUNG_MESSAGE });
  assert.throws(() => normalizeTarget([]), { message: NO_RUNG_MESSAGE });
  // a lone `name` is not on the donor's accessibility trigger list and is not text
  assert.throws(() => normalizeTarget({ name: 'Save' }), { message: NO_RUNG_MESSAGE });
});

test('selector, dom_selector, page/tab, ref and description survive normalization', () => {
  assert.deepEqual(normalizeTarget({ selector: '#save' }), {
    selector: '#save',
    kinds: ['selector'],
    rank: 1,
    primaryKind: 'selector',
  });
  // dom_selector overwrites selector, in that order, exactly as the donor reads them
  assert.deepEqual(normalizeTarget({ selector: '#a', dom_selector: '#b' }).selector, '#b');
  assert.deepEqual(normalizeTarget({ dom_selector: '#only' }).selector, '#only');
  // a falsy selector carries nothing at all
  assert.throws(() => normalizeTarget({ selector: '' }), { message: NO_RUNG_MESSAGE });

  const full = normalizeTarget({
    selector: '#save',
    ref: 'w:1/0',
    page: 'tab-7',
    description: 'the save button',
    window: { title: 'Editor' },
  });
  assert.equal(full.ref, 'w:1/0');
  assert.equal(full.page, 'tab-7');
  assert.equal(full.description, 'the save button');
  assert.deepEqual(full.window, { title: 'Editor' });
  assert.deepEqual(full.kinds, ['selector', 'accessibility']);
  assert.equal(full.rank, 1);
  assert.equal(full.primaryKind, 'selector');
  // `page`, `tab` and `tabId` are recorded but are NOT a rung: on their own they
  // are read and then refused (DEFECT 11 below). With the selector above they ride along.
  assert.equal(normalizeTarget({ selector: '#s', page: 'tab-7' }).page, 'tab-7');
  assert.equal(normalizeTarget({ selector: '#s', page: 'a', tab: 'b', tabId: 'c' }).page, 'a', 'page, then tab, then tabId, in the donor order');
});

test('accessibility accepts the raw spellings, the nested form and the ax alias', () => {
  assert.deepEqual(normalizeTarget({ accessibility: { role: 'button', name: 'Save' } }), {
    accessibility: { role: 'button', name: 'Save' },
    kinds: ['accessibility'],
    rank: 2,
    primaryKind: 'accessibility',
  });
  // flat spelling: the whole object becomes the accessibility query
  assert.deepEqual(normalizeTarget({ role: 'button', automation_id: 'saveButton' }), {
    accessibility: { role: 'button', automationId: 'saveButton' },
    kinds: ['accessibility'],
    rank: 2,
    primaryKind: 'accessibility',
  });
  assert.deepEqual(normalizeTarget({ control_type: 'Button' }).accessibility, { controlType: 'Button' });
  assert.deepEqual(normalizeTarget({ automationId: 'x' }).accessibility, { automationId: 'x' });
  assert.deepEqual(normalizeTarget({ ax: { name: 'Save' } }).accessibility, { name: 'Save' });
  // flat spelling picks up the sibling fields the donor names in the same list
  assert.deepEqual(normalizeTarget({ role: 'button', name: 'Save', class_name: 'Primary', index: 2, exact: false }).accessibility, {
    role: 'button',
    name: 'Save',
    className: 'Primary',
    index: 2,
    exact: false,
  });
  // index must be an integer and exact false is meaningful, undefined is dropped
  assert.deepEqual(normalizeTarget({ accessibility: { role: 'button', index: 1.5, exact: undefined } }).accessibility, { role: 'button' });
  assert.deepEqual(normalizeTarget({ accessibility: { exact: false } }).accessibility, { exact: false });
});

test('a name alone is not an accessibility query: it is a refusal, not a silent semantic match', () => {
  // the donor's accessibility trigger list has no `name`, and `name` is not on the
  // semantic trigger list (`text` / `label` / `placeholder`) either, so the target
  // carries no rung at all. The nested forms are what carry a name.
  assert.throws(() => normalizeTarget({ name: 'Save' }), { code: 'TARGET_INVALID', message: NO_RUNG_MESSAGE });
  assert.deepEqual(normalizeTarget({ semantic: { name: 'Save' } }), {
    semantic: { name: 'Save' },
    kinds: ['semantic'],
    rank: 3,
    primaryKind: 'semantic',
  });
  assert.deepEqual(normalizeTarget({ text: 'Save', name: 'Save', role: 'button' }).semantic, { text: 'Save', name: 'Save', role: 'button' });
  assert.deepEqual(normalizeTarget({ semantic: { label: 'Save', inside: '#dialog' } }).semantic, { label: 'Save', inside: '#dialog' });
  // an empty string on the trigger list does not trigger it
  assert.throws(() => normalizeTarget({ text: '' }), { message: NO_RUNG_MESSAGE });
});

test('bbox accepts the x/y/width/height, left/top and w/h spellings and normalizes the order', () => {
  assert.deepEqual(normalizeTarget({ bbox: { x: 10, y: 20, width: 100, height: 40 } }), {
    bbox: { x: 10, y: 20, width: 100, height: 40 },
    kinds: ['bbox'],
    rank: 5,
    primaryKind: 'bbox',
  });
  assert.deepEqual(normalizeTarget({ box: { left: 1, top: 2, w: 3, h: 4 } }).bbox, { x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(normalizeTarget({ rect: { x: 1, y: 2, w: 3, h: 4 } }).bbox, { x: 1, y: 2, width: 3, height: 4 });
  // numeric strings are converted
  assert.deepEqual(normalizeTarget({ bbox: { x: '1', y: '2', width: '3', height: '4' } }).bbox, { x: 1, y: 2, width: 3, height: 4 });
  // a non-positive extent is refused
  assert.throws(() => normalizeTarget({ bbox: { x: 0, y: 0, width: 0, height: 10 } }), {
    code: 'TARGET_INVALID',
    message: 'bbox must have a positive width and height',
  });
  assert.throws(() => normalizeTarget({ bbox: { x: 0, y: 0, width: 10, height: -1 } }), { message: 'bbox must have a positive width and height' });
  // a missing height becomes NaN, so the finite check fires first
  assert.throws(() => normalizeTarget({ bbox: { x: 0, y: 0, width: 10 } }), {
    code: 'TARGET_INVALID',
    message: 'bbox needs finite x, y, width and height',
  });
  assert.throws(() => normalizeTarget({ bbox: { x: Infinity, y: 0, width: 10, height: 10 } }), { message: 'bbox needs finite x, y, width and height' });
  // a non-object bbox reports the received type
  assert.throws(() => normalizeTarget({ bbox: 'rect' }), (error) => {
    assert.equal(error.message, 'bbox must be an object with x, y, width, height');
    assert.deepEqual(error.details, { received: 'string' });
    return true;
  });
  // an empty object bbox reaches the bbox rung and is then refused as non-finite
  assert.throws(() => normalizeTarget({ bbox: {} }), { message: 'bbox needs finite x, y, width and height' });
});

test('point accepts point, coordinate, coordinates and a bare x/y pair', () => {
  assert.deepEqual(normalizeTarget({ point: { x: 10, y: 20 } }), {
    point: { x: 10, y: 20 },
    kinds: ['point'],
    rank: 7,
    primaryKind: 'point',
  });
  assert.deepEqual(normalizeTarget({ coordinate: { x: 1, y: 2 } }).point, { x: 1, y: 2 });
  assert.deepEqual(normalizeTarget({ coordinates: { x: 1, y: 2 } }).point, { x: 1, y: 2 });
  // a bare x/y pair wins over an explicit point object, because it is applied last
  assert.deepEqual(normalizeTarget({ point: { x: 1, y: 2 }, x: 9, y: 9 }).point, { x: 9, y: 9 });
  // x without y leaves the point untouched
  assert.equal(normalizeTarget({ x: 5, point: { x: 1, y: 2 } }).point.x, 1);
  // numeric strings are accepted
  assert.deepEqual(normalizeTarget({ point: { x: '5', y: '6' } }).point, { x: 5, y: 6 });
  assert.throws(() => normalizeTarget({ point: { x: 1 } }), { message: 'point needs finite x and y' });
  assert.throws(() => normalizeTarget({ point: { x: 'left', y: 2 } }), { code: 'TARGET_INVALID', message: 'point needs finite x and y' });
  assert.throws(() => normalizeTarget({ point: [1, 2] }), (error) => {
    assert.equal(error.message, 'point must be an object with x and y');
    assert.deepEqual(error.details, { received: 'object' });
    return true;
  });
});

test('window accepts a string title or the structured reference', () => {
  assert.deepEqual(normalizeTarget({ window: 'Untitled - Notepad' }), {
    window: { title: 'Untitled - Notepad' },
    kinds: ['window'],
    rank: 4,
    primaryKind: 'window',
  });
  assert.deepEqual(normalizeTarget({ window: { handle: 42 } }).window, { handle: '42' });
  assert.deepEqual(normalizeTarget({ window: { pid: 100, title: 'Editor' } }).window, { title: 'Editor', processId: 100 });
  assert.deepEqual(normalizeTarget({ window: { processId: 100, pid: 999 } }).window, { processId: 100 });
  assert.deepEqual(normalizeTarget({ window: { className: 'Notepad', process: 'notepad.exe' } }).window, {
    className: 'Notepad',
    process: 'notepad.exe',
  });
  // handle is carried as a string even when a number was given
  assert.equal(typeof normalizeTarget({ window: { handle: 42 } }).window.handle, 'string');
  // a non-object window is refused, and the received type is reported
  assert.throws(() => normalizeTarget({ window: 42 }), (error) => {
    assert.equal(error.message, 'window must be a string or an object');
    assert.deepEqual(error.details, { received: 'number' });
    return true;
  });
});

test('visual accepts paint, template, template_path and the flat paint/template spellings', () => {
  const paint = normalizeTarget({ visual: { paint: { color: '#ff0000', width: 4, height: 4, tolerance: 12 }, threshold: 0.8, level: 2 } });
  assert.deepEqual(paint.visual, {
    paint: { color: '#ff0000', width: 4, height: 4, tolerance: 12 },
    threshold: 0.8,
    level: 2,
  });
  assert.deepEqual(paint.kinds, ['visual']);
  assert.equal(paint.rank, 6);
  // a bare colour string is its own paint colour
  assert.deepEqual(normalizeTarget({ paint: '#00ff00' }).visual, { paint: { color: '#00ff00' } });
  assert.deepEqual(normalizeTarget({ visual: { color: 'red' } }).visual, { paint: { color: 'red' } });
  // a flat template_path rides along with a visual trigger (template / paint / visual);
  // on its own it is not a trigger at all (DEFECT 10 below)
  assert.deepEqual(normalizeTarget({ template: undefined, template_path: 'x.png', paint: 'red' }).visual, {
    paint: { color: 'red' },
    templatePath: 'x.png',
  });
  // a template is dropped when a templatePath is present
  assert.deepEqual(normalizeTarget({ visual: { template: 'raw', templatePath: 'x.png' } }).visual, { templatePath: 'x.png' });
  assert.deepEqual(normalizeTarget({ visual: { template: 'raw' } }).visual, { template: 'raw' });
  // a truthy-but-zero tolerance is kept, a zero width is dropped
  assert.deepEqual(normalizeTarget({ visual: { paint: { color: 'red', tolerance: 0, width: 0, height: 0 } } }).visual, {
    paint: { color: 'red', tolerance: 0 },
  });
  assert.deepEqual(normalizeTarget({ visual: { search: { x: 0, y: 0 } } }).visual, { search: { x: 0, y: 0 } });
  // a non-integer level is dropped, leaving an empty visual object that is still a rung
  assert.equal(normalizeTarget({ visual: { level: 2 } }).visual.level, 2);
  assert.deepEqual(normalizeTarget({ visual: { level: 1.5 } }), { visual: {}, kinds: ['visual'], rank: 6, primaryKind: 'visual' });
});

// ---------------------------------------------------------------------------
// targetKinds / build

test('targetKinds reports every addressing mode present, best first', () => {
  assert.deepEqual(targetKinds(normalizeTarget('#save')), ['selector']);
  assert.deepEqual(targetKinds(normalizeTarget({ ref: 'w:1/0' })), ['accessibility']);
  assert.deepEqual(targetKinds(normalizeTarget({ accessibility: { role: 'button' }, selector: '#save' })), ['selector', 'accessibility']);
  assert.deepEqual(targetKinds(normalizeTarget({ selector: '#s', text: 'Save', bbox: { x: 0, y: 0, width: 1, height: 1 }, point: { x: 1, y: 1 } })), [
    'selector',
    'semantic',
    'bbox',
    'point',
  ]);
});

test('a window is only a rung of its own when nothing else addresses the target', () => {
  assert.deepEqual(targetKinds(normalizeTarget({ window: 'Editor' })), ['window']);
  // with a specific rung present the window is a locator context, not a rung
  assert.deepEqual(targetKinds(normalizeTarget({ window: 'Editor', point: { x: 1, y: 2 } })), ['point']);
  assert.deepEqual(targetKinds(normalizeTarget({ window: 'Editor', bbox: { x: 0, y: 0, width: 1, height: 1 } })), ['bbox']);
  assert.deepEqual(normalizeTarget({ window: 'Editor', point: { x: 1, y: 2 } }).window, { title: 'Editor' });
  // ...and the resolved rank follows the specific rung
  assert.equal(normalizeTarget({ window: 'Editor', text: 'Save' }).rank, 3);
  assert.equal(normalizeTarget({ window: 'Editor', visual: { level: 1 } }).rank, 6);
});

test('rank is the best rung and primaryKind is that same rung', () => {
  const target = normalizeTarget({ bbox: { x: 0, y: 0, width: 10, height: 10 }, text: 'Save', selector: '#save' });
  assert.equal(target.rank, 1);
  assert.equal(target.primaryKind, 'selector');
  assert.deepEqual(target.kinds, ['selector', 'semantic', 'bbox']);
  const pointOnly = normalizeTarget({ point: { x: 1, y: 1 } });
  assert.equal(pointOnly.rank, 7);
  assert.equal(pointOnly.primaryKind, 'point');
});

test('a candidate list carries the union of its candidates kinds, best first', () => {
  const target = normalizeTarget([{ point: { x: 1, y: 2 } }, { accessibility: { role: 'button' } }, { text: 'Save' }]);
  assert.equal(target.selector, undefined);
  assert.deepEqual(target.kinds, ['accessibility', 'semantic', 'point']);
  assert.equal(target.rank, 2);
  assert.equal(target.primaryKind, 'accessibility');
  assert.equal(target.candidates.length, 3);
  // each candidate is a normalized target in its own right
  assert.equal(target.candidates[0].rank, 7);
  assert.equal(target.candidates[0].primaryKind, 'point');
  // candidates passed on an object are normalized the same way
  assert.deepEqual(normalizeTarget({ candidates: ['#save'] }).candidates[0].selector, '#save');
  // a candidates entry that is refused refuses the whole target
  assert.throws(() => normalizeTarget(['']), { code: 'TARGET_INVALID', message: 'a target string may not be empty' });
  assert.throws(() => normalizeTarget({ candidates: [{}] }), { message: NO_RUNG_MESSAGE });
});

// ---------------------------------------------------------------------------
// describeTarget

test('describeTarget writes the donor label for every rung and never invents one', () => {
  assert.equal(describeTarget(null), '(no target)');
  assert.equal(describeTarget(undefined), '(no target)');
  assert.equal(describeTarget({}), '(unresolved)');
  assert.equal(describeTarget({ description: 'x' }), '(unresolved)');

  assert.equal(describeTarget({ selector: '#save' }), 'selector:#save');
  assert.equal(describeTarget({ accessibility: { role: 'button', name: 'Save', automationId: 'saveButton' } }), 'ax:button/Save/saveButton');
  assert.equal(describeTarget({ accessibility: { name: 'Save' } }), 'ax:Save');
  assert.equal(describeTarget({ accessibility: { exact: true } }), 'ax:(any)');
  assert.equal(describeTarget({ semantic: { text: 'Save' } }), 'semantic:Save');
  assert.equal(describeTarget({ semantic: { label: 'Save' } }), 'semantic:Save');
  assert.equal(describeTarget({ semantic: { name: 'Save' } }), 'semantic:Save');
  assert.equal(describeTarget({ semantic: { placeholder: 'Search' } }), 'semantic:Search');
  assert.equal(describeTarget({ window: { title: 'Editor' } }), 'window:Editor');
  assert.equal(describeTarget({ window: { handle: '42' } }), 'window:42');
  assert.equal(describeTarget({ window: { process: 'notepad.exe' } }), 'window:notepad.exe');
  assert.equal(describeTarget({ window: { processId: 9 } }), 'window:(any)');
  assert.equal(describeTarget({ visual: { paint: { color: '#ff0000' } } }), 'visual:"#ff0000"');
  assert.equal(describeTarget({ visual: { templatePath: 'x.png' } }), 'visual:template');
  assert.equal(describeTarget({ bbox: { x: 1, y: 2, width: 3, height: 4 } }), 'bbox:1,2,3x4');
  assert.equal(describeTarget({ point: { x: 11, y: 22 } }), 'point:11,22');
});

test('the donor precedence of describeTarget is selector, accessibility, semantic, window, visual, bbox, point', () => {
  const all = {
    selector: '#s',
    accessibility: { role: 'button' },
    semantic: { text: 'T' },
    window: { title: 'W' },
    visual: { paint: { color: 'red' } },
    bbox: { x: 1, y: 2, width: 3, height: 4 },
    point: { x: 5, y: 6 },
  };
  assert.equal(describeTarget(all), 'selector:#s');
  assert.equal(describeTarget({ ...all, selector: undefined }), 'ax:button');
  assert.equal(describeTarget({ ...all, selector: undefined, accessibility: undefined }), 'semantic:T');
  assert.equal(describeTarget({ ...all, selector: undefined, accessibility: undefined, semantic: undefined }), 'window:W');
  assert.equal(describeTarget({ ...all, selector: undefined, accessibility: undefined, semantic: undefined, window: undefined }), 'visual:"red"');
  assert.equal(
    describeTarget({ ...all, selector: undefined, accessibility: undefined, semantic: undefined, window: undefined, visual: undefined }),
    'bbox:1,2,3x4',
  );
  assert.equal(
    describeTarget({
      ...all,
      selector: undefined,
      accessibility: undefined,
      semantic: undefined,
      window: undefined,
      visual: undefined,
      bbox: undefined,
    }),
    'point:5,6',
  );
});

// ---------------------------------------------------------------------------
// geometry

test('containsPoint is inclusive on both edges and corners', () => {
  const rect = { x: 10, y: 20, width: 100, height: 40 };
  assert.equal(containsPoint(rect, 10, 20), true, 'top-left corner');
  assert.equal(containsPoint(rect, 110, 60), true, 'bottom-right corner');
  assert.equal(containsPoint(rect, 10, 60), true, 'bottom-left corner');
  assert.equal(containsPoint(rect, 110, 20), true, 'top-right corner');
  assert.equal(containsPoint(rect, 60, 40), true, 'centre');
  assert.equal(containsPoint(rect, 9.99, 40), false, '0.01 px left of the left edge');
  assert.equal(containsPoint(rect, 110.01, 40), false, '0.01 px right of the right edge');
  assert.equal(containsPoint(rect, 60, 19.99), false, '0.01 px above the top edge');
  assert.equal(containsPoint(rect, 60, 60.01), false, '0.01 px below the bottom edge');
  // no rounding happens here: the raw comparison is what the donor wrote
  assert.equal(containsPoint(rect, 10.5, 20.5), true);
  assert.equal(containsPoint({ x: 0, y: 0, width: 0, height: 0 }, 0, 0), true);
  assert.equal(containsPoint({ x: 0, y: 0, width: 0, height: 0 }, 0.5, 0), false);
});

test('centerOf rounds to whole pixels and distance rounds to two decimals', () => {
  assert.deepEqual(centerOf({ x: 10, y: 20, width: 100, height: 40 }), { x: 60, y: 40 });
  // .5 rounds up, both axes
  assert.deepEqual(centerOf({ x: 0, y: 0, width: 1, height: 1 }), { x: 1, y: 1 });
  assert.deepEqual(centerOf({ x: 0, y: 0, width: 3, height: 5 }), { x: 2, y: 3 });
  assert.deepEqual(centerOf({ x: 5, y: 5, width: 0, height: 0 }), { x: 5, y: 5 });
  assert.deepEqual(centerOf({ x: 1, y: 1, width: 2, height: 2 }), { x: 2, y: 2 });

  assert.equal(distance({ x: 0, y: 0 }, { x: 0, y: 0 }), 0);
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(distance({ x: 0, y: 0 }, { x: 1, y: 1 }), 1.41);
  assert.equal(distance({ x: 10, y: 10 }, { x: 7, y: 6 }), 5);
  // negative dx/dy do not cancel
  assert.equal(distance({ x: 5, y: 5 }, { x: 8, y: 1 }), 5);
  // numeric strings are coerced, matching the donor's Number() calls
  assert.equal(distance({ x: '0', y: '0' }, { x: '3', y: '4' }), 5);
  // donor defect: a missing coordinate becomes NaN, and NaN survives the rounding
  assert.equal(Number.isNaN(distance({ x: 0, y: 0 }, { x: 3 })), true);
});

// ---------------------------------------------------------------------------
// the ladder

test('rung 1: selector resolves from a resolver, from world.controls and from visibleTargets', () => {
  const viaResolver = resolveTarget(normalizeTarget('#save'), null, {
    selector: (selector) => [{ ref: 'r1', selector, bbox: { x: 1, y: 2, width: 3, height: 4 } }],
  });
  assert.equal(viaResolver.ok, true);
  assert.equal(viaResolver.kind, 'selector');
  assert.deepEqual(viaResolver.attempts.map((a) => a.kind), ['selector']);
  assert.equal(viaResolver.attempts[0].count, 1);
  assert.equal(viaResolver.coordinateFallback, false);
  assert.equal(viaResolver.resolved.selector, '#save');

  const state = world();
  const fromControl = resolveTarget(normalizeTarget('#save'), state);
  assert.equal(fromControl.ok, true);
  assert.equal(fromControl.resolved.element, state.controls[0]);
  // id is the second spelling the donor matches
  assert.equal(resolveTarget(normalizeTarget('#cancel'), state).resolved.element.id, 'cancel');
  // visibleTargets are searched too
  const fromVisible = resolveTarget(normalizeTarget({ selector: 'canvas' }), {
    visibleTargets: [{ id: 'canvas', bbox: { x: 0, y: 0, width: 10, height: 10 } }],
  });
  assert.equal(fromVisible.ok, true);
  // attributes.id is the third spelling
  const fromAttribute = resolveTarget(normalizeTarget('#attr'), { controls: [{ attributes: { id: '#attr' } }] });
  assert.equal(fromAttribute.ok, true);
  // a selector that matches nothing anywhere
  assert.equal(resolveTarget(normalizeTarget('#nope'), state).ok, false);
});

test('rung 2: accessibility resolves by ref, from the ax tree and from the page controls', () => {
  const state = world();
  const byRef = resolveTarget(normalizeTarget({ ref: 'w:1/0' }), state);
  assert.equal(byRef.ok, true);
  assert.equal(byRef.kind, 'accessibility');
  assert.equal(byRef.resolved.ref, 'w:1/0');
  assert.equal(byRef.resolved.name, 'Save');

  const byQuery = resolveTarget(normalizeTarget({ accessibility: { automationId: 'searchBox' } }), state);
  assert.equal(byQuery.ok, true);
  assert.equal(byQuery.resolved.name, 'Search');

  // the pool is world.ax first, then world.controls: a page control is an accessible object too
  const fromControls = resolveTarget(normalizeTarget({ accessibility: { name: 'Cancel' } }), state);
  assert.equal(fromControls.ok, true);
  assert.equal(fromControls.resolved.element, state.controls[1]);

  // without a resolver and without a ref, a target with no accessibility query matches nothing
  const noQuery = resolveTarget({ kinds: ['accessibility'] }, state);
  assert.equal(noQuery.ok, false);
  assert.equal(noQuery.attempts[0].reason, 'no match');
  assert.equal(noQuery.attempts[0].count, 0);

  // an unknown ref is a miss, not a throw
  const missingRef = resolveTarget(normalizeTarget({ ref: 'w:9' }), state);
  assert.equal(missingRef.ok, false);
  assert.equal(missingRef.attempts[0].reason, 'no match');
  // a ref-only target carries no accessibility query of its own, so its label is the fallback
  assert.equal(missingRef.error.message, 'target not found: (unresolved)');
});

test('rung 3: semantic matches on the concatenated element text and on role', () => {
  const state = world();
  const byText = resolveTarget(normalizeTarget('Save'), state);
  assert.equal(byText.ok, true);
  assert.equal(byText.kind, 'semantic');
  assert.equal(byText.resolved.element.id, 'save');
  assert.equal(byText.resolved.candidates, 1, 'only the Save control carries that text: Cancel has no text field');

  // a placeholder read from attributes is part of the text
  const byPlaceholder = resolveTarget({ kinds: ['semantic'], semantic: { placeholder: 'Search' }, rank: 3, primaryKind: 'semantic' }, {
    controls: [{ id: 'search', attributes: { placeholder: 'Search here' } }],
  });
  assert.equal(byPlaceholder.ok, true);

  // the fields are joined with a single space, so a phrase spanning two fields still reads as one string
  const joined = resolveTarget({ kinds: ['semantic'], semantic: { text: 'Save Cancel' }, rank: 3, primaryKind: 'semantic' }, {
    controls: [{ name: 'Save', text: 'Cancel' }],
  });
  assert.equal(joined.ok, true, 'name and text join to "save cancel"');
  // ...but a phrase in the other order is not reassembled
  const notAdjacent = resolveTarget({ kinds: ['semantic'], semantic: { text: 'Cancel Save' }, rank: 3, primaryKind: 'semantic' }, {
    controls: [{ name: 'Save', text: 'Cancel' }],
  });
  assert.equal(notAdjacent.ok, false, 'the donor joins in field order and never sorts the terms');
});

test('rung 4: window resolves from world.windows through the donor predicate', () => {
  const state = world();
  const byTitle = resolveTarget(normalizeTarget({ window: 'notepad' }), state);
  assert.equal(byTitle.ok, true);
  assert.equal(byTitle.kind, 'window');
  assert.equal(byTitle.resolved.handle, '42');
  assert.equal(byTitle.coordinateFallback, false);

  const byHandle = resolveTarget(normalizeTarget({ window: { handle: '43' } }), state);
  assert.equal(byHandle.resolved.element, state.windows[1]);

  const byProcess = resolveTarget(normalizeTarget({ window: { processId: 100 } }), state);
  assert.equal(byProcess.resolved.handle, '42');

  const byClass = resolveTarget(normalizeTarget({ window: { className: 'notepad' } }), state);
  assert.equal(byClass.resolved.handle, '42');

  const noWindow = resolveTarget(normalizeTarget({ window: 'Nope' }), state);
  assert.equal(noWindow.ok, false);
  assert.equal(noWindow.attempts[0].reason, 'no match');
  assert.equal(noWindow.error.message, 'target not found: window:Nope');
  // no world.windows at all is an empty pool, not a throw
  assert.equal(resolveTarget(normalizeTarget({ window: 'Editor' }), {}).ok, false);
});

test('rung 5: bbox matches the element containing the rect centre, both edges inclusive', () => {
  const target = normalizeTarget({ bbox: { x: 10, y: 20, width: 100, height: 40 } });
  assert.deepEqual(centerOf(target.bbox), { x: 60, y: 40 });
  const hit = resolveTarget(target, { controls: [{ id: 'in', bbox: { x: 10, y: 20, width: 100, height: 40 } }] });
  assert.equal(hit.ok, true);
  assert.equal(hit.kind, 'bbox');
  assert.equal(hit.coordinateFallback, true);
  assert.deepEqual(hit.resolved.point, { x: 60, y: 40 });
  assert.equal(hit.resolved.coordinateFallback, true);

  // the centre is on the boundary of the candidate: still a hit, because containsPoint is inclusive
  const onEdge = resolveTarget(normalizeTarget({ bbox: { x: 10, y: 20, width: 100, height: 40 } }), {
    controls: [{ bbox: { x: 60, y: 40, width: 10, height: 10 } }],
  });
  assert.equal(onEdge.ok, true);
  // one pixel further and it is a miss
  const offEdge = resolveTarget(normalizeTarget({ bbox: { x: 10, y: 20, width: 100, height: 40 } }), {
    controls: [{ bbox: { x: 61, y: 41, width: 10, height: 10 } }],
  });
  assert.equal(offEdge.ok, false);
  assert.equal(offEdge.attempts[0].reason, 'no match');

  // an element without a bbox never matches
  assert.equal(resolveTarget(target, { controls: [{ id: 'nobox' }] }).ok, false);
});

test('rung 6: visual is never resolved from world state, only through a resolver', () => {
  const target = normalizeTarget({ visual: { paint: { color: '#ff0000' } } });
  // no resolver: the donor returns null, so the rung reports no match
  const bare = resolveTarget(target, world());
  assert.equal(bare.ok, false);
  assert.equal(bare.attempts.length, 1);
  assert.equal(bare.attempts[0].kind, 'visual');
  assert.equal(bare.attempts[0].count, 0);
  assert.equal(bare.attempts[0].reason, 'no match');
  assert.equal(bare.error.message, 'target not found: visual:"#ff0000"');

  const viaResolver = resolveTarget(target, world(), { visual: () => [{ ref: 'v1', bbox: { x: 5, y: 5, width: 9, height: 9 } }] });
  assert.equal(viaResolver.ok, true);
  assert.equal(viaResolver.kind, 'visual');
  assert.equal(viaResolver.coordinateFallback, false);
  assert.deepEqual(viaResolver.resolved.point, { x: 10, y: 10 });
});

test('rung 7: point resolves inside a bbox, then falls back to a synthetic 1x1 target', () => {
  const target = normalizeTarget({ point: { x: 10, y: 20 } });
  const inside = resolveTarget(target, { controls: [{ id: 'in', bbox: { x: 0, y: 0, width: 20, height: 40 } }] });
  assert.equal(inside.ok, true);
  assert.equal(inside.kind, 'point');
  assert.equal(inside.resolved.element.id, 'in');
  assert.equal(inside.coordinateFallback, true);
  // the real element's centre is used, not the requested point
  assert.deepEqual(inside.resolved.point, { x: 10, y: 20 });

  const synthetic = resolveTarget(target, {});
  assert.equal(synthetic.ok, true);
  assert.equal(synthetic.coordinateFallback, true);
  // the synthetic box is anchored at the requested point, so its ROUNDED centre
  // lands one pixel down and right of it (donor geometry, DEFECT 4 below)
  assert.deepEqual(synthetic.resolved, {
    kind: 'point',
    ref: null,
    handle: null,
    bbox: { x: 10, y: 20, width: 1, height: 1 },
    point: { x: 11, y: 21 },
    role: null,
    name: null,
    selector: null,
    disabled: null,
    visible: null,
    element: { ref: null, kind: 'point', bbox: { x: 10, y: 20, width: 1, height: 1 }, point: { x: 10, y: 20 }, synthetic: true },
    candidates: 1,
    coordinateFallback: true,
    resolvedAt: null,
  });
});

test('the ladder is walked in rank order and every rung is recorded until one hits', () => {
  // a target that carries four rungs, none of which can hit in an empty world
  const target = normalizeTarget({
    point: { x: 900, y: 900 },
    bbox: { x: 900, y: 900, width: 10, height: 10 },
    text: 'Nothing',
    accessibility: { name: 'Nothing' },
  });
  const result = resolveTarget(target, {});
  // point has no resolver and always synthesizes, so it is the rung that hits
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'point');
  assert.deepEqual(result.attempts.map((a) => a.kind), ['accessibility', 'semantic', 'bbox', 'point']);
  assert.deepEqual(result.attempts.map((a) => a.ok), [false, false, false, true]);
  assert.deepEqual(result.attempts.map((a) => a.reason), ['no match', 'no match', 'no match', null]);
});

test('a candidate list is the ladder written by hand: candidates first, in order, then the wrapper', () => {
  const state = world();
  const target = normalizeTarget([{ accessibility: { automationId: 'missing' } }, '#save']);
  const result = resolveTarget(target, state);
  // candidate 1 misses on accessibility, candidate 2 hits on selector
  assert.deepEqual(result.attempts.map((a) => `${a.kind}:${a.ok}`), ['accessibility:false', 'selector:true']);
  assert.equal(result.kind, 'selector');
  assert.equal(result.resolved.element, state.controls[0]);

  // when no candidate hits, the wrapper target is tried last: it carries the
  // candidate's kind but none of its query, so the donor walks that rung twice
  const none = resolveTarget(normalizeTarget([{ accessibility: { automationId: 'missing' } }]), {});
  assert.equal(none.ok, false);
  assert.deepEqual(none.attempts, [
    { kind: 'accessibility', ok: false, count: 0, reason: 'no match' },
    { kind: 'accessibility', ok: false, count: 0, reason: 'no match' },
  ]);
  assert.equal(none.error.message, 'target not found: (unresolved)');
});

test('a resolver that throws degrades the ladder: the reason is recorded and the next rung runs', () => {
  const target = normalizeTarget({ selector: '#save', point: { x: 1, y: 2 } });
  const result = resolveTarget(target, {}, {
    selector: () => {
      throw Object.assign(new Error('selector bridge is down'), { code: 'CONTROLLER_UNAVAILABLE' });
    },
  });
  assert.equal(result.ok, true, 'the point rung still gets its turn');
  assert.equal(result.kind, 'point');
  assert.deepEqual(result.attempts, [
    { kind: 'selector', ok: false, count: 0, reason: 'CONTROLLER_UNAVAILABLE' },
    { kind: 'point', ok: true, count: 1, reason: null },
  ]);
});

test('an error without a code records its message as the reason', () => {
  const result = resolveTarget(normalizeTarget({ selector: '#save', point: { x: 1, y: 2 } }), {}, {
    selector: () => {
      throw new Error('plain failure');
    },
  });
  assert.equal(result.attempts[0].reason, 'plain failure');
  assert.equal(result.ok, true);
});

test('a missing resolver function degrades to the world state instead of failing', () => {
  const state = world();
  // non-function, truthy values are ignored by the typeof check
  const viaWorld = resolveTarget(normalizeTarget('#save'), state, { selector: 'not a function' });
  assert.equal(viaWorld.ok, true);
  assert.equal(viaWorld.resolved.element, state.controls[0]);

  // a resolver that answers nothing is a no-match attempt, not a throw
  const emptyResolver = resolveTarget(normalizeTarget({ selector: '#save', point: { x: 4, y: 4 } }), {}, { selector: () => [] });
  assert.equal(emptyResolver.ok, true);
  assert.equal(emptyResolver.kind, 'point');
  assert.deepEqual(emptyResolver.attempts[0], { kind: 'selector', ok: false, count: 0, reason: 'no match' });

  // a resolver returning null and one returning undefined are both no-match
  for (const answers of [null, undefined]) {
    const result = resolveTarget(normalizeTarget({ selector: '#save', point: { x: 4, y: 4 } }), {}, { selector: () => answers });
    assert.equal(result.attempts[0].count, 0);
    assert.equal(result.attempts[0].reason, 'no match');
  }

  // a resolver returning a bare object (not an array) is one hit with count 1
  const single = resolveTarget(normalizeTarget('#save'), {}, { selector: () => ({ id: 'save', bbox: { x: 0, y: 0, width: 2, height: 2 } }) });
  assert.equal(single.ok, true);
  assert.equal(single.attempts[0].count, 1);
  assert.equal(single.resolved.candidates, 1);
  assert.deepEqual(single.resolved.point, { x: 1, y: 1 });
});

test('resolved descriptors carry the donor fields, including the disabled/visible derivation', () => {
  const enabled = resolveTarget(normalizeTarget('#save'), {
    controls: [{ id: 'save', selector: '#save', enabled: true, offscreen: false, role: 'button', ref: 'w:1' }],
  });
  assert.equal(enabled.resolved.disabled, false);
  assert.equal(enabled.resolved.visible, true);
  assert.equal(enabled.resolved.role, 'button');
  assert.equal(enabled.resolved.ref, 'w:1');
  assert.equal(enabled.resolved.resolvedAt, null);
  assert.equal(enabled.resolved.candidates, 1);

  const disabled = resolveTarget(normalizeTarget('#save'), { controls: [{ selector: '#save', enabled: false }] });
  assert.equal(disabled.resolved.disabled, true);
  assert.equal(disabled.resolved.visible, null, 'neither visible nor offscreen is known');

  const explicit = resolveTarget(normalizeTarget('#save'), {
    controls: [{ selector: '#save', disabled: false, visible: false, enabled: true, offscreen: false }],
  });
  assert.equal(explicit.resolved.disabled, false, 'an explicit disabled wins over enabled');
  assert.equal(explicit.resolved.visible, false, 'an explicit visible wins over offscreen');

  // a bounds object is the second spelling of a bbox, and its centre becomes the point
  const bounds = resolveTarget(normalizeTarget('#save'), { controls: [{ selector: '#save', bounds: { x: 2, y: 4, width: 10, height: 10 } }] });
  assert.deepEqual(bounds.resolved.bbox, { x: 2, y: 4, width: 10, height: 10 });
  assert.deepEqual(bounds.resolved.point, { x: 7, y: 9 });
  // a hit with no bbox and no bounds has no point at all
  const bare = resolveTarget(normalizeTarget('#save'), { controls: [{ selector: '#save' }] });
  assert.equal(bare.resolved.bbox, null);
  assert.equal(bare.resolved.point, null);
  // the hit's selector is preferred, then the target's
  assert.equal(resolveTarget(normalizeTarget('#save'), { controls: [{ selector: '#save', id: 'save' }] }).resolved.selector, '#save');
  assert.equal(resolveTarget(normalizeTarget('#save'), {}, { selector: () => [{ id: 'anything' }] }).resolved.selector, '#save');
});

test('resolveTarget refuses a missing target and reports a missing one with the donor message', () => {
  for (const absent of [null, undefined]) {
    const result = resolveTarget(absent, world());
    assert.equal(result.ok, false);
    assert.equal(result.resolved, null);
    assert.deepEqual(result.attempts, []);
    assert.equal(result.error.code, 'TARGET_INVALID');
    assert.equal(result.error.message, 'no target to resolve');
  }

  const missing = resolveTarget(normalizeTarget('#nope'), world());
  assert.equal(missing.ok, false);
  assert.equal(missing.resolved, null);
  assert.equal(missing.error.code, 'TARGET_NOT_FOUND');
  assert.equal(missing.error.message, 'target not found: selector:#nope');
  assert.deepEqual(missing.error.details, {
    target: 'selector:#nope',
    attempts: [{ kind: 'selector', reason: 'no match' }],
  });
  assert.equal(Object.hasOwn(missing, 'coordinateFallback'), false, 'a failure carries no fallback flag');
});

test('the not-found error quotes the donor label and every attempted rung', () => {
  const target = normalizeTarget([{ accessibility: { name: 'Ghost' } }, { text: 'Ghost' }]);
  const result = resolveTarget(target, {});
  // the wrapper carries no rung of its own, so its label is the donor's fallback
  assert.equal(result.error.message, 'target not found: (unresolved)');
  assert.deepEqual(result.error.details, {
    target: '(unresolved)',
    attempts: [
      { kind: 'accessibility', reason: 'no match' },
      { kind: 'semantic', reason: 'no match' },
      { kind: 'accessibility', reason: 'no match' },
      { kind: 'semantic', reason: 'no match' },
    ],
  });
});

test('a world is optional: an absent world is an empty one, and visibleTargets merge after controls', () => {
  assert.equal(resolveTarget(normalizeTarget('#save'), undefined).ok, false);
  assert.equal(resolveTarget(normalizeTarget('#save'), null).ok, false);
  const both = resolveTarget(normalizeTarget('Save'), {
    controls: [{ id: 'control-save', name: 'Save' }],
    visibleTargets: [{ id: 'visible-save', name: 'Save' }],
  });
  assert.equal(both.resolved.element.id, 'control-save', 'controls come first in the pool');
  // a nullish entry in the pool is skipped, not thrown on
  const nullish = resolveTarget(normalizeTarget('Save'), { controls: [null, undefined, { id: 'save', name: 'Save' }] });
  assert.equal(nullish.resolved.element.id, 'save');
});

// ---------------------------------------------------------------------------
// match predicates

test('matchesAccessibility: substring by default, exact on request, and each field can refuse', () => {
  const node = { role: 'button', controlType: 'Button', name: 'Save Document', automationId: 'saveButton', className: 'PrimaryAction' };

  assert.equal(matchesAccessibility(node, {}), true, 'an empty query matches any node');
  assert.equal(matchesAccessibility(node, { role: 'but' }), true, 'substring by default');
  assert.equal(matchesAccessibility(node, { role: 'BUTTON' }), true, 'case insensitive');
  assert.equal(matchesAccessibility(node, { role: 'edit' }), false, 'role miss');
  assert.equal(matchesAccessibility(node, { name: 'save' }), true);
  assert.equal(matchesAccessibility(node, { name: 'delete' }), false, 'name miss');

  // role accepts node.role OR node.controlType
  assert.equal(matchesAccessibility({ controlType: 'Button' }, { role: 'button' }), true);
  assert.equal(matchesAccessibility({ controlType: 'Edit' }, { role: 'button' }), false);
  // ...but controlType only accepts node.controlType
  assert.equal(matchesAccessibility({ role: 'button' }, { controlType: 'Button' }), false);
  assert.equal(matchesAccessibility({ role: 'button' }, { controlType: 'button' }), false, 'and controlType is never read from role');
  assert.equal(matchesAccessibility({ controlType: 'Button' }, { controlType: 'button' }), true, 'controlType is a case-insensitive substring');
  assert.equal(matchesAccessibility(node, { controlType: 'btn' }), false, '"button" does not contain "btn", so this is a miss');

  // exact turns every substring check into equality, including the role fallback
  assert.equal(matchesAccessibility(node, { role: 'button', exact: true }), true);
  assert.equal(matchesAccessibility(node, { role: 'but', exact: true }), false);
  assert.equal(matchesAccessibility({ controlType: 'Button' }, { role: 'button', exact: true }), true);
  assert.equal(matchesAccessibility(node, { name: 'Save Document', exact: true }), true);
  assert.equal(matchesAccessibility(node, { name: 'save document ', exact: true }), false);
  // exact only counts when it is exactly true
  assert.equal(matchesAccessibility(node, { role: 'but', exact: 1 }), true);
  assert.equal(matchesAccessibility(node, { role: 'but', exact: 'true' }), true, 'a string is never === true');

  assert.equal(matchesAccessibility(node, { className: 'primary' }), true);
  assert.equal(matchesAccessibility(node, { className: 'secondary' }), false, 'className miss');
  assert.equal(matchesAccessibility(node, { automationId: 'saveButton' }), true);
  assert.equal(matchesAccessibility(node, { automationId: 'savebutton' }), false, 'automationId is case sensitive');
  assert.equal(matchesAccessibility(node, { automationId: 'save' }), false, 'automationId is never a substring');
  assert.equal(matchesAccessibility({ name: 'x' }, { automationId: 'y' }), false, 'a missing automationId is the empty string');

  // undefined and null expectations are ignored
  assert.equal(matchesAccessibility(node, { role: undefined, name: null }), true);
  // a missing node can never match
  assert.equal(matchesAccessibility(null, {}), false);
  assert.equal(matchesAccessibility(undefined, {}), false);
  // a null-valued node field reads as the empty string
  assert.equal(matchesAccessibility({ name: null }, { name: '' }), true);
});

test('matchesSemantic: text, label, placeholder, name and role, with the donor precedence', () => {
  const element = {
    name: 'Save',
    text: 'Save document',
    value: 'untitled.txt',
    role: 'button',
    attributes: { placeholder: 'File name', label: 'Document title' },
  };

  assert.equal(matchesSemantic(element, {}), true, 'an empty query matches any element');
  assert.equal(matchesSemantic(element, { text: 'save document' }), true);
  assert.equal(matchesSemantic(element, { text: 'SAVE' }), true, 'case insensitive');
  assert.equal(matchesSemantic(element, { text: 'delete' }), false, 'text miss');
  assert.equal(matchesSemantic(element, { label: 'document title' }), true, 'a label is read from attributes');
  assert.equal(matchesSemantic(element, { label: 'nothing' }), false, 'label miss');
  assert.equal(matchesSemantic(element, { placeholder: 'file name' }), true);
  assert.equal(matchesSemantic(element, { placeholder: 'nothing' }), false, 'placeholder miss');
  assert.equal(matchesSemantic(element, { name: 'save' }), true, 'name is searched inside the joined text');
  assert.equal(matchesSemantic(element, { name: 'untitled' }), true, 'and the value is part of that text');
  assert.equal(matchesSemantic(element, { name: 'nothing' }), false, 'name miss');
  assert.equal(matchesSemantic(element, { role: 'button' }), true);
  assert.equal(matchesSemantic(element, { role: 'BUTTON' }), true);
  assert.equal(matchesSemantic(element, { role: 'but' }), false, 'role is equality, never a substring');
  assert.equal(matchesSemantic(element, { text: 'save', role: 'edit' }), false, 'role still refuses');
  assert.equal(matchesSemantic(element, { text: 'save', role: 'button' }), true);
  assert.equal(matchesSemantic({ name: 'Save' }, { role: 'button' }), false, 'a missing role is the empty string');

  assert.equal(matchesSemantic(null, { text: 'x' }), false);
  assert.equal(matchesSemantic(undefined, {}), false);
  assert.equal(matchesSemantic(element, null), false, 'a missing query never matches');
  assert.equal(matchesSemantic(element, undefined), false);

  // falsy query fields are skipped, so an empty string asserts nothing
  assert.equal(matchesSemantic({ name: 'Save' }, { text: '', label: '', name: '', role: '' }), true);
  // a falsy element field is filtered out of the joined text
  assert.equal(matchesSemantic({ name: '', text: 'Save' }, { name: 'save' }), true);
  assert.equal(matchesSemantic({ name: null, text: 'Save' }, { text: 'save' }), true);
});

test('matchesWindow: handle and processId are typed equality, className and title are substrings', () => {
  const window = { handle: '42', processId: 100, className: 'Notepad', title: 'Untitled - Notepad' };

  assert.equal(matchesWindow(window, {}), true, 'an empty query matches any window');
  assert.equal(matchesWindow(window, { handle: '42' }), true);
  assert.equal(matchesWindow(window, { handle: 42 }), true, 'a numeric handle is stringified');
  assert.equal(matchesWindow(window, { handle: '43' }), false, 'handle miss');
  assert.equal(matchesWindow({ handle: 42 }, { handle: '42' }), true);
  assert.equal(matchesWindow(window, { processId: 100 }), true);
  assert.equal(matchesWindow(window, { processId: '100' }), true, 'a numeric string is coerced');
  assert.equal(matchesWindow(window, { processId: 101 }), false, 'processId miss');
  assert.equal(matchesWindow({ processId: undefined }, { processId: 100 }), false, 'a missing processId is NaN, never equal');
  assert.equal(matchesWindow(window, { className: 'notepad' }), true, 'case insensitive');
  assert.equal(matchesWindow(window, { className: 'pad' }), false, 'className is equality, not a substring');
  assert.equal(matchesWindow(window, { className: 'wordpad' }), false);
  assert.equal(matchesWindow(window, { title: 'notepad' }), true, 'case insensitive substring');
  assert.equal(matchesWindow(window, { title: 'Untitled' }), true);
  assert.equal(matchesWindow(window, { title: 'Chrome' }), false, 'title miss');
  assert.equal(matchesWindow({ title: undefined }, { title: 'x' }), false, 'a missing title is the empty string');

  // falsy query fields assert nothing
  assert.equal(matchesWindow(window, { className: '', title: '' }), true);
  assert.equal(matchesWindow(null, { title: 'x' }), false);
  assert.equal(matchesWindow(undefined, {}), false);
  assert.equal(matchesWindow(window, null), false, 'a missing query never matches');
  assert.equal(matchesWindow(window, undefined), false);
});

// ---------------------------------------------------------------------------
// revalidate

test('revalidate with no previous or no current resolution reports unknown and missing', () => {
  const current = { point: { x: 1, y: 1 } };
  assert.deepEqual(revalidate(null, current), {
    verdict: 'unknown',
    movement: null,
    reason: 'no previous resolution to compare with',
    current,
  });
  assert.deepEqual(revalidate(undefined, current), {
    verdict: 'unknown',
    movement: null,
    reason: 'no previous resolution to compare with',
    current,
  });
  // with nothing on either side the current value is null, not undefined
  assert.deepEqual(revalidate(null, null), {
    verdict: 'unknown',
    movement: null,
    reason: 'no previous resolution to compare with',
    current: null,
  });

  const previous = { point: { x: 1, y: 1 } };
  assert.deepEqual(revalidate(previous, null), {
    verdict: 'missing',
    movement: null,
    reason: 'target is no longer present',
    previous,
  });
  assert.deepEqual(revalidate(previous, undefined), {
    verdict: 'missing',
    movement: null,
    reason: 'target is no longer present',
    previous,
  });
});

test('revalidate re-reads the thresholds from whatever it is given, falling back to the donor values', () => {
  const previous = { point: { x: 0, y: 0 } };
  const at6 = { point: { x: 6, y: 0 } };
  // the donor default is the frozen TARGET_MOVEMENT
  assert.equal(revalidate(previous, at6).verdict, 'updated');
  assert.equal(revalidate(previous, at6, undefined).verdict, 'updated');
  assert.equal(revalidate(previous, at6, {}).verdict, 'updated', 'missing keys fall back');
  // a caller-raised stablePx makes a 6 px move stable
  assert.equal(revalidate(previous, at6, { stablePx: 10 }).verdict, 'stable');
  // a caller-lowered updatePx makes it stale
  assert.equal(revalidate(previous, at6, { updatePx: 5 }).verdict, 'stale');
  // both together, still in the donor's order
  assert.equal(revalidate(previous, at6, { stablePx: 8, updatePx: 5 }).verdict, 'stale', 'updatePx < stablePx leaves no updated band');
  // non-finite values fall back to the donor value, key by key
  assert.equal(revalidate(previous, at6, { stablePx: NaN }).verdict, 'updated');
  assert.equal(revalidate(previous, at6, { stablePx: Infinity }).verdict, 'updated');
  assert.equal(revalidate(previous, at6, { stablePx: 'not a number' }).verdict, 'updated');
  assert.equal(revalidate(previous, at6, { updatePx: NaN }).verdict, 'updated');
  // ...but Number(null) is 0, which IS finite, so the fallback does not fire (DEFECT 8)
  assert.equal(revalidate(previous, at6, { updatePx: null }).verdict, 'stale');
});

test('revalidate: just below, exactly at and just above stablePx', () => {
  const previous = { point: { x: 0, y: 0 } };
  const at = (x) => ({ point: { x, y: 0 } });

  assert.equal(revalidate(previous, at(2.99)).verdict, 'stable');
  assert.equal(revalidate(previous, at(2.99)).movement, 2.99);
  assert.equal(revalidate(previous, at(2.99)).reason, undefined, 'a stable verdict carries no reason');
  assert.equal(revalidate(previous, at(3)).verdict, 'updated', 'stablePx is exclusive: < 3 is stable');
  assert.equal(revalidate(previous, at(3)).movement, 3);
  assert.equal(revalidate(previous, at(3.01)).verdict, 'updated');
  // the threshold is applied to the ROUNDED distance
  assert.equal(revalidate(previous, { point: { x: 2.994, y: 0 } }).movement, 2.99);
  assert.equal(revalidate(previous, { point: { x: 2.994, y: 0 } }).verdict, 'stable');
  assert.equal(revalidate(previous, { point: { x: 2.995, y: 0 } }).movement, 3);
  assert.equal(revalidate(previous, { point: { x: 2.995, y: 0 } }).verdict, 'updated');
});

test('revalidate: just below, exactly at and just above updatePx', () => {
  const previous = { point: { x: 0, y: 0 } };
  const at = (x) => ({ point: { x, y: 0 } });

  assert.equal(revalidate(previous, at(9.99)).verdict, 'updated');
  assert.equal(revalidate(previous, at(9.99)).movement, 9.99);
  assert.equal(revalidate(previous, at(9.99)).reason, 'target moved 9.99px - using the refreshed coordinate');
  assert.equal(revalidate(previous, at(10)).verdict, 'updated', 'updatePx is inclusive: <= 10 is updated');
  assert.equal(revalidate(previous, at(10)).movement, 10);
  assert.equal(revalidate(previous, at(10)).reason, 'target moved 10px - using the refreshed coordinate');
  assert.equal(revalidate(previous, at(10.01)).verdict, 'stale');
  assert.equal(revalidate(previous, at(10.01)).movement, 10.01);
  // without a ref on either side the node counts as different, so the first stale rule fires
  assert.equal(revalidate(previous, at(10.01)).reason, 'target moved 10.01px and is a different node');
});

test('a beyond-tolerance move is stale for the reason that matches the node identity', () => {
  const previous = { point: { x: 0, y: 0 } };
  const far = { point: { x: 20, y: 0 } };
  // no ref anywhere: the donor treats that as a different node
  assert.deepEqual(revalidate(previous, far), {
    verdict: 'stale',
    movement: 20,
    reason: 'target moved 20px and is a different node',
    previous,
    current: far,
  });
  // the same ref: the different-node shortcut does not apply, so the re-observe reason is used
  const sameNode = { ref: 'w:1/0', point: { x: 20, y: 0 } };
  assert.deepEqual(revalidate({ ref: 'w:1/0', point: { x: 0, y: 0 } }, sameNode), {
    verdict: 'stale',
    movement: 20,
    reason: 'target moved 20px - re-observe before acting',
    previous: { ref: 'w:1/0', point: { x: 0, y: 0 } },
    current: sameNode,
  });
});

test('revalidate returns the donor shape for each verdict, with the donor key order', () => {
  const previous = { point: { x: 0, y: 0 } };
  const current = { point: { x: 1, y: 0 } };
  assert.deepEqual(revalidate(previous, current), { verdict: 'stable', movement: 1, current });
  assert.deepEqual(Object.keys(revalidate(previous, current)), ['verdict', 'movement', 'current']);

  const moved = { point: { x: 5, y: 0 } };
  const updated = revalidate(previous, moved);
  assert.deepEqual(updated, {
    verdict: 'updated',
    movement: 5,
    reason: 'target moved 5px - using the refreshed coordinate',
    current: moved,
  });
  assert.deepEqual(Object.keys(updated), ['verdict', 'movement', 'reason', 'current']);

  const far = { point: { x: 20, y: 0 } };
  const stale = revalidate(previous, far);
  assert.deepEqual(stale, {
    verdict: 'stale',
    movement: 20,
    reason: 'target moved 20px and is a different node',
    previous,
    current: far,
  });
  assert.deepEqual(Object.keys(stale), ['verdict', 'movement', 'reason', 'previous', 'current']);
});

test('revalidate uses the bbox centre when a resolution has no point', () => {
  const previous = { bbox: { x: 0, y: 0, width: 10, height: 10 } };
  const current = { bbox: { x: 0, y: 0, width: 10, height: 10 } };
  assert.deepEqual(revalidate(previous, current), { verdict: 'stable', movement: 0, current });

  const shifted = { bbox: { x: 5, y: 0, width: 10, height: 10 } };
  const result = revalidate(previous, shifted);
  assert.equal(result.movement, 5, 'centres at (5,5) and (10,5)');
  assert.equal(result.verdict, 'updated');

  // a point wins over a bbox on the same value
  const both = { point: { x: 100, y: 0 }, bbox: { x: 0, y: 0, width: 10, height: 10 } };
  assert.equal(revalidate(both, { point: { x: 100, y: 0 } }).movement, 0);
});

test('revalidate compares node identity, and a different node defaults to the donor threshold', () => {
  const previous = { ref: 'w:1/0', point: { x: 0, y: 0 } };
  const far = { ref: 'w:1/0', point: { x: 100, y: 0 } };
  // the same ref: the stale-vs-different-node shortcut does not apply
  assert.deepEqual(revalidate(previous, far), {
    verdict: 'stale',
    movement: 100,
    reason: 'target moved 100px - re-observe before acting',
    previous,
    current: far,
  });

  const otherRef = { ref: 'w:1/1', point: { x: 20, y: 0 } };
  assert.equal(revalidate(previous, otherRef).verdict, 'stale');
  assert.equal(revalidate(previous, otherRef).reason, 'target moved 20px and is a different node');
});

test('the different-node rule needs two real refs and follows the caller updatePx', () => {
  const previous = { ref: 'w:1/0', point: { x: 0, y: 0 } };
  const otherRef = { ref: 'w:1/1', point: { x: 20, y: 0 } };
  // a raised updatePx puts the move back inside the updated band
  assert.deepEqual(revalidate(previous, otherRef, { updatePx: 25 }), {
    verdict: 'updated',
    movement: 20,
    reason: 'target moved 20px - using the refreshed coordinate',
    current: otherRef,
  });
  // exactly at the raised threshold the different-node rule does not fire (it is `>`)
  const atThreshold = { ref: 'w:1/1', point: { x: 25, y: 0 } };
  const at = revalidate(previous, atThreshold, { updatePx: 25 });
  assert.equal(at.verdict, 'updated');
  assert.equal(at.reason, 'target moved 25px - using the refreshed coordinate');

  // one side without a ref is not the same node
  const noRef = { point: { x: 20, y: 0 } };
  assert.equal(revalidate(previous, noRef).reason, 'target moved 20px and is a different node');
  // an empty-string ref is falsy, so it never counts as an identity
  const emptyRef = { ref: '', point: { x: 20, y: 0 } };
  const bothEmpty = revalidate({ ref: '', point: { x: 0, y: 0 } }, emptyRef);
  assert.equal(bothEmpty.verdict, 'stale');
  assert.equal(bothEmpty.reason, 'target moved 20px and is a different node');
});

test('a resolution with the same identity but no geometry is stable; without identity it is unknown', () => {
  const same = revalidate({ ref: 'w:1/0' }, { ref: 'w:1/0' });
  assert.deepEqual(same, {
    verdict: 'stable',
    movement: null,
    reason: 'same node identity, no geometry to compare',
    current: { ref: 'w:1/0' },
  });

  const noIdentity = revalidate({ ref: null }, { ref: null });
  assert.deepEqual(noIdentity, {
    verdict: 'unknown',
    movement: null,
    reason: 'no geometry available',
    current: { ref: null },
  });

  // one side has a point and the other does not: no geometry to compare
  const oneSided = revalidate({ ref: 'w:1/0', point: { x: 1, y: 1 } }, { ref: 'w:1/0' });
  assert.equal(oneSided.verdict, 'stable');
  assert.equal(oneSided.movement, null);
  // a bbox of zero extent is still geometry
  const zeroBox = revalidate({ bbox: { x: 0, y: 0, width: 0, height: 0 } }, { bbox: { x: 0, y: 0, width: 0, height: 0 } });
  assert.equal(zeroBox.verdict, 'stable');
  assert.equal(zeroBox.movement, 0);
});

// ---------------------------------------------------------------------------
// donor defects (carried unchanged and pinned here)

test('DEFECT 1: a semantic target that carries no text, label, name or placeholder describes itself as "undefined"', () => {
  // normalizeTarget accepts `{ semantic: { inside: '#dialog' } }`, and describeTarget
  // joins the four text fields without a fallback, so the label is the string
  // "undefined" rather than the '(any)' the accessibility label falls back to.
  const target = normalizeTarget({ semantic: { inside: '#dialog' } });
  assert.deepEqual(target.semantic, { inside: '#dialog' });
  assert.equal(describeTarget(target), 'semantic:undefined');
  const missing = resolveTarget(target, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.error.message, 'target not found: semantic:undefined');
  assert.equal(missing.error.details.target, 'semantic:undefined');
});

test('DEFECT 2: a semantic-only target with no text fields matches EVERY element the world holds', () => {
  // matchesSemantic skips every falsy query field, so `{ inside: '#dialog' }` is an
  // unconstrained predicate: the first control in the pool wins.
  const target = normalizeTarget({ semantic: { inside: '#dialog' } });
  const result = resolveTarget(target, { controls: [{ id: 'first' }, { id: 'second' }] });
  assert.equal(result.ok, true, 'the donor treats an unconstrained semantic query as a match');
  assert.equal(result.resolved.element.id, 'first');
  assert.equal(result.resolved.candidates, 2);
  assert.deepEqual(result.attempts, [{ kind: 'semantic', ok: true, count: 2, reason: null }]);
  assert.equal(matchesSemantic({ id: 'anything at all' }, { inside: '#dialog' }), true);
  assert.equal(matchesSemantic({}, { inside: '#dialog' }), true);
});

test('DEFECT 3: a candidate wrapper re-walks a candidate kind with no query, and only the predicate stops a false hit', () => {
  // A candidate list whose wrapper carries the candidates' kinds is tried again
  // after the candidates fail. The wrapper HAS the accessibility kind but NOT the
  // candidate's query, so `resolveKind` calls `matchAx(state, undefined)`, and
  // `matchAx` does *not* guard its own argument. What prevents an unconstrained
  // match is `matchesAccessibility`'s `if (!node)` head guard: it runs the query
  // through `query.exact` before anything else, so an undefined query throws.
  const state = world();
  const result = resolveTarget(normalizeTarget([{ accessibility: { automationId: 'missing' } }]), state);
  assert.equal(result.ok, false);
  assert.deepEqual(result.attempts, [
    { kind: 'accessibility', ok: false, count: 0, reason: 'no match' },
    { kind: 'accessibility', ok: false, count: 0, reason: 'no match' },
  ]);
  // the predicate throws on a missing query rather than answering it vacuously...
  assert.throws(() => matchesAccessibility(state.controls[0], undefined), TypeError);
  assert.throws(() => matchesAccessibility(state.controls[0], null), TypeError);
  // ...and an empty pool means the wrapper rung never even reaches the predicate,
  // so the whole family of query-less attempts still reports 'no match'
  assert.equal(resolveTarget(normalizeTarget([{ accessibility: { automationId: 'missing' } }]), {}).error.message, 'target not found: (unresolved)');
  // an empty-object query, by contrast, IS vacuously satisfied by any node
  assert.equal(matchesAccessibility(state.controls[0], {}), true);
});

test('DEFECT 4: the synthetic point box is anchored at the point, so its rounded centre is one pixel away', () => {
  const result = resolveTarget(normalizeTarget({ point: { x: 10, y: 20 } }), {});
  assert.deepEqual(result.resolved.bbox, { x: 10, y: 20, width: 1, height: 1 });
  assert.deepEqual(result.resolved.point, { x: 11, y: 21 }, 'centerOf rounds 10.5 up to 11 and 20.5 up to 21');
  // the synthetic element still carries the requested point, so the two differ
  assert.deepEqual(result.resolved.element.point, { x: 10, y: 20 });
  // on even coordinates the rounding is invisible, which is why this is easy to miss
  assert.deepEqual(resolveTarget(normalizeTarget({ point: { x: 10, y: 20 } }), {}).resolved.point, { x: 11, y: 21 });
  assert.deepEqual(resolveTarget(normalizeTarget({ point: { x: 11, y: 21 } }), {}).resolved.point, { x: 12, y: 22 });
});

test('DEFECT 5: window.className is equality, not a substring, while window.title is a substring', () => {
  const window = { handle: '1', className: 'Notepad', title: 'Untitled - Notepad' };
  assert.equal(matchesWindow(window, { className: 'pad' }), false);
  assert.equal(matchesWindow(window, { title: 'pad' }), true);
  assert.equal(matchesWindow(window, { className: 'WordPad' }), false);
});

test('DEFECT 6: a beyond-tolerance move without a ref anywhere is reported as a different node', () => {
  // The donor's first stale rule text assumes two refs exist, but it fires for any
  // `!sameIdentity`, including the common "neither side carries a ref" case.
  const result = revalidate({ point: { x: 0, y: 0 } }, { point: { x: 20, y: 0 } });
  assert.equal(result.verdict, 'stale');
  assert.equal(result.reason, 'target moved 20px and is a different node');
});

test('DEFECT 7: distance() propagates NaN instead of refusing a missing coordinate', () => {
  assert.equal(Number.isNaN(distance({ x: 0, y: 0 }, { x: 1 })), true);
  // and revalidate inherits it: a NaN movement is neither stable nor updated, so it is stale
  const result = revalidate({ point: { x: 0, y: 0 } }, { point: { x: 1 } });
  assert.equal(Number.isNaN(result.movement), true);
  assert.equal(result.verdict, 'stale');
  assert.equal(result.reason, 'target moved NaNpx - re-observe before acting');
});

test('DEFECT 8: Number(null) is 0, so an explicit null threshold is treated as 0 rather than as absent', () => {
  // Number.isFinite(Number(null)) is true, so the donor's fallback does not fire.
  const previous = { point: { x: 0, y: 0 } };
  const current = { point: { x: 1, y: 0 } };
  assert.deepEqual(revalidate(previous, current, { updatePx: null }), {
    verdict: 'stale',
    movement: 1,
    reason: 'target moved 1px and is a different node',
    previous,
    current,
  });
  assert.deepEqual(revalidate(previous, current, { stablePx: null }), {
    verdict: 'updated',
    movement: 1,
    reason: 'target moved 1px - using the refreshed coordinate',
    current,
  });
});

test('DEFECT 9: an empty window or visual object is still a rung, because compact() keeps the container', () => {
  // `compact()` strips undefined FIELDS but is always assigned, so `window: {}` and
  // `visual: {}` (and any visual whose every field was dropped) survive as an empty
  // object that `targetKinds` accepts as a rung. The result describes itself as
  // 'window:(any)' / 'visual:template' and resolves to nothing.
  assert.deepEqual(normalizeTarget({ window: {} }), { window: {}, kinds: ['window'], rank: 4, primaryKind: 'window' });
  assert.equal(describeTarget(normalizeTarget({ window: {} })), 'window:(any)');
  assert.deepEqual(normalizeTarget({ window: { processName: 'notepad.exe' } }), {
    window: {},
    kinds: ['window'],
    rank: 4,
    primaryKind: 'window',
  });
  assert.deepEqual(normalizeTarget({ window: { pid: 1.5 } }).kinds, ['window'], 'a non-integer pid is dropped, not refused');
  assert.deepEqual(normalizeTarget({ visual: {} }), { visual: {}, kinds: ['visual'], rank: 6, primaryKind: 'visual' });
  assert.equal(describeTarget(normalizeTarget({ visual: {} })), 'visual:template');
  // resist the temptation to read an empty rung as a hit: the world still decides
  assert.equal(resolveTarget(normalizeTarget({ window: {} }), {}).ok, false);
  assert.equal(resolveTarget(normalizeTarget({ window: {} }), { windows: [{ handle: '1' }] }).ok, true, 'an empty query matches any window');
  assert.equal(resolveTarget(normalizeTarget({ window: {} }), { windows: [null] }).ok, false, 'a nullish window entry is still filtered out');
  assert.equal(resolveTarget(normalizeTarget({ visual: {} }), {}).ok, false, 'visual is never resolved from world state');
});

test('DEFECT 10: the flat trigger list has a typo that costs `template_path`, and page is never a rung', () => {
  // The visual trigger test is `raw.visual || raw.paint || raw.template` — it reads
  // `raw.template`, while the object it then builds looks for `visual.templatePath`
  // or `visual.template_path`. A bare `template_path` therefore triggers nothing and
  // the otherwise valid target is refused with the no-rung message.
  assert.throws(() => normalizeTarget({ template_path: 'x.png' }), { code: 'TARGET_INVALID', message: NO_RUNG_MESSAGE });
  assert.throws(() => normalizeTarget({ template: undefined, template_path: 'x.png' }), { message: NO_RUNG_MESSAGE });
  // `page` / `tab` / `tabId` are read into `target.page` but are not in
  // `targetKinds`, so they never form a rung: a sheet reference alone is a refusal
  assert.throws(() => normalizeTarget({ page: 'tab-7' }), { message: NO_RUNG_MESSAGE });
  assert.throws(() => normalizeTarget({ tab: 'x' }), { message: NO_RUNG_MESSAGE });
  assert.throws(() => normalizeTarget({ tabId: 12 }), { message: NO_RUNG_MESSAGE });
  // with a real rung present all four fields are carried through
  assert.deepEqual(normalizeTarget({ selector: '#s', page: 'p', tab: 't', tabId: 12 }).page, 'p');
  assert.deepEqual(normalizeTarget({ paint: 'red', template_path: 'x.png' }).visual, { paint: { color: 'red' }, templatePath: 'x.png' });
});

test('DEFECT 11: a truthy non-integer accessibility index is silently dropped, and 0 is kept', () => {
  // Number.isInteger guards the field, so index 1.5 disappears rather than raising.
  assert.deepEqual(normalizeTarget({ accessibility: { name: 'Save', index: 1.5 } }).accessibility, { name: 'Save' });
  assert.deepEqual(normalizeTarget({ accessibility: { name: 'Save', index: '2' } }).accessibility, { name: 'Save' });
  assert.deepEqual(normalizeTarget({ accessibility: { name: 'Save', index: 0 } }).accessibility, { name: 'Save', index: 0 });
  // index is carried but never consulted by matchesAccessibility, which has no index rule
  assert.equal(matchesAccessibility({ name: 'Save' }, { name: 'Save', index: 7 }), true);
  assert.equal(matchesAccessibility({ name: 'Save' }, { index: 0 }), true);
});

test('DEFECT 12: a false-named exact is still a substring match, because `exact` needs the boolean true', () => {
  const node = { name: 'Save Document' };
  assert.equal(matchesAccessibility(node, { name: 'Save', exact: true }), false);
  assert.equal(matchesAccessibility(node, { name: 'Save', exact: 1 }), true, 'the number 1 is not === true');
  assert.equal(matchesAccessibility(node, { name: 'Save', exact: 'false' }), true, 'nor is the string "false"');
  assert.equal(matchesAccessibility(node, { name: 'save document', exact: true }), true);
  // and a truthy coercion to the boolean true does select exact matching
  assert.equal(matchesAccessibility(node, { name: 'Save', exact: Boolean(1) }), false);
});

test('DEFECT 13: buildResolved prefers an explicit disabled/visible only when that field is present', () => {
  const withBoth = resolveTarget(normalizeTarget('#save'), { controls: [{ selector: '#save', disabled: true, enabled: true }] });
  assert.equal(withBoth.resolved.disabled, true, 'disabled wins when both are present');
  const falsyDisabled = resolveTarget(normalizeTarget('#save'), { controls: [{ selector: '#save', disabled: false, enabled: false }] });
  assert.equal(falsyDisabled.resolved.disabled, false, 'a present but false disabled still wins');
  const onlyEnabled = resolveTarget(normalizeTarget('#save'), { controls: [{ selector: '#save', enabled: false }] });
  assert.equal(onlyEnabled.resolved.disabled, true);
  // visible is derived from offscreen the same way
  assert.equal(resolveTarget(normalizeTarget('#save'), { controls: [{ selector: '#save', visible: true, offscreen: true }] }).resolved.visible, true);
  assert.equal(resolveTarget(normalizeTarget('#save'), { controls: [{ selector: '#save', offscreen: true }] }).resolved.visible, false);
});

test('DEFECT 14: exact-match accessibility still ignores an empty-string automationId expectation on the node', () => {
  // The automationId rule is not part of the `same()` helper, so `exact` does not
  // reach it: it is always a case-sensitive string equality against `''`.
  assert.equal(matchesAccessibility({ automationId: 'Save' }, { automationId: 'Save', exact: true }), true);
  assert.equal(matchesAccessibility({ automationId: 'Save' }, { automationId: 'save', exact: true }), false);
  assert.equal(matchesAccessibility({ automationId: 'SAVE' }, { automationId: 'AVE', exact: true }), false, 'never a substring, exact or not');
});
