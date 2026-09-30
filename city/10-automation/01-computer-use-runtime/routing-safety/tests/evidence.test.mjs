/**
 * UTOPIA · Automation — evidence risk/grade parity suite.
 *
 * Every grade, risk level, bar, reason string and boundary below restates the
 * DS-Hns donor `app/computer-use/evidence.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b. The module is a pure function of the
 * action and the verification result in front of it: no profiles, no learning,
 * no clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRADES,
  GRADE_ORDER,
  HIGH_RISK_ACTIONS,
  LOW_RISK_ACTIONS,
  RISK,
  RISK_BAR,
  RISK_ORDER,
  assess,
  classifyRisk,
  gradeEvidence,
} from '../evidence.mjs';

const success = (kind, extra = {}) => ({ verdict: 'success', kind, ...extra });

test('the grade and risk vocabularies and their orders are the donor ones', () => {
  assert.deepEqual(GRADES, { WEAK: 'weak', MEDIUM: 'medium', STRONG: 'strong' });
  assert.deepEqual(GRADE_ORDER, ['weak', 'medium', 'strong']);
  assert.deepEqual(RISK, { LOW: 'low', STANDARD: 'standard', HIGH: 'high', CRITICAL: 'critical' });
  assert.deepEqual(RISK_ORDER, ['low', 'standard', 'high', 'critical']);
  assert.deepEqual(RISK_BAR, { low: 'weak', standard: 'medium', high: 'strong', critical: 'strong' });
});

test('the risk action sets are the donor lists, in order', () => {
  assert.deepEqual(HIGH_RISK_ACTIONS, [
    'TYPE', 'DOM_TYPE', 'ACCESSIBILITY_SET_VALUE', 'KEY_PRESS', 'HOTKEY', 'FILE_WRITE', 'FILE_MOVE', 'FILE_COPY',
    'FILE_DELETE', 'FILE_MKDIR', 'SHELL_EXEC', 'BROWSER_NAVIGATE', 'OPEN_APP', 'CLOSE_WINDOW', 'ACCESSIBILITY_INVOKE',
  ]);
  assert.equal(HIGH_RISK_ACTIONS.length, 15);
  assert.deepEqual(LOW_RISK_ACTIONS, [
    'MOVE', 'SCROLL', 'FOCUS', 'SWITCH_WINDOW', 'WAIT_EVENT', 'WAIT_STATE', 'FILE_EXISTS', 'FILE_READ',
    'SCREENSHOT_REGION', 'SCREENSHOT_WINDOW', 'SCREENSHOT_FULL',
  ]);
  assert.equal(LOW_RISK_ACTIONS.length, 11);
});

test('no action may be in both the high-risk and the low-risk list', () => {
  for (const type of HIGH_RISK_ACTIONS) assert.equal(LOW_RISK_ACTIONS.includes(type), false, type);
});

test('classifyRisk with no action is standard with the donor reason', () => {
  assert.deepEqual(classifyRisk(null), { risk: 'standard', reasons: ['no action given'] });
  assert.deepEqual(classifyRisk(undefined), { risk: 'standard', reasons: ['no action given'] });
});

test('classifyRisk grades a low-risk action low', () => {
  assert.deepEqual(classifyRisk({ type: 'MOVE', params: {} }), {
    risk: 'low',
    reasons: ['the action only moves the pointer, the view or the focus'],
  });
  assert.deepEqual(classifyRisk({ type: 'SCREENSHOT_FULL', params: {} }).risk, 'low');
  assert.deepEqual(classifyRisk({ type: 'FILE_EXISTS', params: { path: 'a.txt' } }).risk, 'low');
});

test('classifyRisk grades a named side effect high', () => {
  assert.deepEqual(classifyRisk({ type: 'TYPE', params: { text: 'hi' } }), {
    risk: 'high',
    reasons: ['TYPE has a side effect that must not be assumed'],
  });
  assert.equal(classifyRisk({ type: 'FILE_WRITE', params: { path: 'a' } }).risk, 'high');
  assert.equal(classifyRisk({ type: 'SHELL_EXEC', params: { command: 'echo hi' } }).risk, 'high');
});

test('classifyRisk grades an interactive desktop or browser action standard', () => {
  assert.deepEqual(classifyRisk({ type: 'CLICK', capability: 'desktop', params: {} }), {
    risk: 'standard',
    reasons: ['CLICK is an interactive desktop action'],
  });
  assert.deepEqual(classifyRisk({ type: 'DOM_CLICK', capability: 'browser', params: {} }), {
    risk: 'standard',
    reasons: ['DOM_CLICK is an interactive browser action'],
  });
  // a type in neither list and no capability keeps the standard risk silently
  assert.deepEqual(classifyRisk({ type: 'MYSTERY', params: {} }), { risk: 'standard', reasons: [] });
});

test('a declared destructive kind is critical whatever the type is', () => {
  assert.deepEqual(classifyRisk({ type: 'CLICK', params: {}, destructive: ['DELETE'] }), {
    risk: 'critical',
    reasons: ['declared destructive kind(s): DELETE'],
  });
  assert.deepEqual(classifyRisk({ type: 'MOVE', params: {}, destructive: ['PUBLISH', 'SEND'] }).reasons, [
    'declared destructive kind(s): PUBLISH, SEND',
  ]);
});

test('a destructive array is filtered to the donor vocabulary, and an empty one does not raise the risk', () => {
  assert.deepEqual(classifyRisk({ type: 'MOVE', params: {}, destructive: ['DELETE', 'FROBNICATE'] }).reasons, [
    'declared destructive kind(s): DELETE',
  ]);
  assert.deepEqual(classifyRisk({ type: 'MOVE', params: {}, destructive: ['FROBNICATE'] }).risk, 'low');
  assert.deepEqual(classifyRisk({ type: 'MOVE', params: {}, destructive: [] }).risk, 'low');
  // a non-array destructive field is ignored entirely
  assert.deepEqual(classifyRisk({ type: 'MOVE', params: {}, destructive: 'DELETE' }).risk, 'low');
});

test('destructive:true raises the risk on its own and records the donor reason', () => {
  assert.deepEqual(classifyRisk({ type: 'MOVE', params: {}, destructive: true }), {
    risk: 'critical',
    reasons: ['the action declares itself destructive'],
  });
});

test('a destructive description or target name raises the risk to critical', () => {
  const byDescription = classifyRisk({ type: 'CLICK', capability: 'desktop', params: {}, description: 'click the Publish button' });
  assert.equal(byDescription.risk, 'critical');
  assert.deepEqual(byDescription.reasons, [
    'the action text names a destructive or public effect ("(^|[^a-z])(publish|deploy|release|upload|push|submit|send|post|share)([^a-z]|$)")',
  ]);
  assert.equal(byDescription.reasons[0].length, 136);

  const byTarget = classifyRisk({ type: 'CLICK', capability: 'desktop', params: {}, target: { selector: '#delete-account' } });
  assert.equal(byTarget.risk, 'critical');
  assert.equal(byTarget.reasons[0], 'the action text names a destructive or public effect ("(^|[^a-z])(delete|remove|erase|unlink|rmdir|purge|destroy)([^a-z]|$)")');
});

test('the donor keyword table is scanned in order and every field of the target is searched', () => {
  // Each vector names exactly one table entry, so the index is unambiguous.
  assert.equal(classifyRisk({ type: 'CLICK', params: {}, description: 'deploy the build' }).reasons[0].includes('publish|deploy'), true);
  assert.equal(classifyRisk({ type: 'CLICK', params: {}, description: 'delete the row' }).reasons[0].includes('delete|remove'), true);
  assert.equal(classifyRisk({ type: 'CLICK', params: {}, description: 'install the package' }).reasons[0].includes('install|uninstall'), true);
  assert.equal(classifyRisk({ type: 'CLICK', params: {}, description: 'buy the licence' }).reasons[0].includes('purchase|buy'), true);
  assert.equal(classifyRisk({ type: 'CLICK', params: {}, description: 'force the write' }).reasons[0].includes('overwrite|replace|force'), true);

  const viaSemantic = classifyRisk({ type: 'CLICK', params: {}, target: { semantic: { text: 'Deploy build' } } });
  assert.equal(viaSemantic.risk, 'critical');
  const viaAx = classifyRisk({ type: 'CLICK', params: {}, target: { accessibility: { name: 'Buy' } } });
  assert.equal(viaAx.risk, 'critical');
  const viaWindow = classifyRisk({ type: 'CLICK', params: {}, target: { window: { title: 'Install Shield' } } });
  assert.equal(viaWindow.risk, 'critical');
  const viaPath = classifyRisk({ type: 'FILE_READ', params: {}, target: { path: 'C:/force.txt' } });
  assert.equal(viaPath.risk, 'critical');
  const viaText = classifyRisk({ type: 'CLICK', params: {}, target: { text: 'Upload' } });
  assert.equal(viaText.risk, 'critical');
});

test('the declared kinds and the keyword reason are recorded together, kinds last', () => {
  const classified = classifyRisk({ type: 'CLICK', params: {}, description: 'delete the record', destructive: ['DELETE'] });
  assert.deepEqual(classified.reasons, [
    'the action text names a destructive or public effect ("(^|[^a-z])(delete|remove|erase|unlink|rmdir|purge|destroy)([^a-z]|$)")',
    'declared destructive kind(s): DELETE',
  ]);
});

test('a keyword boundary needs a non-letter on each side', () => {
  assert.equal(classifyRisk({ type: 'CLICK', params: {}, description: 'deleted' }).risk, 'standard');
  assert.equal(classifyRisk({ type: 'CLICK', params: {}, description: 'publisher' }).risk, 'standard');
  assert.equal(classifyRisk({ type: 'CLICK', params: {}, description: 'delete' }).risk, 'critical');
  assert.equal(classifyRisk({ type: 'CLICK', params: {}, description: 'delete-account' }).risk, 'critical');
});

test('a modal dismissal is low risk even when its own text names a destructive effect', () => {
  assert.deepEqual(classifyRisk({ type: 'CLICK', capability: 'desktop', params: { __modalDismiss: true }, description: 'Cancel on "Delete this file?"' }), {
    risk: 'low',
    reasons: ['dismissing a dialog changes nothing outside the dialog'],
  });
  // the exemption is the flag, not the text
  assert.equal(classifyRisk({ type: 'CLICK', capability: 'desktop', params: { __modalDismiss: false }, description: 'Delete this file' }).risk, 'critical');
});

test('gradeEvidence refuses to grade anything that did not succeed', () => {
  assert.deepEqual(gradeEvidence({ verification: { verdict: 'failure' } }), {
    grade: 'weak',
    specific: false,
    reasons: ['no successful verification to grade'],
  });
  assert.deepEqual(gradeEvidence({ verification: { verdict: 'unknown', kind: 'file' } }).grade, 'weak');
  assert.deepEqual(gradeEvidence({}).reasons, ['no successful verification to grade']);
});

test('a controller-declared strength wins, and the strongest entry is taken', () => {
  assert.deepEqual(gradeEvidence({ verification: success('state', { evidence: [{ strength: 'strong' }] }) }), {
    grade: 'strong',
    specific: true,
    reasons: ['the evidence entry declared its own strength: strong'],
  });
  assert.deepEqual(gradeEvidence({ verification: success('state', { evidence: [{ strength: 'weak' }, { strength: 'strong' }] }) }).grade, 'strong');
  assert.deepEqual(gradeEvidence({ verification: success('state', { evidence: [{ strength: 'weak' }] }) }).specific, false);
});

test('a single unrecognised declared strength discards the whole declaration', () => {
  const graded = gradeEvidence({ verification: success('state', { evidence: [{ strength: 'strong' }, { strength: 'cosmic' }] }) });
  assert.equal(graded.grade, 'medium');
  assert.deepEqual(graded.reasons, ["state verification observed the target's own state"]);
});

test('the specific verification kinds grade strong and carry the donor reason', () => {
  for (const kind of ['file', 'process', 'navigation']) {
    assert.deepEqual(gradeEvidence({ verification: success(kind) }), {
      grade: 'strong',
      specific: true,
      reasons: [`${kind} verification observed the effect itself (a file, a process exit, a navigation)`],
    });
  }
  assert.equal(gradeEvidence({ verification: success('file') }).reasons[0].length, 83);
});

test('state, focus and visual observations grade medium', () => {
  for (const kind of ['state', 'focus', 'visual']) {
    assert.deepEqual(gradeEvidence({ verification: success(kind) }), {
      grade: 'medium',
      specific: true,
      reasons: [`${kind} verification observed the target's own state`],
    });
  }
});

test('a declared expected effect that held upgrades the observation', () => {
  assert.deepEqual(gradeEvidence({ verification: success('state'), declaredEffect: true }), {
    grade: 'strong',
    specific: true,
    reasons: ['the action declared an expected effect and it held'],
  });
  assert.deepEqual(gradeEvidence({ verification: success('direct'), declaredEffect: true }).grade, 'strong');
  assert.deepEqual(gradeEvidence({ verification: success('event'), declaredEffect: true }).grade, 'strong');
  // any other kind still only reaches medium with a declared effect
  assert.deepEqual(gradeEvidence({ verification: success('none'), declaredEffect: true }), {
    grade: 'medium',
    specific: true,
    reasons: ['the action declared an expected effect and it held'],
  });
});

test('the declared effect is read from the action when the input does not say', () => {
  assert.equal(gradeEvidence({ verification: success('state'), action: { expectedEffect: { any: [{ event: 'saved' }] } } }).grade, 'strong');
  assert.equal(gradeEvidence({ verification: success('state'), action: { expectedEffect: null } }).grade, 'medium');
  // an explicit false beats the action's own expectation
  assert.equal(gradeEvidence({ verification: success('state'), action: { expectedEffect: { any: [] } }, declaredEffect: false }).grade, 'medium');
});

test('a bare change detection grades weak', () => {
  assert.deepEqual(gradeEvidence({ verification: success('direct') }), {
    grade: 'weak',
    specific: false,
    reasons: ['the effect was inferred from a change in the world, not from the intended state'],
  });
  assert.deepEqual(gradeEvidence({ verification: success('event') }).grade, 'weak');
});

test('an unknown or absent verification kind grades weak', () => {
  assert.deepEqual(gradeEvidence({ verification: success('none') }), {
    grade: 'weak',
    specific: false,
    reasons: ['verification kind none carries no specific observation'],
  });
  assert.deepEqual(gradeEvidence({ verification: { verdict: 'success' } }).reasons, ['verification kind none carries no specific observation']);
  assert.deepEqual(gradeEvidence({ verification: success('telepathy') }).reasons, ['verification kind telepathy carries no specific observation']);
});

test('a strong kind outranks a declared strength because it is checked first only when no entry declares one', () => {
  // the declared-strength branch comes first in the donor: a declared weak wins
  // over an otherwise strong kind
  assert.equal(gradeEvidence({ verification: success('file', { evidence: [{ strength: 'weak' }] }) }).grade, 'weak');
  assert.equal(gradeEvidence({ verification: success('file') }).grade, 'strong');
});

test('assess fails immediately when the verdict is not success, whatever the risk', () => {
  const result = assess({ action: { type: 'MOVE', params: {} }, verification: { verdict: 'failure', kind: 'direct' } });
  assert.deepEqual(result, {
    ok: false,
    grade: 'weak',
    required: 'weak',
    risk: 'low',
    reason: 'the action was not verified as a success (verdict: failure)',
    reasons: ['no successful verification to grade', 'the action only moves the pointer, the view or the focus'],
  });
  const missing = assess({ action: { type: 'MOVE', params: {} } });
  assert.equal(missing.reason, 'the action was not verified as a success (verdict: unknown)');
  assert.equal(missing.ok, false);
});

test('a low-risk action clears the bar with weak evidence', () => {
  const result = assess({ action: { type: 'MOVE', params: {} }, verification: success('direct') });
  assert.deepEqual(result, {
    ok: true,
    grade: 'weak',
    required: 'weak',
    risk: 'low',
    reason: 'weak evidence clears the weak bar for a low-risk action',
    reasons: [
      'the effect was inferred from a change in the world, not from the intended state',
      'the action only moves the pointer, the view or the focus',
    ],
  });
});

test('a standard-risk action needs medium evidence: just below fails, just above passes', () => {
  const action = { type: 'CLICK', capability: 'desktop', params: {} };
  const below = assess({ action, verification: success('direct') });
  assert.equal(below.ok, false);
  assert.equal(below.grade, 'weak');
  assert.equal(below.required, 'medium');
  assert.equal(
    below.reason,
    'weak evidence does not clear the medium bar for a standard-risk action: treat this as unverified rather than successful',
  );
  assert.equal(below.reason.length, 119);

  const at = assess({ action, verification: success('state') });
  assert.equal(at.ok, true);
  assert.equal(at.grade, 'medium');
  assert.equal(at.reason, 'medium evidence clears the medium bar for a standard-risk action');

  const above = assess({ action, verification: success('file') });
  assert.equal(above.ok, true);
  assert.equal(above.grade, 'strong');
});

test('a high-risk action needs strong evidence: just below fails, just above passes', () => {
  const action = { type: 'FILE_WRITE', params: { path: 'a.txt' } };
  const below = assess({ action, verification: success('state') });
  assert.equal(below.ok, false);
  assert.equal(below.grade, 'medium');
  assert.equal(below.required, 'strong');
  assert.equal(below.risk, 'high');
  assert.equal(below.reason, 'medium evidence does not clear the strong bar for a high-risk action: treat this as unverified rather than successful');

  // weak is one rung lower still
  const twoBelow = assess({ action, verification: success('direct') });
  assert.equal(twoBelow.ok, false);
  assert.equal(twoBelow.grade, 'weak');

  const at = assess({ action, verification: success('file') });
  assert.equal(at.ok, true);
  assert.equal(at.grade, 'strong');
  assert.equal(at.reason, 'strong evidence clears the strong bar for a high-risk action');

  const withEffect = assess({ action: { ...action, expectedEffect: { file_modified: 'a.txt' } }, verification: success('state') });
  assert.equal(withEffect.ok, true);
  assert.equal(withEffect.grade, 'strong');
});

test('a critical action without a declared effect is refused even with strong evidence', () => {
  const action = { type: 'FILE_WRITE', params: { path: 'a.txt' }, destructive: ['DELETE'] };
  const result = assess({ action, verification: success('file') });
  assert.deepEqual(result, {
    ok: false,
    grade: 'strong',
    required: 'strong',
    risk: 'critical',
    reason: 'a destructive or publishing action must declare its expected effect before it can be accepted',
    reasons: [
      'file verification observed the effect itself (a file, a process exit, a navigation)',
      'declared destructive kind(s): DELETE',
    ],
  });
  assert.equal(result.reason.length, 93);
});

test('a critical action clears the bar only with strong evidence and a declared effect', () => {
  const action = { type: 'FILE_WRITE', params: { path: 'a.txt' }, destructive: ['DELETE'], expectedEffect: { file_modified: 'a.txt' } };
  const ok = assess({ action, verification: success('file') });
  assert.equal(ok.ok, true);
  assert.equal(ok.risk, 'critical');
  assert.equal(ok.reason, 'strong evidence clears the strong bar for a critical-risk action');

  // the same action with no declared effect is refused outright, whatever the grade
  const withoutEffect = assess({ action: { type: 'FILE_WRITE', params: { path: 'a.txt' }, destructive: ['DELETE'] }, verification: success('file') });
  assert.equal(withoutEffect.ok, false);
  assert.equal(withoutEffect.reason, 'a destructive or publishing action must declare its expected effect before it can be accepted');

  // and with the effect declared but no entry declaring a strength, a direct
  // observation is still only medium
  const belowBar = assess({ action, verification: success('none') });
  assert.equal(belowBar.grade, 'medium');
  assert.equal(belowBar.required, 'strong');
  assert.equal(belowBar.ok, false);
  assert.equal(belowBar.reason, 'medium evidence does not clear the strong bar for a critical-risk action: treat this as unverified rather than successful');

  // a claimed-but-weak self-report is the only way to be weak on a critical action
  const weak = assess({ action, verification: success('file', { evidence: [{ strength: 'weak' }] }) });
  assert.equal(weak.grade, 'weak');
  assert.equal(weak.ok, false);
  assert.equal(weak.reason, 'weak evidence does not clear the strong bar for a critical-risk action: treat this as unverified rather than successful');
});

test('the risk bar is not satisfied by a higher risk alone: the grade must reach it', () => {
  const critical = { type: 'CLICK', params: {}, destructive: ['PUBLISH'] };

  // at the bar: a declared effect that held makes a state observation specific
  const atBar = assess({ action: critical, verification: success('state'), declaredEffect: true });
  assert.equal(atBar.required, 'strong');
  assert.equal(atBar.grade, 'strong');
  assert.equal(atBar.ok, true);

  // one rung below: a medium grade against the strong critical bar
  const belowBar = assess({ action: critical, verification: success('none'), declaredEffect: true });
  assert.equal(belowBar.grade, 'medium');
  assert.equal(belowBar.required, 'strong');
  assert.equal(belowBar.ok, false);
  assert.equal(belowBar.reason, 'medium evidence does not clear the strong bar for a critical-risk action: treat this as unverified rather than successful');

  // two rungs below: weak, and the critical effect rule is already satisfied
  const weakest = assess({ action: critical, verification: success('none', { evidence: [{ strength: 'weak' }] }), declaredEffect: true });
  assert.equal(weakest.grade, 'weak');
  assert.equal(weakest.ok, false);
});

test('FILE_DELETE is high risk, not critical: it is not in the keyword table and declares no kinds', () => {
  // Donor fact, pinned: `FILE_DELETE` appears in HIGH_RISK_ACTIONS, but a bare
  // FILE_DELETE action carries no declared kind and its description ("FILE_DELETE
  // path=\"a.txt\"") never names a destructive word, so `classifyRisk` returns
  // `high` — the critical "must declare an effect" rule never fires for it.
  assert.deepEqual(classifyRisk({ type: 'FILE_DELETE', params: { path: 'a.txt' } }), {
    risk: 'high',
    reasons: ['FILE_DELETE has a side effect that must not be assumed'],
  });
  assert.equal(classifyRisk({ type: 'FILE_DELETE', params: { path: 'a.txt' }, destructive: true }).risk, 'critical');
  const withTarget = classifyRisk({ type: 'FILE_DELETE', params: { path: 'a.txt' }, target: { path: 'delete-me.txt' } });
  assert.equal(withTarget.risk, 'critical');
  assert.equal(withTarget.reasons.length, 1);
  assert.match(withTarget.reasons[0], /^the action text names a destructive or public effect/);

  const withoutEffect = assess({ action: { type: 'FILE_DELETE', params: { path: 'a.txt' } }, verification: success('file') });
  assert.equal(withoutEffect.risk, 'high');
  assert.equal(withoutEffect.ok, true);
  assert.equal(withoutEffect.reason, 'strong evidence clears the strong bar for a high-risk action');
});

test('a modal dismissal is the one critical-risk exemption from declaring an effect', () => {
  const action = { type: 'CLICK', capability: 'desktop', params: { __modalDismiss: true }, description: 'Cancel on "Delete this file?"' };
  const result = assess({ action, verification: success('file') });
  assert.equal(result.risk, 'low');
  assert.equal(result.ok, true);
  assert.equal(result.required, 'weak');
});

test('an explicit declaredEffect argument satisfies the critical declaration requirement', () => {
  const action = { type: 'FILE_WRITE', params: { path: 'a.txt' }, destructive: ['DELETE'] };
  assert.equal(assess({ action, verification: success('file'), declaredEffect: true }).ok, true);
  assert.equal(
    assess({ action, verification: success('file'), declaredEffect: false }).reason,
    'a destructive or publishing action must declare its expected effect before it can be accepted',
  );
  // the action's own expectedEffect is the default when the argument is absent
  assert.equal(assess({ action: { ...action, expectedEffect: { file_modified: 'a.txt' } }, verification: success('file') }).ok, true);
});

test('assess concatenates the grade reasons before the risk reasons', () => {
  const result = assess({
    action: { type: 'FILE_WRITE', params: { path: 'a.txt' }, destructive: ['DELETE'], expectedEffect: { file_modified: 'a.txt' } },
    verification: success('file'),
  });
  assert.deepEqual(result.reasons, [
    'file verification observed the effect itself (a file, a process exit, a navigation)',
    'declared destructive kind(s): DELETE',
  ]);
});

test('a critical-risk action is only reached through a declared kind, a true flag or a keyword', () => {
  assert.equal(assess({ action: { type: 'MOVE', params: {}, destructive: true }, verification: success('direct') }).risk, 'critical');
  assert.equal(assess({ action: { type: 'CLICK', params: {}, target: { selector: '#publish' } }, verification: success('state') }).risk, 'critical');
  assert.equal(assess({ action: { type: 'CLICK', capability: 'desktop', params: {} }, verification: success('state') }).risk, 'standard');
});
