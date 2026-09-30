/**
 * UTOPIA · Automation — fail-safe modal handling parity suite.
 *
 * Every label table, precedence order, decision shape and reason string below
 * restates the DS-Hns donor `app/computer-use/modal.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 *
 * The donor defects are pinned on purpose and are NOT repaired here:
 *   - the destructive table is consulted first, so "Send later" is a SEND while
 *     "Later" is a dismissal, "Reset" (not just "Delete") is a DELETE, and
 *     "上传" resolves to PUBLISH rather than SEND;
 *   - `POSITIVE_LABELS` matches a bare "Yes", so the "bare yes/no pair" fallback
 *     below it is only reachable for a label that table misses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESTRUCTIVE_LABELS,
  MODAL_ACTION,
  MODAL_KINDS,
  NEUTRAL_LABELS,
  POSITIVE_LABELS,
  SAFE_DISMISS_LABELS,
  chooseControl,
  classifyControl,
  classifyModal,
  destructiveAllowed,
  isDestructiveKind,
  planModal,
} from '../modal.mjs';

/** [label, expected kind, expected destructiveKind] — one donor branch each. */
const CONTROL_VECTORS = [
  ['Delete', 'destructive', 'DELETE'],
  ['Delete and close', 'destructive', 'DELETE'],
  ['删除并关闭', 'destructive', 'DELETE'],
  ['Send later', 'destructive', 'SEND'],
  ['Submit', 'destructive', 'SEND'],
  ['Publish', 'destructive', 'PUBLISH'],
  // "上传" is also named by the PUBLISH table, which is scanned first
  ['上传', 'destructive', 'PUBLISH'],
  ['Uninstall', 'destructive', 'UNINSTALL'],
  ['Upgrade', 'destructive', 'INSTALL'],
  ['Buy now', 'destructive', 'PURCHASE'],
  ['Format disk', 'destructive', 'FORMAT'],
  ['Sign out', 'destructive', 'ACCOUNT_CHANGE'],
  ['Grant access', 'destructive', 'ACCOUNT_CHANGE'],
  ['Reset', 'destructive', 'DELETE'],
  ['Overwrite', 'destructive', 'DELETE'],
  ['Cancel', 'safe_dismiss', null],
  ['Close', 'safe_dismiss', null],
  ['Not now', 'safe_dismiss', null],
  ["Don't save", 'safe_dismiss', null],
  ['Skip', 'safe_dismiss', null],
  ['取消', 'safe_dismiss', null],
  // the English word "ignore" is not in the donor table: only 忽略 is
  ['Ignore', 'unknown', null],
  ['OK', 'neutral_acknowledge', null],
  ['Got it', 'neutral_acknowledge', null],
  ['Acknowledge', 'neutral_acknowledge', null],
  ['知道了', 'neutral_acknowledge', null],
  ['Confirm', 'positive_confirm', null],
  ['Save', 'positive_confirm', null],
  ['Try again', 'positive_confirm', null],
  ['确定', 'positive_confirm', null],
  // "Yes" is caught by POSITIVE_LABELS before the bare-yes fallback is reached
  ['Yes', 'positive_confirm', null],
  // the bare-yes fallback is only reachable for a label POSITIVE_LABELS misses
  ['是', 'unknown', null],
  ['好的', 'unknown', null],
  ['Frobnicate', 'unknown', null],
  ['', 'unknown', null],
];

test('classifyControl follows the donor table order for every label branch', () => {
  for (const [label, kind, destructiveKind] of CONTROL_VECTORS) {
    const result = classifyControl(label);
    assert.equal(result.kind, kind, `kind of ${JSON.stringify(label)}`);
    assert.equal(result.destructiveKind, destructiveKind, `destructiveKind of ${JSON.stringify(label)}`);
  }
});

test('classifyControl trims its input, and non-string labels are stringified', () => {
  assert.deepEqual(classifyControl('  Cancel  '), { kind: 'safe_dismiss', destructiveKind: null, reason: '"Cancel" only closes the dialog' });
  assert.deepEqual(classifyControl(undefined), { kind: 'unknown', destructiveKind: null, reason: 'the control has no label' });
  assert.equal(classifyControl(null).reason, 'the control has no label');
  assert.equal(classifyControl('   ').reason, 'the control has no label');
  assert.equal(classifyControl(0).reason, '"0" could not be classified');
});

