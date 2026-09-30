/**
 * UTOPIA · Research Institute — deterministic figure suite.
 *
 * Restates the Codex-Boss donor `src/shared/research-figures.ts` @
 * 8df428eaa437a409368401e95194e40266b83080: the same input always produces the same
 * SVG bytes, and the bounds, escapes and coordinate arithmetic are pinned exactly —
 * including the donor's non-finite-value rendering as `n/a`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  FIGURE_DEFAULT_HEIGHT,
  FIGURE_DEFAULT_TITLE,
  FIGURE_DEFAULT_WIDTH,
  FIGURE_MAX_BARS,
  FIGURE_MAX_LABEL,
  FIGURE_MAX_TITLE,
  FIGURE_MAX_YLABEL,
  figure,
  figureBar,
  figureForRuns,
  figureOptions,
  metricFigureSvg,
} from '../index.mjs';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

test('the frozen figure vocabulary keeps the donor defaults and bounds', () => {
  assert.equal(FIGURE_DEFAULT_WIDTH, 480);
  assert.equal(FIGURE_DEFAULT_HEIGHT, 260);
  assert.equal(FIGURE_DEFAULT_TITLE, 'Metric');
  assert.equal(FIGURE_MAX_BARS, 40);
  assert.equal(FIGURE_MAX_LABEL, 24);
  assert.equal(FIGURE_MAX_TITLE, 80);
  assert.equal(FIGURE_MAX_YLABEL, 40);
});

test('a concrete chart is emitted byte for byte', () => {
  const svg = metricFigureSvg([
    { label: 'run 1', value: 0.5 },
    { label: 'run 2', value: 1 },
  ]);

  assert.equal(
    svg,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260" viewBox="0 0 480 260">',
      '<rect width="480" height="260" fill="#141a12"/>',
      '<text x="64" y="20" font-size="13" fill="#e6e2c8">Metric</text>',
      '<text x="14" y="130" font-size="9" fill="#9fb3a2" transform="rotate(-90 14 130)" text-anchor="middle"></text>',
      '<rect x="140.0" y="127.0" width="48.0" height="93.0" fill="#3d7ea6"/>',
      '<text x="164.0" y="234.0" font-size="9" text-anchor="middle" fill="#cfd8d0">run 1</text>',
      '<text x="164.0" y="123.0" font-size="9" text-anchor="middle" fill="#e6e2c8">0.500</text>',
      '<rect x="340.0" y="34.0" width="48.0" height="186.0" fill="#3d7ea6"/>',
      '<text x="364.0" y="234.0" font-size="9" text-anchor="middle" fill="#cfd8d0">run 2</text>',
      '<text x="364.0" y="30.0" font-size="9" text-anchor="middle" fill="#e6e2c8">1.000</text>',
      '</svg>',
      '',
    ].join('\n'),
  );

  // layout arithmetic, stated independently of the pinned string
  assert.equal(svg.length, 851, 'the emitted document has the pinned length');
  assert.equal(svg.split('\n').length, 13);
  assert.ok(svg.endsWith('</svg>\n'), 'the document ends with the closing tag and a newline');
  assert.equal((svg.match(/<rect x=/g) ?? []).length, 2, 'one bar per input value');
  // plot height 186 = 260 - 34 - 40; 0.5 of the maximum is 93 tall, and the taller
  // bar starts at the plot top
  assert.match(svg, /height="93\.0"/);
  assert.match(svg, /height="186\.0"/);
});

test('the chart is deterministic, and its digest is pinned at full length', () => {
  const bars = [
    { label: 'run 1', value: 0.5 },
    { label: 'run 2', value: 1 },
  ];
  const first = metricFigureSvg(bars);
  const second = metricFigureSvg([
    { label: 'run 1', value: 0.5 },
    { label: 'run 2', value: 1 },
  ]);
  assert.equal(first, second, 'same input, same bytes');
  assert.notEqual(first, metricFigureSvg([
    { label: 'run 1', value: 0.5 },
    { label: 'run 2', value: 0.25 },
  ]), 'a different value changes the bytes');

  const digest = sha256(first);
  assert.equal(digest, 'e14e35fd0ae01422d224c06c6c2eb7f4ba0a9654f50ceb9e5cb7799c7a244395');
  assert.equal(digest.length, 64, 'SHA-256 is 64 hex characters');
  assert.equal(sha256(second), digest);
});

test('rows and labels stay bounded at the donor limits', () => {
  const many = Array.from({ length: 41 }, (_, index) => ({ label: `r${index}`, value: index + 1 }));
  const svg = metricFigureSvg(many);
  assert.equal((svg.match(/<rect x=/g) ?? []).length, 40, 'only the first 40 rows are drawn');
  assert.ok(!svg.includes('>r40</text>'), 'the 41st row is dropped, not relabelled');
  assert.ok(svg.includes('>r39</text>'), 'the 40th row is the last one drawn');

  const longLabel = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const longTitle = 'T'.repeat(100);
  const longYLabel = 'Y'.repeat(60);
  const bounded = metricFigureSvg([{ label: longLabel, value: 1 }], { title: longTitle, yLabel: longYLabel });
  assert.ok(bounded.includes(`>${longLabel.slice(0, 24)}</text>`), 'the label is sliced to 24 characters');
  assert.ok(!bounded.includes(longLabel), 'no label longer than 24 characters is emitted');
  assert.ok(bounded.includes(`>${'T'.repeat(80)}</text>`), 'the title is sliced to 80 characters');
  assert.ok(!bounded.includes('T'.repeat(81)), 'no title longer than 80 characters is emitted');
  assert.ok(bounded.includes(`>${'Y'.repeat(40)}</text>`), 'the y label is sliced to 40 characters');
  assert.ok(!bounded.includes('Y'.repeat(41)), 'no y label longer than 40 characters is emitted');
});

test('user-controlled text is escaped for SVG', () => {
  const svg = metricFigureSvg([{ label: '<a> & "b" \'c\'', value: 1 }], { title: 'A & B < C', yLabel: 'x > y' });
  assert.ok(svg.includes('>&lt;a&gt; &amp; &quot;b&quot; &#39;c&#39;</text>'), 'label characters are escaped');
  assert.ok(svg.includes('>A &amp; B &lt; C</text>'), 'the title is escaped');
  assert.ok(svg.includes('>x &gt; y</text>'), 'the y label is escaped');
  assert.ok(!svg.includes('<a>'), 'no raw user text reaches the document');
  assert.ok(!svg.includes('&amp;lt;'), 'escaping is applied once, not twice');
});

test('options and defaults flow through without changing the donor rules', () => {
  const bars = [{ label: 'only', value: 0.25 }];
  const plain = metricFigureSvg(bars);
  assert.ok(plain.includes('width="480" height="260" viewBox="0 0 480 260"'));
  assert.ok(plain.includes('>Metric</text>'), 'the default title is Metric');
  assert.ok(plain.includes('transform="rotate(-90 14 130)"'), 'the default y label is empty');
  assert.ok(plain.includes('height="46.5"'), 'the maximum is floored at 1, so 0.25 draws 46.5 of 186');

  const sized = metricFigureSvg(bars, { width: 320, height: 200, title: 'accuracy by run', yLabel: 'accuracy' });
  assert.ok(sized.includes('width="320" height="200" viewBox="0 0 320 200"'));
  assert.ok(sized.includes('>accuracy by run</text>'));
  assert.ok(sized.includes('>accuracy</text>'));
  // plot width 320 - 64 - 16 = 240; a single bar is capped at 48 wide
  assert.ok(sized.includes('width="48.0"'), 'bar width stays capped at 48');
  assert.ok(sized.includes('rotate(-90 14 100)'), 'the y label follows height / 2');

  const narrow = metricFigureSvg(bars, { width: 100, height: 60 });
  assert.ok(narrow.includes('width="100" height="60" viewBox="0 0 100 60"'));
  // the plot area has a floor of 80 x 60, so a tiny chart still draws
  assert.equal(narrow.split('\n').length, 10, 'header, rect, texts, one bar and the close');
});

test('edge inputs render exactly as the donor renders them', () => {
  const empty = metricFigureSvg([]);
  assert.equal(
    empty,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260" viewBox="0 0 480 260">',
      '<rect width="480" height="260" fill="#141a12"/>',
      '<text x="64" y="20" font-size="13" fill="#e6e2c8">Metric</text>',
      '<text x="14" y="130" font-size="9" fill="#9fb3a2" transform="rotate(-90 14 130)" text-anchor="middle"></text>',
      '',
      '</svg>',
      '',
    ].join('\n'),
    'no bars still emits a well-formed, self-closed document',
  );

  // A non-finite value keeps the donor's `n/a` label AND its `NaN` coordinates. The
  // chart is knowingly malformed for such input; the donor did not guard it either.
  const nan = metricFigureSvg([{ label: 'x', value: Number.NaN }]);
  assert.equal(
    nan,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260" viewBox="0 0 480 260">',
      '<rect width="480" height="260" fill="#141a12"/>',
      '<text x="64" y="20" font-size="13" fill="#e6e2c8">Metric</text>',
      '<text x="14" y="130" font-size="9" fill="#9fb3a2" transform="rotate(-90 14 130)" text-anchor="middle"></text>',
      '<rect x="240.0" y="NaN" width="48.0" height="NaN" fill="#3d7ea6"/>',
      '<text x="264.0" y="234.0" font-size="9" text-anchor="middle" fill="#cfd8d0">x</text>',
      '<text x="264.0" y="NaN" font-size="9" text-anchor="middle" fill="#e6e2c8">n/a</text>',
      '</svg>',
      '',
    ].join('\n'),
    'a non-finite value is labelled n/a, exactly as the donor labels it',
  );
  assert.ok(nan.includes('>n/a</text>'));
  assert.ok(nan.includes('height="NaN"'));

  const negative = metricFigureSvg([{ label: 'neg', value: -5 }]);
  assert.ok(negative.includes('height="1.0"'), 'a bar height has a floor of 1');
  const zeros = metricFigureSvg([{ label: 'a', value: 0 }, { label: 'b', value: 0 }]);
  assert.equal((zeros.match(/height="1\.0"/g) ?? []).length, 2, 'zero values draw a 1-unit bar each');

  const missingLabel = metricFigureSvg([{ value: 1 }]);
  assert.ok(missingLabel.includes('></text>'), 'a missing label renders as empty text');
});

test('figureForRuns is the donor wrapper: name runs.svg, title passed through', () => {
  const values = [
    { label: 'run 1', value: 0.5 },
    { label: 'run 2', value: 1 },
  ];
  const wrapped = figureForRuns('accuracy by recorded run', values);
  assert.deepEqual(Object.keys(wrapped), ['name', 'svg']);
  assert.equal(wrapped.name, 'runs.svg');
  assert.equal(wrapped.svg, metricFigureSvg(values, { title: 'accuracy by recorded run' }));
  assert.ok(wrapped.svg.includes('>accuracy by recorded run</text>'));
  assert.ok(!wrapped.svg.includes('>Metric</text>'), 'the wrapper does not keep the default title');
});

test('the figure factories validate, freeze, copy and never repair', () => {
  const bar = figureBar({ label: 'run 1', value: 0.5 });
  assert.deepEqual(bar, { label: 'run 1', value: 0.5 });
  assert.ok(Object.isFrozen(bar));
  assert.throws(() => figureBar({ label: 'run 1', value: Number.NaN }), {
    name: 'TypeError',
    message: 'bar.value must be a finite number',
  });
  assert.throws(() => figureBar({ label: 'x', value: '0.5' }), { message: 'bar.value must be a finite number' });
  assert.throws(() => figureBar(null), { message: 'bar must be an object' });
  assert.throws(() => figureBar({ value: undefined }), { message: 'bar.value must be a finite number' });
  assert.deepEqual(figureBar({ value: 1 }), { label: null, value: 1 }, 'an absent label stays absent, not invented');

  const options = figureOptions({ title: 'accuracy', width: 320, yLabel: 'accuracy' });
  assert.deepEqual(options, { title: 'accuracy', width: 320, yLabel: 'accuracy' });
  assert.ok(Object.isFrozen(options));
  assert.deepEqual(figureOptions(), {});
  assert.throws(() => figureOptions({ width: '320' }), { message: 'options.width must be a finite number' });
  assert.throws(() => figureOptions({ height: Number.POSITIVE_INFINITY }), {
    message: 'options.height must be a finite number',
  });
  assert.throws(() => figureOptions({ title: '   ' }), { message: 'options.title must be a non-empty string' });
  assert.throws(() => figureOptions({ yLabel: '' }), { message: 'options.yLabel must be a non-empty string' });
  assert.throws(() => figureOptions(null), { message: 'options must be an object' });

  const artifact = figure({ name: 'runs.svg', svg: '<svg/>' });
  assert.deepEqual(artifact, { name: 'runs.svg', svg: '<svg/>' });
  assert.ok(Object.isFrozen(artifact));
  assert.throws(() => figure({ name: 'runs.svg' }), { message: 'figure.svg must be a string' });
  assert.throws(() => figure({ name: '', svg: '' }), { message: 'figure.name must be a non-empty string' });

  // construction copies: mutating the input afterwards changes nothing
  const bars = [{ label: 'a', value: 1 }];
  const copied = bars.map((entry) => figureBar(entry));
  bars.push({ label: 'b', value: 2 });
  assert.equal(copied.length, 1);
  assert.throws(() => {
    copied[0].value = 99;
  }, TypeError);
});
