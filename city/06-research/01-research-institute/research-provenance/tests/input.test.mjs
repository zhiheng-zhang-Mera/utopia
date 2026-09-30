/**
 * UTOPIA · Research Institute — human-defined research input suite.
 *
 * The validation rules, the question-slug naming and the IR the run starts from
 * restate the Codex-Boss donor `src/shared/research-input.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. The donor read a clock and used
 * `Math.random`; both are injected here, because a pure module may do neither. The
 * IR shape is declared locally — the donor's `ResearchIR` edge was `import type` and
 * therefore carried no runtime dependency, so no sibling module is imported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { humanResearchInput, humanResearchToIR, researchIdFor, validateHumanResearchInput } from '../index.mjs';

const NOW = '2026-09-29T12:00:00.000Z';
const digits = (value) => () => value;
const countDigits = (value) => {
  let calls = 0;
  const source = () => {
    calls += 1;
    return value;
  };
  source.calls = () => calls;
  return source;
};

const budget = { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1 };

test('the run id is the question slug plus injected entropy, never a timestamp', () => {
  // the slug is the lower-cased question, tokenised on runs of non-alphanumerics
  assert.equal(researchIdFor('Does X Cause Y? Yes, Really!', 6, digits('a')), 'does-x-cause-y-yes-really-aaaaaaaaaaaa');
  assert.equal(researchIdFor('Does {X} Cause Y? Yes, Really!', 6, digits('a')).length, 38);
  // at most six tokens by default
  assert.equal(researchIdFor('one two three four five six seven', 6, digits('0')), 'one-two-three-four-five-six-000000000000');
  // the slug is capped at 60 characters, and the hex follows it untruncated
  const longId = researchIdFor(`${'a'.repeat(80)} tail`, 4, digits('f'));
  assert.equal(longId, `${'a'.repeat(60)}-ffffffff`);
  assert.equal(longId.length, 69);
  assert.equal(longId.split('-')[0].length, 60);
  // an empty slug falls back to "research", not to an empty id
  assert.equal(researchIdFor('!!!', 2, digits('a')), 'research-aaaa');
  assert.equal(researchIdFor('!!!', 0, digits('a')), 'research-');
  // the loop runs entropy * 2 times: entropy is a byte count, not a character count
  assert.equal(researchIdFor('Q', 1, digits('b')), 'q-bb');
  assert.equal(researchIdFor('Q', 0, digits('b')), 'q-');
  assert.equal(researchIdFor('Q', 6, digits('b')), 'q-bbbbbbbbbbbb');
  // the default entropy is the donor's 6 (12 hex characters) and the default source is hex
  assert.match(researchIdFor('Alpha Beta'), /^alpha-beta-[0-9a-f]{12}$/);
  assert.match(researchIdFor('HTML5 & CSS3: A Study'), /^html5-css3-a-study-[0-9a-f]{12}$/);
});

test('humanResearchToIR builds the donor IR, with the donor defaults and the injected clock', () => {
  const source = { researchQuestion: '  Does X cause Y?  ', workspace: '  ws/path  ', hypothesis: '  h  ', constraints: ['c1'], providerPolicy: 'FIXED', reviewers: ['r1'], budget: { maxSteps: 3, maxExperiments: 4, maxProviderCalls: 5, maxRuntimeMinutes: 6 } };
  const snapshot = JSON.parse(JSON.stringify(source));
  const ir = humanResearchToIR(source, NOW, digits('b'));

  assert.deepEqual(ir, {
    schemaVersion: 1,
    id: 'does-x-cause-y-bbbbbbbbbbbb',
    goal: 'Does X cause Y?',
    scope: {
      workspace: 'ws/path',
      allowedDomains: [],
      reviewers: ['r1'],
      autonomy: 'AUTOPILOT',
      providerPolicy: 'FIXED',
      budget: { maxSteps: 3, maxExperiments: 4, maxProviderCalls: 5, maxRuntimeMinutes: 6 },
    },
    state: 'SCOPING',
    researchQuestions: ['Does X cause Y?'],
    hypotheses: ['h'],
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.deepEqual(source, snapshot, 'the input is not mutated');

  // the human anchor is the trimmed question: goal, researchQuestions[0] and the id slug
  assert.equal(ir.goal, ir.researchQuestions[0]);
  assert.equal(ir.goal, 'Does X cause Y?');
  assert.equal(researchIdFor(ir.goal, 6, digits('b')), ir.id, 'the id is the trimmed question slug plus entropy');
  // createdAt and updatedAt are both the injected timestamp, written verbatim
  assert.equal(ir.createdAt, NOW);
  assert.equal(ir.updatedAt, NOW);

  // the donor's declared defaults, field for field
  const minimal = humanResearchToIR({ researchQuestion: 'Q', workspace: 'W', budget }, 'T', digits('c'));
  assert.deepEqual(minimal, {
    schemaVersion: 1,
    id: 'q-cccccccccccc',
    goal: 'Q',
    scope: {
      workspace: 'W',
      allowedDomains: [],
      reviewers: ['research:auto'],
      autonomy: 'AUTOPILOT',
      providerPolicy: 'AUTO',
      budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1 },
    },
    state: 'SCOPING',
    researchQuestions: ['Q'],
    hypotheses: [],
    createdAt: 'T',
    updatedAt: 'T',
  });
  assert.deepEqual(Object.keys(minimal.scope.budget), ['maxSteps', 'maxExperiments', 'maxProviderCalls'], 'no maxRuntimeMinutes is invented');
  assert.deepEqual(Object.keys(minimal), ['schemaVersion', 'id', 'goal', 'scope', 'state', 'researchQuestions', 'hypotheses', 'createdAt', 'updatedAt']);
  // the default source reaches the injected default entropy of 6 (12 hex characters)
  assert.match(humanResearchToIR({ researchQuestion: 'Q', workspace: 'W', budget }, 'T').id, /^q-[0-9a-f]{12}$/);

  // a caller-supplied id wins and the entropy source is never consulted
  const spy = countDigits('f');
  assert.equal(humanResearchToIR({ id: 'run-42', researchQuestion: 'Q', workspace: 'W', budget }, 'T', spy).id, 'run-42');
  assert.equal(spy.calls(), 0);
  // the donor uses ?? : an empty id is kept, not replaced
  assert.equal(humanResearchToIR({ id: '', researchQuestion: 'Q', workspace: 'W', budget }, 'T', digits('f')).id, '');
  // whitespace-only optional fields are refused by the validator, so hypotheses is never [''] 
  assert.throws(() => humanResearchToIR({ researchQuestion: 'Q', workspace: 'W', hypothesis: '  ', budget }, 'T', digits('f')), { name: 'Error', message: 'hypothesis invalid' });

  // validation is the single gate and it runs first: an invalid input never reaches the generator
  const gateSpy = countDigits('f');
  assert.throws(() => humanResearchToIR({ researchQuestion: '', workspace: 'W', budget }, 'T', gateSpy), { name: 'Error', message: 'researchQuestion is required (1–20000 chars) and immutable' });
  assert.equal(gateSpy.calls(), 0);

  // the IR owns fresh arrays: two runs from the same input cannot share one
  const first = humanResearchToIR({ researchQuestion: 'Q', workspace: 'W', budget }, 'T', digits('f'));
  const second = humanResearchToIR({ researchQuestion: 'Q', workspace: 'W', budget }, 'T', digits('f'));
  assert.notEqual(first.scope.allowedDomains, second.scope.allowedDomains);
  assert.notEqual(first.researchQuestions, second.researchQuestions);
  first.scope.allowedDomains.push('tampered');
  first.researchQuestions.push('tampered');
  assert.deepEqual(second.scope.allowedDomains, []);
  assert.deepEqual(second.researchQuestions, ['Q']);
});

test('the input rules are the donor rules, reachable through the exported validator', () => {
  // the validator is the donor's private function, exported so the rules are testable
  assert.equal(typeof validateHumanResearchInput, 'function');
  assert.equal(validateHumanResearchInput({ researchQuestion: 'Q', workspace: 'W', budget }), undefined);
  // a full budget including maxRuntimeMinutes is accepted
  assert.doesNotThrow(() => validateHumanResearchInput({ researchQuestion: 'Q', workspace: 'W', budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1, maxRuntimeMinutes: 1 } }));

  // the factory and the IR builder both gate on the same validator
  for (const [input, message] of [
    [{ researchQuestion: 'Q', workspace: 'W' }, 'budget requires positive integer maxSteps / maxExperiments / maxProviderCalls'],
    [{ researchQuestion: 'Q', workspace: 'W', constraints: ['x'.repeat(2001)], budget }, 'constraints invalid (max 50 strings)'],
    [{ researchQuestion: 'Q', workspace: 'W', reviewers: ['a', 'b', 'c', 'd', 'e', 'f'], budget }, 'reviewers must be 1–5 runtime ids'],
    [{ researchQuestion: 'Q', workspace: 'W', budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1, maxRuntimeMinutes: '30' } }, 'maxRuntimeMinutes invalid'],
  ]) {
    assert.throws(() => validateHumanResearchInput(input), { name: 'Error', message }, JSON.stringify(input));
    assert.throws(() => humanResearchInput(input), { name: 'Error', message }, `factory: ${JSON.stringify(input)}`);
    assert.throws(() => humanResearchToIR(input, NOW, digits('f')), { name: 'Error', message }, `IR: ${JSON.stringify(input)}`);
  }
});