test('the destructive table wins over every later table for the same label', () => {
  // "close" would be a safe dismissal, but "Delete and close" is destructive
  assert.equal(classifyControl('Delete and close').kind, 'destructive');
  // "later" would be a safe dismissal, but "Send later" is a SEND
  assert.equal(classifyControl('Send later').kind, 'destructive');
  // "确定" would be positive, but "确认删除" names DELETE
  assert.equal(classifyControl('确认删除').destructiveKind, 'DELETE');
  // "关闭" would be a dismissal, but "覆盖并关闭" names DELETE first
  assert.equal(classifyControl('覆盖并关闭').destructiveKind, 'DELETE');
});

test('the donor reasons for one label of each class are exact', () => {
  assert.deepEqual(classifyControl('Delete'), {
    kind: 'destructive',
    destructiveKind: 'DELETE',
    reason: '"Delete" names the DELETE effect',
  });
  assert.deepEqual(classifyControl('Submit'), {
    kind: 'destructive',
    destructiveKind: 'SEND',
    reason: '"Submit" names the SEND effect',
  });
  assert.deepEqual(classifyControl('Cancel'), {
    kind: 'safe_dismiss',
    destructiveKind: null,
    reason: '"Cancel" only closes the dialog',
  });
  assert.deepEqual(classifyControl('OK'), {
    kind: 'neutral_acknowledge',
    destructiveKind: null,
    reason: '"OK" acknowledges the message',
  });
  assert.deepEqual(classifyControl('Save'), {
    kind: 'positive_confirm',
    destructiveKind: null,
    reason: '"Save" proceeds with the flow',
  });
  assert.deepEqual(classifyControl('Yes'), {
    kind: 'positive_confirm',
    destructiveKind: null,
    reason: '"Yes" proceeds with the flow',
  });
  assert.deepEqual(classifyControl('是'), {
    kind: 'unknown',
    destructiveKind: null,
    reason: '"是" carries no effect information',
  });
  assert.deepEqual(classifyControl('Frobnicate'), {
    kind: 'unknown',
    destructiveKind: null,
    reason: '"Frobnicate" could not be classified',
  });
});

