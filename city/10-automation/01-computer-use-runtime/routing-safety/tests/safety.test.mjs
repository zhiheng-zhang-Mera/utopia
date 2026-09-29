/**
 * UTOPIA · Automation — safety gate parity suite.
 *
 * Every decision shape, code, reason string and precedence below restates the
 * DS-Hns donor `app/computer-use/safety.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b. The clock is injected (`now`) so the
 * recorded audit trail is deterministic.
 *
 * The donor defects are pinned on purpose and are NOT repaired here:
 *   - `checkWindow` reads the foreground toggle from the guard's own
 *     `options.contract`, so a per-call `context.contract` cannot disable it;
 *   - `record()` stamps only the copy kept in `decisions()`: the decision it
 *     returns carries no `at` field;
 *   - the `destructive-confirmation` record is spread away by the destructive
 *     decision, so a confirmed action is still recorded as `kind: 'destructive'`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSafetyGuard, matchesWindow, POINTING_ACTIONS, TYPING_ACTIONS } from '../safety.mjs';

const AT = '2026-09-29T12:00:00.000Z';

function guard(options = {}) {
  return createSafetyGuard({ now: () => AT, ...options });
}

const CLICK_WINDOW = { handle: '17', processId: 4242, title: 'Editor' };

function clickAction(overrides = {}) {
  return { type: 'CLICK', target: { selector: '#save' }, params: {}, ...overrides };
}

const FORBIDDEN_CONTRACT = { safety: { destructiveActions: 'forbidden' } };
const CONFIRM_CONTRACT = { safety: { destructiveActions: 'confirm' } };
const ALLOWED_CONTRACT = { safety: { destructiveActions: 'allowed' } };

test('TYPING_ACTIONS and POINTING_ACTIONS are the donor sets', () => {
  assert.deepEqual([...TYPING_ACTIONS], ['TYPE', 'KEY_PRESS', 'HOTKEY', 'DOM_TYPE', 'ACCESSIBILITY_SET_VALUE']);
  assert.deepEqual([...POINTING_ACTIONS], ['MOVE', 'CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'DRAG', 'SCROLL']);
});

test('the destructive gate classifies a harmless action as allowed', () => {
  const safety = guard();
  const decision = safety.evaluateDestructive({ type: 'FILE_READ', target: { selector: '#file' }, params: { path: 'a.txt' } });
  // The donor stamps only the recorded copy: the returned decision carries no `at`.
  assert.deepEqual(decision, {
    kind: 'destructive',
    allowed: true,
    mode: 'allowed',
    actionType: 'FILE_READ',
    kinds: [],
    target: 'selector:#file',
    description: 'FILE_READ selector:#file path="a.txt"',
  });
  assert.deepEqual(safety.decisions(), [{
    at: AT,
    kind: 'destructive',
    allowed: true,
    mode: 'allowed',
    actionType: 'FILE_READ',
    kinds: [],
    target: 'selector:#file',
    description: 'FILE_READ selector:#file path="a.txt"',
  }]);
});

test('a destructive action with no contract falls back to confirm and records the exact reason', () => {
  const safety = guard();
  const decision = safety.evaluateDestructive({ type: 'FILE_DELETE', params: { path: 'a.txt' } });
  assert.deepEqual(decision, {
    kind: 'destructive',
    allowed: true,
    requiresConfirmation: true,
    mode: 'confirm',
    reason: 'destructive action(s) DELETE require confirmation',
    actionType: 'FILE_DELETE',
    kinds: ['DELETE'],
    target: null,
    description: 'FILE_DELETE path="a.txt"',
  });
  assert.equal(decision.reason.length, 49);
});

test('a forbidden contract refuses with DESTRUCTIVE_FORBIDDEN and the exact reason', () => {
  const safety = guard();
  const decision = safety.evaluateDestructive({ type: 'FILE_DELETE', params: { path: 'a.txt' } }, { contract: FORBIDDEN_CONTRACT });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'DESTRUCTIVE_FORBIDDEN');
  assert.equal(decision.mode, 'forbidden');
  assert.equal(decision.reason, 'destructive action(s) DELETE are forbidden by this contract');
  assert.equal(decision.reason.length, 59);
});

test('an allowed contract lets a destructive action through with no confirmation flag', () => {
  const safety = guard();
  const decision = safety.evaluateDestructive({ type: 'FILE_DELETE', params: { path: 'a.txt' } }, { contract: ALLOWED_CONTRACT });
  assert.equal(decision.allowed, true);
  assert.equal(decision.mode, 'allowed');
  assert.equal(decision.requiresConfirmation, undefined);
  assert.equal(decision.reason, undefined);
});

test('a shell command is classified by the donor patterns', () => {
  const safety = guard();
  const kinds = (command, contract) => safety.evaluateDestructive({ type: 'SHELL_EXEC', params: { command } }, contract ? { contract } : {}).kinds;
  assert.deepEqual(kinds('rm -rf build'), ['DELETE']);
  assert.deepEqual(kinds('Remove-Item -Recurse'), ['DELETE']);
  assert.deepEqual(kinds('format C:'), ['FORMAT']);
  assert.deepEqual(kinds('npm install left-pad'), ['INSTALL']);
  assert.deepEqual(kinds('git push origin main'), ['PUBLISH']);
  // "rmdir" also matches the INSTALL pattern's `Install-` only when spelled that way
  assert.deepEqual(kinds('echo hello'), []);
});

test('an action that declares its own destructive kinds keeps them verbatim', () => {
  const safety = guard();
  const decision = safety.evaluateDestructive({ type: 'CLICK', params: {}, destructive: { kinds: ['PUBLISH', 'SEND'] } });
  assert.deepEqual(decision.kinds, ['PUBLISH', 'SEND']);
  assert.equal(decision.reason, 'destructive action(s) PUBLISH, SEND require confirmation');
});

test('the options contract is the fallback when the call carries no contract', () => {
  const safety = guard({ contract: FORBIDDEN_CONTRACT });
  const decision = safety.evaluateDestructive({ type: 'FILE_DELETE', params: { path: 'a.txt' } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'DESTRUCTIVE_FORBIDDEN');
});

test('assertActionAllowed throws DESTRUCTIVE_NEEDS_CONFIRMATION when the host supplies no confirm callback', async () => {
  const safety = guard();
  await assert.rejects(
    () => safety.assertActionAllowed({ type: 'FILE_DELETE', params: { path: 'a.txt' } }),
    (error) => {
      assert.equal(error.name, 'ComputerUseError');
      assert.equal(error.code, 'DESTRUCTIVE_NEEDS_CONFIRMATION');
      assert.equal(error.message, 'destructive action(s) DELETE require confirmation');
      assert.deepEqual(error.details, {
        action: 'FILE_DELETE',
        kinds: ['DELETE'],
        hint: 'no confirmation callback was supplied by the host',
      });
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('assertActionAllowed throws DESTRUCTIVE_FORBIDDEN before it ever asks for confirmation', async () => {
  const safety = guard();
  await assert.rejects(
    () => safety.assertActionAllowed({ type: 'FILE_DELETE', params: { path: 'a.txt' } }, { contract: FORBIDDEN_CONTRACT }),
    (error) => {
      assert.equal(error.code, 'DESTRUCTIVE_FORBIDDEN');
      assert.deepEqual(error.details, { action: 'FILE_DELETE', kinds: ['DELETE'], mode: 'forbidden' });
      return true;
    },
  );
});

test('assertActionAllowed returns the decision for a harmless action and for an already-confirmed one', async () => {
  const safety = guard();
  const harmless = await safety.assertActionAllowed({ type: 'MOVE', params: {} });
  assert.equal(harmless.allowed, true);
  assert.equal(harmless.mode, 'allowed');

  const confirmed = await safety.assertActionAllowed({ type: 'FILE_DELETE', params: { path: 'a.txt' } }, { confirmed: true });
  assert.equal(confirmed.allowed, true);
  assert.equal(confirmed.requiresConfirmation, true);
});

test('the confirmation callback path is ported but no host supplies one (unreachable by construction)', async () => {
  const asked = [];
  const safety = guard({
    confirm: async (request) => {
      asked.push(request);
      return true;
    },
  });
  const decision = await safety.assertActionAllowed({ type: 'FILE_DELETE', params: { path: 'a.txt' } });
  assert.equal(decision.allowed, true);
  assert.deepEqual(asked, [{
    action: 'FILE_DELETE',
    kinds: ['DELETE'],
    target: null,
    description: 'FILE_DELETE path="a.txt"',
    goal: null,
  }]);
  // The donor spreads the destructive decision last, so the confirmation record
  // is reported as another `destructive` decision, not as `destructive-confirmation`.
  const recorded = safety.decisions().at(-1);
  assert.equal(recorded.kind, 'destructive');
  assert.equal(recorded.allowed, true);
  assert.equal(recorded.requiresConfirmation, true);
});

test('a refused confirmation throws SAFETY_REFUSED with the donor message', async () => {
  const safety = guard({ confirm: async () => false });
  await assert.rejects(
    () => safety.assertActionAllowed({ type: 'FILE_DELETE', params: { path: 'a.txt' } }),
    (error) => {
      assert.equal(error.code, 'SAFETY_REFUSED');
      assert.equal(error.message, 'destructive action was not confirmed: DELETE');
      assert.deepEqual(error.details, { action: 'FILE_DELETE', kinds: ['DELETE'] });
      return true;
    },
  );
});

test('decisions() is an audit trail of every decision, with the injected clock', async () => {
  const safety = guard();
  safety.evaluateDestructive({ type: 'FILE_READ', params: {} });
  safety.checkWindow(clickAction(), null);
  await safety.assertActionAllowed({ type: 'MOVE', params: {} });
  const trail = safety.decisions();
  assert.equal(trail.length, 3);
  assert.deepEqual(trail.map((entry) => entry.at), [AT, AT, AT]);
  assert.deepEqual(trail.map((entry) => entry.kind), ['destructive', 'window', 'destructive']);
  trail.push({ bogus: true });
  assert.equal(safety.decisions().length, 3);
});

test('checkWindow skips every non-pointing action', () => {
  const safety = guard();
  for (const type of ['TYPE', 'KEY_PRESS', 'HOTKEY', 'DOM_TYPE', 'ACCESSIBILITY_SET_VALUE', 'OPEN_APP']) {
    assert.deepEqual(safety.checkWindow({ type, params: {} }, { foreground: null }), { kind: 'window', allowed: true, checked: false }, type);
  }
});

test('checkWindow checks ACCESSIBILITY_INVOKE too even though it is not a pointing action', () => {
  const safety = guard();
  const decision = safety.checkWindow(
    { type: 'ACCESSIBILITY_INVOKE', target: { accessibility: { role: 'button', name: 'Save' } } },
    { foreground: { handle: '17', processId: 4242, title: 'Editor - draft.txt' } },
    CLICK_WINDOW,
  );
  assert.equal(decision.checked, true);
  // the expected title is a substring of the observed one, which is the donor's
  // only honest comparison for a title that often carries a document name
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.foreground, { title: 'Editor - draft.txt', handle: '17' });

  // without an expected window the action has no window expectation to check
  const skipped = safety.checkWindow(
    { type: 'ACCESSIBILITY_INVOKE', target: { accessibility: { role: 'button', name: 'Save' } } },
    { foreground: { handle: '0x11', processId: 4242, title: 'Editor' } },
  );
  assert.deepEqual(skipped, { kind: 'window', allowed: true, checked: false, reason: 'no window expectation for this action' });
});

test('checkWindow allows the expected foreground window and records its handle as a string', () => {
  const safety = guard();
  const decision = safety.checkWindow(clickAction({ target: { selector: '#save', window: CLICK_WINDOW } }), {
    foreground: { handle: 17, processId: 4242, title: 'Editor - draft.txt' },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.checked, true);
  assert.deepEqual(decision.foreground, { title: 'Editor - draft.txt', handle: '17' });
  assert.equal(decision.code, undefined);
});

test('an unobservable foreground refuses a coordinate click with WINDOW_MISMATCH and the donor reason', () => {
  const safety = guard();
  const decision = safety.checkWindow(clickAction({ target: { selector: '#save', window: CLICK_WINDOW } }), null);
  assert.equal(decision.allowed, false);
  assert.equal(decision.checked, true);
  assert.equal(decision.code, 'WINDOW_MISMATCH');
  assert.equal(decision.reason, 'no foreground window could be observed - refusing to click blind');
  assert.equal(decision.reason.length, 64);
});

test('an unobservable world refuses with the same code and reason', () => {
  const safety = guard();
  const undefinedWorld = safety.checkWindow(clickAction({ target: { point: { x: 1, y: 2 }, window: CLICK_WINDOW } }), undefined);
  const emptyWorld = safety.checkWindow(clickAction({ target: { point: { x: 1, y: 2 }, window: CLICK_WINDOW } }), {});
  assert.equal(undefinedWorld.code, 'WINDOW_MISMATCH');
  assert.equal(undefinedWorld.reason, 'no foreground window could be observed - refusing to click blind');
  assert.equal(emptyWorld.code, 'WINDOW_MISMATCH');
  assert.equal(emptyWorld.reason, 'no foreground window could be observed - refusing to click blind');
});

test('a different foreground window is refused, naming the observed title and pid', () => {
  const safety = guard();
  const decision = safety.checkWindow(clickAction({ target: { selector: '#save', window: CLICK_WINDOW } }), {
    foreground: { handle: '0x99', processId: 777, title: 'Password Manager' },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'WINDOW_MISMATCH');
  assert.equal(decision.reason, 'foreground window "Password Manager" (pid 777) is not the expected window');
  assert.deepEqual(decision.foreground, { title: 'Password Manager', handle: '0x99', processId: 777 });
});

test('an action with no window expectation skips the foreground check', () => {
  const safety = guard();
  const decision = safety.checkWindow(clickAction({ target: { point: { x: 1, y: 2 } } }), { foreground: null });
  assert.deepEqual(decision, { kind: 'window', allowed: true, checked: false, reason: 'no window expectation for this action' });
});

test('the foreground toggle is read from the guard options, never from the call context', () => {
  const permissive = guard({ contract: { safety: { requireForegroundWindow: false } } });
  assert.deepEqual(permissive.checkWindow(clickAction({ target: { point: { x: 1, y: 2 }, window: CLICK_WINDOW } }), { foreground: null }), {
    kind: 'window',
    allowed: true,
    checked: false,
    reason: 'contract disables the foreground check',
  });

  // Donor defect, pinned: a toggle on the guard's own contract cannot be carried
  // into the check from the call, because `checkWindow` reads `options.contract`.
  const strict = guard({ contract: { safety: { requireForegroundWindow: true } } });
  const decision = strict.checkWindow(clickAction({ target: { point: { x: 1, y: 2 }, window: CLICK_WINDOW } }), { foreground: null }, null);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'WINDOW_MISMATCH');
  assert.equal(decision.reason, 'no foreground window could be observed - refusing to click blind');
});

test('assertWindowAllowed throws the window decision code and details', () => {
  const safety = guard();
  assert.throws(
    () => safety.assertWindowAllowed(clickAction({ target: { point: { x: 1, y: 2 }, window: CLICK_WINDOW } }), { foreground: null }),
    (error) => {
      assert.equal(error.code, 'WINDOW_MISMATCH');
      assert.equal(error.message, 'no foreground window could be observed - refusing to click blind');
      assert.deepEqual(error.details, { action: 'CLICK', expected: CLICK_WINDOW, foreground: null });
      return true;
    },
  );
  const allowed = safety.assertWindowAllowed(clickAction(), { foreground: null });
  assert.equal(allowed.checked, false);
});

test('checkFocus skips every non-typing action', () => {
  const safety = guard();
  for (const type of ['CLICK', 'MOVE', 'DRAG', 'SCROLL', 'DOM_CLICK', 'SHELL_EXEC']) {
    assert.deepEqual(safety.checkFocus({ type, params: {} }, { focusedRef: null }), { kind: 'focus', allowed: true, checked: false }, type);
  }
});

test('a verified focus receipt is trusted without consulting the world', () => {
  const safety = guard();
  const decision = safety.checkFocus({ type: 'TYPE', params: { text: 'hi' } }, null, { verifiedFocusRef: 'ax-3' });
  assert.deepEqual(decision, { kind: 'focus', allowed: true, checked: true, focusRef: 'ax-3', source: 'verified-receipt' });
  assert.deepEqual(safety.decisions(), [{ at: AT, kind: 'focus', allowed: true, checked: true, focusRef: 'ax-3', source: 'verified-receipt' }]);
});

test('typing with no target and no focus is refused with FOCUS_MISMATCH', () => {
  const safety = guard();
  const noWorld = safety.checkFocus({ type: 'TYPE', params: { text: 'hi' } }, null);
  assert.equal(noWorld.allowed, false);
  assert.equal(noWorld.code, 'FOCUS_MISMATCH');
  assert.equal(noWorld.reason, 'no element has focus - typing would go to an unknown target');
  assert.equal(noWorld.reason.length, 59);

  const emptyWorld = safety.checkFocus({ type: 'TYPE', params: { text: 'hi' } }, {});
  assert.equal(emptyWorld.code, 'FOCUS_MISMATCH');
  assert.equal(emptyWorld.reason, 'no element has focus - typing would go to an unknown target');
});

test('typing with no target but a focused element is allowed from the world', () => {
  const safety = guard();
  const decision = safety.checkFocus({ type: 'TYPE', params: { text: 'hi' } }, { focusedRef: 'ax-7' });
  assert.deepEqual(decision, { kind: 'focus', allowed: true, checked: true, focusRef: 'ax-7', source: 'world' });
});

test('a targeted type with no focus is refused, naming the target', () => {
  const safety = guard();
  const decision = safety.checkFocus({ type: 'TYPE', target: { selector: '#password' }, params: { text: 'secret' } }, null);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'FOCUS_MISMATCH');
  assert.equal(decision.reason, 'target selector:#password is not focused - focus must be established and verified before typing');
  assert.equal(decision.reason.length, 95);
});

test('focus on the wrong element is refused with the donor detail fields', () => {
  const safety = guard();
  const action = { type: 'DOM_TYPE', target: { selector: '#user' }, params: { text: 'alice' } };
  const decision = safety.checkFocus(action, {
    focusedRef: 'ax-other',
    controls: [{ ref: 'ax-user', selector: '#user' }],
    ax: [{ ref: 'ax-user2', selector: '#user' }],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'FOCUS_MISMATCH');
  assert.equal(decision.reason, 'focus is on ax-other, not on selector:#user');
  assert.equal(decision.focusedRef, 'ax-other');
  assert.deepEqual(decision.expected, ['ax-user', 'ax-user2']);
});

test('focus on any reference the target resolves to is accepted', () => {
  const safety = guard();
  const action = { type: 'TYPE', target: { accessibility: { role: 'textbox', name: 'User' } }, params: { text: 'alice' } };
  const decision = safety.checkFocus(action, {
    focusedRef: 'ax-2',
    ax: [{ ref: 'ax-1', role: 'textbox', name: 'Username' }, { ref: 'ax-2', role: 'textbox', name: 'User' }],
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.focusRef, 'ax-2');
  assert.equal(decision.source, 'world');
});

test('a semantic target resolves refs by name containment, and an unrelated pool cannot prove focus', () => {
  const safety = guard();
  const action = { type: 'TYPE', target: { semantic: { text: 'Save' } }, params: { text: 'x' } };
  const withRefs = safety.checkFocus(action, { focusedRef: 'n-2', controls: [{ ref: 'n-2', name: 'Save changes' }] });
  assert.equal(withRefs.allowed, true);
  assert.equal(withRefs.focusRef, 'n-2');
  assert.equal(withRefs.source, 'world');

  // the pool holds no control whose name contains "Save", so the target resolves
  // to no refs at all: the donor's containment check is skipped (it only runs
  // when `expectedRefs` is non-empty) and the observed focus is accepted.
  const withoutRefs = safety.checkFocus(action, { focusedRef: 'n-9', controls: [{ ref: 'n-1', name: 'Cancel' }] });
  assert.equal(withoutRefs.allowed, true);
  assert.equal(withoutRefs.focusRef, 'n-9');
  assert.deepEqual(withoutRefs.expected, undefined);

  const noPool = safety.checkFocus(action, { focusedRef: 'n-9' });
  assert.equal(noPool.allowed, true);
  assert.equal(noPool.source, 'world');

  // and with no observed focus at all the targeted action is still refused
  assert.equal(safety.checkFocus(action, null).code, 'FOCUS_MISMATCH');
});

test('the focus toggle is honoured from the guard options, unlike the window toggle', () => {
  // `checkFocus` reads `options.contract` from `createSafetyGuard`'s closure
  // (its own third parameter is named `options_`), so an options-level contract
  // DOES switch the focus check off.
  const safety = guard({ contract: { safety: { requireFocusForTyping: false } } });
  const decision = safety.checkFocus({ type: 'TYPE', params: { text: 'hi' } }, null, {});
  assert.deepEqual(decision, { kind: 'focus', allowed: true, checked: false, reason: 'contract disables the focus check' });
  assert.equal(decision.code, undefined);

  // and the per-call options object is not a contract: it only carries the receipt
  const plain = guard();
  assert.equal(plain.checkFocus({ type: 'TYPE', params: { text: 'hi' } }, null, {}).allowed, false);
});

test('assertFocusAllowed throws FOCUS_MISMATCH with the focused ref in the details', () => {
  const safety = guard();
  assert.throws(
    () => safety.assertFocusAllowed(
      { type: 'TYPE', target: { selector: '#x' }, params: {} },
      { focusedRef: 'ax-other', controls: [{ ref: 'ax-x', selector: '#x' }] },
    ),
    (error) => {
      assert.equal(error.code, 'FOCUS_MISMATCH');
      assert.equal(error.message, 'focus is on ax-other, not on selector:#x');
      assert.deepEqual(error.details, { action: 'TYPE', focusedRef: 'ax-other' });
      return true;
    },
  );
  assert.throws(
    () => safety.assertFocusAllowed({ type: 'TYPE', target: { selector: '#x' }, params: {} }, null),
    (error) => {
      assert.equal(error.code, 'FOCUS_MISMATCH');
      assert.equal(error.message, 'target selector:#x is not focused - focus must be established and verified before typing');
      assert.deepEqual(error.details, { action: 'TYPE', focusedRef: null });
      return true;
    },
  );
});

test('inspectModals reports every open blocking dialog with the donor defaults', () => {
  const safety = guard();
  const decision = safety.inspectModals({
    dialogs: [{ type: 'alert', message: 'Delete this file?', ref: 'dlg-1', source: 'page', dismissible: false }],
  });
  assert.deepEqual(decision, {
    kind: 'modal',
    blocking: true,
    modals: [{
      type: 'alert',
      message: 'Delete this file?',
      ref: 'dlg-1',
      source: 'page',
      bounds: null,
      windowHandle: null,
      dismissible: false,
      unexpected: true,
    }],
  });
  // only the recorded copy is timestamped, and the return value has no `at`
  assert.deepEqual(safety.decisions(), [{ at: AT, ...decision }]);
});

test('a dialog is blocking unless it is explicitly blocking:false or open:false', () => {
  const safety = guard();
  assert.deepEqual(safety.inspectModals({ dialogs: [{ blocking: false, message: 'x' }] }).modals, []);
  assert.deepEqual(safety.inspectModals({ dialogs: [{ open: false, message: 'x' }] }).modals, []);
  assert.equal(safety.inspectModals({ dialogs: [{ blocking: true, open: true, message: 'x' }] }).blocking, true);
  assert.deepEqual(safety.inspectModals({ dialogs: [{ blocking: false, message: 'x' }] }).blocking, false);
});

test('inspectModals with no dialogs, no world and a non-list dialogs field never blocks', () => {
  const safety = guard();
  assert.deepEqual(safety.inspectModals(null), { kind: 'modal', blocking: false, modals: [] });
  assert.deepEqual(safety.inspectModals({}), { kind: 'modal', blocking: false, modals: [] });
  assert.deepEqual(safety.inspectModals({ dialogs: [] }), { kind: 'modal', blocking: false, modals: [] });
});

test('assertNoBlockingModal throws MODAL_BLOCKING and joins the dialog texts', () => {
  const safety = guard();
  assert.throws(
    () => safety.assertNoBlockingModal({ dialogs: [{ message: 'Delete this file?' }, {}, { type: 'permission' }] }),
    (error) => {
      assert.equal(error.code, 'MODAL_BLOCKING');
      // the donor falls back to the dialog type when it carries no message
      assert.equal(error.message, 'a blocking dialog is open: Delete this file?; dialog; permission');
      assert.equal(error.message.length, 64);
      assert.equal(error.details.modals.length, 3);
      return true;
    },
  );
  assert.equal(safety.assertNoBlockingModal({ dialogs: [] }).blocking, false);
});

test('redactAction redacts typed text, values, keys, stdin and env keys', () => {
  const safety = guard();
  const safe = safety.redactAction({
    type: 'TYPE',
    target: { selector: '#password' },
    params: { text: 'hunter2', keys: ['h', 'Shift'], stdin: 'echo', env: { SECRET_TOKEN: 'abc', PATH: '/bin' }, value: 'v' },
    destructive: { kinds: ['SEND'] },
    sensitive: false,
  });
  assert.deepEqual(safe, {
    type: 'TYPE',
    target: 'selector:#password',
    params: { text: '[redacted]', keys: ['h', 'Shift'], stdin: '[redacted]', env: ['SECRET_TOKEN', 'PATH'], value: '[redacted]' },
    destructive: { kinds: ['SEND'] },
    sensitive: false,
  });
});

test('redactAction masks single-character keys only for a sensitive action', () => {
  const safety = guard();
  const sensitive = safety.redactAction({ type: 'KEY_PRESS', params: { keys: ['a', 'Enter'] }, sensitive: true });
  assert.deepEqual(sensitive.params.keys, ['*', 'Enter']);
  const plain = safety.redactAction({ type: 'KEY_PRESS', params: { keys: ['a', 'Enter'] }, sensitive: false });
  assert.deepEqual(plain.params.keys, ['a', 'Enter']);
});

test('redactAction redacts secret-looking parameter keys through redactDetails', () => {
  const safety = guard();
  const safe = safety.redactAction({ type: 'SHELL_EXEC', params: { command: 'deploy', env: { API_KEY: 'x' }, token: 'abc' }, sensitive: false });
  assert.deepEqual(safe.params, { command: 'deploy', env: ['API_KEY'], token: '[redacted]' });
});

test('redactAction keeps a harmless action readable and leaves the input untouched', () => {
  const safety = guard();
  const action = { type: 'CLICK', target: { selector: '#save' }, params: { clickCount: 1 }, sensitive: false };
  const safe = safety.redactAction(action);
  assert.deepEqual(safe, { type: 'CLICK', target: 'selector:#save', params: { clickCount: 1 }, destructive: undefined, sensitive: false });
  assert.deepEqual(action, { type: 'CLICK', target: { selector: '#save' }, params: { clickCount: 1 }, sensitive: false });
});

test('redactText removes inline secrets and bearer tokens', () => {
  const safety = guard();
  const line = 'login failed password=hunter2 token: abc123 api_key=xyz';
  const redacted = safety.redactText(line);
  assert.equal(redacted, 'login failed password=[redacted] token=[redacted] api_key=[redacted]');
  assert.equal(safety.redactText('Authorization: Bearer eyJhbGciOi.abc-123_x'), 'Authorization: Bearer [redacted]');
  assert.equal(safety.redactText(undefined), 'undefined');
});

test('matchesWindow is the donor field-by-field comparison', () => {
  const window = { handle: 17, processId: 4242, className: 'Notepad', processName: 'notepad.exe', title: 'untitled - Notepad' };
  assert.equal(matchesWindow(window, { handle: '17' }), true);
  assert.equal(matchesWindow(window, { handle: '18' }), false);
  assert.equal(matchesWindow(window, { processId: '4242' }), true);
  assert.equal(matchesWindow(window, { processId: 4243 }), false);
  assert.equal(matchesWindow(window, { className: 'notepad' }), true);
  assert.equal(matchesWindow(window, { className: 'wordpad' }), false);
  assert.equal(matchesWindow(window, { process: 'NOTEPAD' }), true);
  assert.equal(matchesWindow(window, { process: 'wordpad' }), false);
  assert.equal(matchesWindow(window, { title: 'Notepad' }), true);
  assert.equal(matchesWindow(window, { title: 'Wordpad' }), false);
  assert.equal(matchesWindow(window, {}), true);
  assert.equal(matchesWindow(null, { title: 'x' }), false);
  assert.equal(matchesWindow(window, null), false);
  assert.equal(matchesWindow(window, undefined), false);
});

test('matchesWindow compares class names case-insensitively but handles exactly', () => {
  const window = { handle: '0xAB', className: 'Chrome_WidgetWin_1' };
  assert.equal(matchesWindow(window, { handle: '0xab' }), false);
  assert.equal(matchesWindow(window, { className: 'chrome_widgetwin_1' }), true);
});