test('the label tables are the donor tables, entry by entry', () => {
  assert.deepEqual(DESTRUCTIVE_LABELS.map((entry) => entry.kind), [
    'DELETE', 'DELETE', 'SEND', 'PUBLISH', 'UNINSTALL', 'INSTALL', 'PURCHASE', 'FORMAT', 'ACCOUNT_CHANGE', 'ACCOUNT_CHANGE',
  ]);
  assert.equal(DESTRUCTIVE_LABELS.length, 10);
  assert.deepEqual(SAFE_DISMISS_LABELS.length, 2);
  assert.deepEqual(NEUTRAL_LABELS.length, 2);
  assert.deepEqual(POSITIVE_LABELS.length, 2);

  assert.equal(
    DESTRUCTIVE_LABELS[0].pattern.source,
    String(/删除|删除并|\bdelete\b|\berase\b|\bremove\b|\bunlink\b|\brmdir\b|\bpurge\b/i.source),
  );
  assert.equal(DESTRUCTIVE_LABELS[0].pattern.source, '删除|删除并|\\bdelete\\b|\\berase\\b|\\bremove\\b|\\bunlink\\b|\\brmdir\\b|\\bpurge\\b');
  assert.equal(DESTRUCTIVE_LABELS[0].pattern.source.length, 69);
  assert.equal(DESTRUCTIVE_LABELS[9].pattern.source, String(/授权|允许|\ballow\b|\bgrant\b|\bpermit\b/i.source));

  // The dismissal, neutral and positive tables hold bare RegExp values (only the
  // destructive table carries a kind), so their pattern is the entry itself.
  assert.equal(SAFE_DISMISS_LABELS[0].source, String(/\b(cancel|close|dismiss|no|not\s+now|later|never\s*mind|don'?t\s+save|keep|skip|back)\b/i.source));
  assert.equal(SAFE_DISMISS_LABELS[0].source, '\\b(cancel|close|dismiss|no|not\\s+now|later|never\\s*mind|don\'?t\\s+save|keep|skip|back)\\b');
  assert.equal(SAFE_DISMISS_LABELS[0].source.length, 87);
  assert.equal(NEUTRAL_LABELS[0].source, String(/\b(ok|okay|got\s+it|i\s+see|acknowledge|understood|noted)\b/i.source));
  assert.equal(NEUTRAL_LABELS[0].source, '\\b(ok|okay|got\\s+it|i\\s+see|acknowledge|understood|noted)\\b');
  assert.equal(NEUTRAL_LABELS[0].source.length, 59);
  assert.equal(POSITIVE_LABELS[0].source, String(/\b(yes|confirm|proceed|continue|save|apply|retry|try\s+again|accept)\b/i.source));
  assert.equal(POSITIVE_LABELS[0].source, '\\b(yes|confirm|proceed|continue|save|apply|retry|try\\s+again|accept)\\b');
  assert.equal(POSITIVE_LABELS[0].source.length, 70);
  for (const pattern of [...SAFE_DISMISS_LABELS, ...NEUTRAL_LABELS, ...POSITIVE_LABELS]) {
    assert.ok(pattern instanceof RegExp);
  }
});

test('classifyModal classifies every control and counts the classes', () => {
  const classification = classifyModal({
    type: 'confirm',
    message: 'Save your changes?',
    source: 'page',
    ref: 'dlg-1',
    windowHandle: '0x22',
    controls: [
      { ref: 'c1', label: 'Save', role: 'button', bbox: { x: 1, y: 2, width: 3, height: 4 }, source: 'page' },
      { ref: 'c2', label: 'Cancel' },
      { ref: 'c3', label: 'Later' },
      { ref: 'c4', label: 'OK' },
      { ref: 'c5', label: 'Frobnicate' },
      null,
    ],
  });
  assert.equal(classification.type, 'confirm');
  assert.equal(classification.message, 'Save your changes?');
  assert.equal(classification.source, 'page');
  assert.equal(classification.ref, 'dlg-1');
  assert.equal(classification.windowHandle, '0x22');
  assert.equal(classification.messageDestructiveKind, null);
  assert.equal(classification.controls.length, 5);
  assert.deepEqual(classification.counts, { positive_confirm: 1, safe_dismiss: 2, neutral_acknowledge: 1, unknown: 1 });
  assert.deepEqual(classification.controls[0], {
    ref: 'c1',
    label: 'Save',
    source: 'page',
    role: 'button',
    bbox: { x: 1, y: 2, width: 3, height: 4 },
    kind: 'positive_confirm',
    destructiveKind: null,
    reason: '"Save" proceeds with the flow',
  });
});

test('classifyModal falls back to name/text for the label and null for absent fields', () => {
  const classification = classifyModal({ controls: [{ name: 'Cancel' }, { text: '确定' }, {}] });
  assert.deepEqual(classification.controls.map((control) => control.label), ['Cancel', '确定', '']);
  assert.deepEqual(classification.controls.map((control) => control.kind), ['safe_dismiss', 'positive_confirm', 'unknown']);
  assert.deepEqual(classification.controls.map((control) => control.ref), [null, null, null]);
  assert.equal(classification.type, 'dialog');
  assert.equal(classification.message, null);
  assert.equal(classification.source, null);
  assert.equal(classification.ref, null);
  assert.equal(classification.windowHandle, null);
});

test('a destructive message is recognised from message or text, first table entry first', () => {
  assert.equal(classifyModal({ message: 'Delete this file?' }).messageDestructiveKind, 'DELETE');
  assert.equal(classifyModal({ text: 'Publish to production?' }).messageDestructiveKind, 'PUBLISH');
  assert.equal(classifyModal({ message: 'Overwrite the file?' }).messageDestructiveKind, 'DELETE');
  assert.equal(classifyModal({ message: 'Save your changes?' }).messageDestructiveKind, null);
  assert.equal(classifyModal({}).messageDestructiveKind, null);
  assert.equal(classifyModal({ message: 'Delete or publish?' }).messageDestructiveKind, 'DELETE');
});

test('a dialog with no controls asks the user and carries the message kind', () => {
  assert.deepEqual(chooseControl(null), {
    action: MODAL_ACTION.USER_ACTION_REQUIRED,
    control: null,
    kind: MODAL_KINDS.UNKNOWN,
    destructiveKind: null,
    requiresUser: true,
    reason: 'the dialog exposes no control the runtime can classify',
  });
  const withMessageKind = chooseControl(classifyModal({ message: 'Delete this file?' }));
  assert.equal(withMessageKind.destructiveKind, 'DELETE');
  assert.equal(withMessageKind.action, 'USER_ACTION_REQUIRED');
});

test('a safe dismissal is always preferred, even beside a destructive control', () => {
  const decision = chooseControl(classifyModal({
    message: 'Delete this file?',
    controls: [{ ref: 'd', label: 'Delete' }, { ref: 'c', label: 'Cancel' }],
  }));
  assert.deepEqual(decision, {
    action: MODAL_ACTION.PRESS,
    control: classifyModal({ controls: [{ ref: 'c', label: 'Cancel' }] }).controls[0],
    kind: MODAL_KINDS.SAFE_DISMISS,
    destructiveKind: null,
    requiresUser: false,
    reason: '"Cancel" only closes the dialog; dismissing is the only action that cannot change the world',
  });
  assert.equal(decision.reason.length, 91);
});

test('a forbidden contract refuses a destructive confirmation and names the kinds', () => {
  const classification = classifyModal({ message: 'Delete this file?', controls: [{ ref: 'd', label: 'Delete' }] });
  const decision = chooseControl(classification, { destructiveMode: 'forbidden' });
  assert.deepEqual(decision, {
    action: MODAL_ACTION.USER_ACTION_REQUIRED,
    control: null,
    kind: MODAL_KINDS.DESTRUCTIVE,
    destructiveKind: 'DELETE',
    requiresUser: true,
    reason: 'the dialog offers DELETE and this contract forbids those actions',
  });
  assert.equal(decision.reason.length, 64);
});

test('a destructive control without a declared matching effect asks the user', () => {
  const classification = classifyModal({ controls: [{ ref: 'p', label: 'Publish' }] });
  const noEffect = chooseControl(classification, { destructiveMode: 'confirm' });
  assert.equal(noEffect.action, 'USER_ACTION_REQUIRED');
  assert.equal(noEffect.destructiveKind, 'PUBLISH');
  assert.equal(noEffect.reason, 'the dialog asks for PUBLISH which the current action did not declare as its expected effect');
  assert.equal(noEffect.reason.length, 91);

  const wrongEffect = chooseControl(classification, { destructiveMode: 'confirm', expectedEffect: 'DELETE' });
  assert.equal(wrongEffect.requiresUser, true);
  assert.equal(wrongEffect.reason, 'the dialog asks for PUBLISH which the current action did not declare as its expected effect');
});

test('a matched effect but no safety authorization still asks the user', () => {
  const classification = classifyModal({ controls: [{ ref: 'p', label: 'Publish' }] });
  const decision = chooseControl(classification, { destructiveMode: 'confirm', expectedEffect: 'PUBLISH the site' });
  assert.deepEqual(decision, {
    action: MODAL_ACTION.USER_ACTION_REQUIRED,
    control: null,
    kind: MODAL_KINDS.DESTRUCTIVE,
    destructiveKind: 'PUBLISH',
    requiresUser: true,
    reason: 'the safety gate did not authorize a destructive confirmation',
  });
  assert.equal(decision.reason.length, 60);
});

test('all three conditions together authorize pressing the destructive control', () => {
  const classification = classifyModal({ controls: [{ ref: 'p', label: 'Publish' }] });
  const decision = chooseControl(classification, { destructiveMode: 'confirm', expectedEffect: 'PUBLISH', safetyPassed: true });
  assert.equal(decision.action, MODAL_ACTION.PRESS);
  assert.equal(decision.kind, MODAL_KINDS.DESTRUCTIVE);
  assert.equal(decision.destructiveKind, 'PUBLISH');
  assert.equal(decision.requiresUser, false);
  assert.equal(decision.control.ref, 'p');
  assert.equal(decision.reason, '"Publish" names the PUBLISH effect; authorized by the contract, the declared effect and the safety gate');
  assert.equal(decision.reason.length, 103);
});

test('the kind set is the action kinds, then the control kinds, then the message kind, and the reason lists them all', () => {
  const classification = classifyModal({
    message: 'This will overwrite the file',
    controls: [{ ref: 's', label: 'Submit' }, { ref: 'd', label: 'Delete' }],
  });
  const decision = chooseControl(classification, {
    destructiveMode: 'confirm',
    destructiveKinds: ['SEND'],
    expectedEffect: 'DELETE SEND DELETE',
    safetyPassed: true,
  });
  // Set order: declared action kinds, then control order, then the message kind.
  assert.equal(decision.destructiveKind, 'SEND');
  assert.equal(decision.control.ref, 's');
  const forbidden = chooseControl(classification, { destructiveMode: 'forbidden', destructiveKinds: ['SEND'] });
  assert.equal(forbidden.reason, 'the dialog offers SEND, DELETE and this contract forbids those actions');
});

test('a positive confirmation needs a declared effect or a declared destructive kind', () => {
  const classification = classifyModal({ controls: [{ ref: 'p', label: 'Save' }] });
  assert.deepEqual(chooseControl(classification), {
    action: MODAL_ACTION.USER_ACTION_REQUIRED,
    control: null,
    kind: MODAL_KINDS.POSITIVE_CONFIRM,
    destructiveKind: null,
    requiresUser: true,
    reason: '"Save" proceeds with the flow, but the action declares no expected effect to justify it',
  });
  assert.equal(chooseControl(classifyModal({ controls: [{ ref: 'p', label: 'Save' }] })).reason.length, 87);

  const withEffect = chooseControl(classification, { expectedEffect: 'the record is saved' });
  assert.equal(withEffect.action, MODAL_ACTION.PRESS);
  assert.equal(withEffect.reason, '"Save" proceeds with the flow; the action declares the matching effect');

  const withDeclaredKinds = chooseControl(classification, { destructiveKinds: ['DELETE'] });
  assert.equal(withDeclaredKinds.action, MODAL_ACTION.PRESS);
  assert.equal(withDeclaredKinds.kind, MODAL_KINDS.POSITIVE_CONFIRM);
});

test('a positive confirmation is reached only after the destructive and safe tables', () => {
  const classification = classifyModal({ controls: [{ ref: 'c', label: 'Cancel' }, { ref: 's', label: 'Save' }] });
  const decision = chooseControl(classification, { expectedEffect: 'saved' });
  assert.equal(decision.kind, MODAL_KINDS.SAFE_DISMISS);
  assert.equal(decision.control.ref, 'c');
});

test('an acknowledgement is pressed only when the dialog is harmless', () => {
  const harmless = chooseControl(classifyModal({ message: 'Update available', controls: [{ ref: 'o', label: 'OK' }] }));
  assert.deepEqual(harmless, {
    action: MODAL_ACTION.PRESS,
    control: classifyModal({ controls: [{ ref: 'o', label: 'OK' }] }).controls[0],
    kind: MODAL_KINDS.NEUTRAL_ACKNOWLEDGE,
    destructiveKind: null,
    requiresUser: false,
    reason: '"OK" acknowledges the message; acknowledging a harmless message changes nothing',
  });
  assert.equal(harmless.reason.length, 79);

  const destructive = chooseControl(classifyModal({ message: 'Delete this file?', controls: [{ ref: 'o', label: 'OK' }] }));
  assert.deepEqual(destructive, {
    action: MODAL_ACTION.USER_ACTION_REQUIRED,
    control: null,
    kind: MODAL_KINDS.NEUTRAL_ACKNOWLEDGE,
    destructiveKind: 'DELETE',
    requiresUser: true,
    reason: '"OK" would answer a dialog about DELETE, which the action did not declare as its expected effect',
  });
  assert.equal(destructive.reason.length, 96);
});

test('an unclassifiable dialog asks the user and lists the labels it saw', () => {
  const decision = chooseControl(classifyModal({ controls: [{ ref: 'a', label: 'Frobnicate' }, { ref: 'b', label: 'Wibble' }] }));
  assert.deepEqual(decision, {
    action: MODAL_ACTION.USER_ACTION_REQUIRED,
    control: null,
    kind: MODAL_KINDS.UNKNOWN,
    destructiveKind: null,
    requiresUser: true,
    reason: "none of the dialog's 2 control(s) could be classified (Frobnicate, Wibble)",
  });
  assert.equal(decision.reason.length, 74);

  const withPlaceholder = chooseControl(classifyModal({ controls: [{ ref: 'a', label: 'Frobnicate' }, { ref: 'b', label: '' }] }));
  assert.equal(withPlaceholder.reason, "none of the dialog's 2 control(s) could be classified (Frobnicate, ?)");
});

test('destructiveAllowed allows everything except an explicit forbidden mode', () => {
  assert.equal(destructiveAllowed('forbidden'), false);
  assert.equal(destructiveAllowed('FORBIDDEN'), true);
  assert.equal(destructiveAllowed('confirm'), true);
  assert.equal(destructiveAllowed('allowed'), true);
  assert.equal(destructiveAllowed(undefined), true);
  assert.equal(destructiveAllowed(''), true);
  assert.equal(destructiveAllowed(null), true);
});

test('isDestructiveKind is the donor vocabulary check', () => {
  assert.deepEqual(
    ['DELETE', 'PURCHASE', 'SEND', 'PUBLISH', 'INSTALL', 'UNINSTALL', 'FORMAT', 'ACCOUNT_CHANGE'].map((kind) => isDestructiveKind(kind)),
    [true, true, true, true, true, true, true, true],
  );
  assert.equal(isDestructiveKind('delete'), false);
  assert.equal(isDestructiveKind(undefined), false);
  assert.equal(isDestructiveKind(null), false);
  assert.equal(isDestructiveKind('FROBNICATE'), false);
});

test('planModal classifies candidates, drops disabled ones and reports the chosen ref', () => {
  const planned = planModal({
    modal: { message: 'Delete this file?' },
    candidates: [
      { ref: 'd', label: 'Delete' },
      { ref: 'c', label: 'Cancel' },
      { ref: 'o', label: 'OK', disabled: true },
    ],
  });
  assert.equal(planned.action, MODAL_ACTION.PRESS);
  assert.equal(planned.kind, MODAL_KINDS.SAFE_DISMISS);
  assert.equal(planned.ref, 'c');
  assert.equal(planned.classification.controls.length, 2);
  assert.equal(planned.classification.messageDestructiveKind, 'DELETE');
  assert.equal(planned.requiresUser, false);
});

test('planModal on an empty input asks the user with the donor reason', () => {
  const planned = planModal();
  assert.deepEqual(planned, {
    action: MODAL_ACTION.USER_ACTION_REQUIRED,
    control: null,
    kind: MODAL_KINDS.UNKNOWN,
    destructiveKind: null,
    requiresUser: true,
    reason: 'the dialog exposes no control the runtime can classify',
    classification: {
      type: 'dialog',
      message: null,
      source: null,
      ref: null,
      windowHandle: null,
      messageDestructiveKind: null,
      controls: [],
      counts: {},
    },
    ref: null,
    source: null,
  });
});

test('planModal drops every disabled control and reports the surface it chose', () => {
  const planned = planModal({
    modal: {},
    candidates: [{ ref: 'd', label: 'Delete', disabled: true }],
  });
  assert.equal(planned.action, 'USER_ACTION_REQUIRED');
  assert.equal(planned.reason, 'the dialog exposes no control the runtime can classify');

  // The candidate's surface survives classification: `classifyModal` spreads
  // `classifyControl`'s result (ref/label/source/role/bbox) back over itself, and
  // that result carries no `source` key, so the pinned value is the candidate's.
  const withSource = planModal({ modal: {}, candidates: [{ ref: 'x', label: 'Cancel', source: 'page' }] });
  assert.equal(withSource.classification.controls[0].source, 'page');
  assert.equal(withSource.source, 'page');
});

test('planModal forwards its context, so the destructive decision still needs all three conditions', () => {
  const planned = planModal({
    modal: { message: 'Delete this file?' },
    candidates: [{ ref: 'd', label: 'Delete' }],
    context: { destructiveMode: 'confirm', expectedEffect: 'DELETE', safetyPassed: true },
  });
  assert.equal(planned.action, MODAL_ACTION.PRESS);
  assert.equal(planned.kind, MODAL_KINDS.DESTRUCTIVE);
  assert.equal(planned.ref, 'd');
  assert.equal(planned.destructiveKind, 'DELETE');

  const refused = planModal({
    modal: { message: 'Delete this file?' },
    candidates: [{ ref: 'd', label: 'Delete' }],
    context: { destructiveMode: 'confirm', expectedEffect: 'DELETE' },
  });
  assert.equal(refused.action, 'USER_ACTION_REQUIRED');
  assert.equal(refused.reason, 'the safety gate did not authorize a destructive confirmation');
  assert.equal(refused.ref, null);
});
