/**
 * UTOPIA · Automation — channel routing parity suite.
 *
 * Every plan, ordering, reason string and fallback list below restates the
 * DS-Hns donor `app/computer-use/routing.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b. The router is a pure function of the
 * action plus what the host currently offers, so the suite needs no controller,
 * no world state and no clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_CAPABILITY,
  CHANNEL_CONTROLLER,
  CHANNEL_PLANS,
  fallbackChannels,
  channelRank,
  isBrowserAction,
  routeAction,
} from '../routing.mjs';
import { ACTION_TYPES } from '../contracts.mjs';

const ROUTING_REASON = Object.freeze({
  api_navigation: 'browser API is the cheapest channel for a navigation action',
  api_host: 'WAIT_EVENT is carried by a host API',
  shell: 'the shell is cheaper and more reliable than driving a GUI for this task',
  file: 'the filesystem API answers the question directly - no GUI, no shell parsing',
  dom: 'the target resolved to a structured DOM element - no coordinates needed',
  accessibility: 'the target resolved to an accessibility node with the required pattern',
  gui: 'no structured channel applies - using verified coordinates with window and focus safety',
  vision: 'vision is required because structured state cannot address this target',
});

/** No plan name may be added or dropped: the table is the donor's, action by action. */
test('CHANNEL_PLANS is the donor plan table, action type by action type', () => {
  assert.deepEqual(Object.keys(CHANNEL_PLANS), [
    'MOVE', 'CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'TYPE', 'KEY_PRESS', 'HOTKEY', 'SCROLL', 'DRAG', 'FOCUS', 'SELECT',
    'OPEN_APP', 'CLOSE_WINDOW', 'SWITCH_WINDOW', 'BROWSER_NAVIGATE', 'BROWSER_BACK', 'BROWSER_FORWARD', 'BROWSER_REFRESH',
    'DOM_CLICK', 'DOM_TYPE', 'DOM_SELECT', 'ACCESSIBILITY_INVOKE', 'ACCESSIBILITY_SET_VALUE', 'SHELL_EXEC', 'FILE_READ',
    'FILE_WRITE', 'FILE_COPY', 'FILE_MOVE', 'FILE_DELETE', 'FILE_MKDIR', 'FILE_EXISTS', 'WAIT_EVENT', 'WAIT_STATE',
    'SCREENSHOT_REGION', 'SCREENSHOT_WINDOW', 'SCREENSHOT_FULL',
  ]);
  assert.equal(Object.keys(CHANNEL_PLANS).length, 36);
  assert.equal(Object.keys(ACTION_TYPES).length, 36);

  const donorPlans = {
    MOVE: ['gui'],
    CLICK: ['dom', 'accessibility', 'gui', 'vision'],
    DOUBLE_CLICK: ['dom', 'accessibility', 'gui'],
    RIGHT_CLICK: ['dom', 'accessibility', 'gui'],
    TYPE: ['dom', 'accessibility', 'gui'],
    KEY_PRESS: ['gui'],
    HOTKEY: ['gui'],
    SCROLL: ['dom', 'gui'],
    DRAG: ['gui'],
    FOCUS: ['accessibility', 'dom', 'gui'],
    SELECT: ['dom', 'accessibility', 'gui'],
    OPEN_APP: ['shell', 'gui'],
    CLOSE_WINDOW: ['api', 'gui'],
    SWITCH_WINDOW: ['api', 'gui'],
    BROWSER_NAVIGATE: ['api'],
    BROWSER_BACK: ['api'],
    BROWSER_FORWARD: ['api'],
    BROWSER_REFRESH: ['api'],
    DOM_CLICK: ['dom', 'accessibility'],
    DOM_TYPE: ['dom', 'accessibility'],
    DOM_SELECT: ['dom', 'accessibility'],
    ACCESSIBILITY_INVOKE: ['accessibility', 'gui'],
    ACCESSIBILITY_SET_VALUE: ['accessibility', 'gui'],
    SHELL_EXEC: ['shell'],
    FILE_READ: ['file'],
    FILE_WRITE: ['file'],
    FILE_COPY: ['file'],
    FILE_MOVE: ['file'],
    FILE_DELETE: ['file'],
    FILE_MKDIR: ['file'],
    FILE_EXISTS: ['file'],
    WAIT_EVENT: ['api'],
    WAIT_STATE: ['api'],
    SCREENSHOT_REGION: ['vision'],
    SCREENSHOT_WINDOW: ['vision'],
    SCREENSHOT_FULL: ['vision'],
  };
  for (const [type, plan] of Object.entries(donorPlans)) {
    assert.deepEqual(CHANNEL_PLANS[type], plan, `${type} plan`);
    assert.deepEqual(fallbackChannels({ type }), plan, `${type} ordered fallbacks`);
  }
});

test('every plan channel has a capability and a controller, exactly as declared', () => {
  assert.deepEqual(CHANNEL_CAPABILITY, {
    api: 'browser', file: 'filesystem', shell: 'shell', dom: 'browser', accessibility: 'desktop', gui: 'desktop', vision: 'vision',
  });
  assert.deepEqual(CHANNEL_CONTROLLER, {
    api: 'browser', file: 'file', shell: 'shell', dom: 'browser', accessibility: 'desktop', gui: 'desktop', vision: 'vision',
  });
  for (const plan of Object.values(CHANNEL_PLANS)) {
    for (const channel of plan) {
      assert.ok(CHANNEL_CAPABILITY[channel], `${channel} has a capability`);
      assert.ok(CHANNEL_CONTROLLER[channel], `${channel} has a controller`);
    }
  }
});

test('fallbackChannels returns a copy, never the frozen plan itself', () => {
  const once = fallbackChannels({ type: 'CLICK' });
  once.push('bogus');
  assert.deepEqual(CHANNEL_PLANS.CLICK, ['dom', 'accessibility', 'gui', 'vision']);
  assert.deepEqual(fallbackChannels({ type: 'CLICK' }), ['dom', 'accessibility', 'gui', 'vision']);
  assert.deepEqual(fallbackChannels({ type: 'NOT_A_TYPE' }), []);
});

test('channelRank is the index in the donor cost ladder, and the ladder length when unknown', () => {
  assert.deepEqual(
    ['api', 'file', 'shell', 'dom', 'accessibility', 'gui', 'vision'].map((channel) => channelRank(channel)),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.equal(channelRank('nope'), 7);
  assert.equal(channelRank(undefined), 7);
});

test('isBrowserAction matches only BROWSER_ and DOM_ prefixes', () => {
  assert.equal(isBrowserAction({ type: 'BROWSER_NAVIGATE' }), true);
  assert.equal(isBrowserAction({ type: 'DOM_CLICK' }), true);
  assert.equal(isBrowserAction({ type: 'ACCESSIBILITY_INVOKE' }), false);
  assert.equal(isBrowserAction({ type: 'FILE_READ' }), false);
  // the donor's prefix test is case sensitive
  assert.equal(isBrowserAction({ type: 'browser_navigate' }), false);
});

test('an unknown action type is refused with the donor reason and code', () => {
  const result = routeAction({ type: 'TELEPORT' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no routing plan for TELEPORT');
  assert.deepEqual(result.alternatives, []);
  assert.equal(result.error.code, 'ACTION_UNSUPPORTED');
  assert.equal(result.error.message, 'no routing plan for action type TELEPORT');
  assert.deepEqual(result.error.details, { action: 'TELEPORT' });
});

test('CLICK resolves to the DOM with the donor reason and an ordered alternative list', () => {
  const result = routeAction(
    { type: 'CLICK', target: { selector: '#save' } },
    { availability: { browser: { available: true } }, pageReady: true, resolved: { ref: 'node-1', source: 'page', kind: 'selector' } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.channel, 'dom');
  assert.equal(result.controller, 'browser');
  assert.equal(result.capability, 'browser');
  assert.equal(result.reason, ROUTING_REASON.dom);
  assert.equal(result.reason.length, 71);
  // alternatives = the failures recorded before the hit, then the untouched tail
  assert.deepEqual(result.alternatives, ['accessibility', 'gui', 'vision']);
  assert.deepEqual(result.attempts, [{ channel: 'dom', capability: 'browser', controller: 'browser', ok: true, reason: ROUTING_REASON.dom }]);
});

test('a contract that withholds the winning capability records the refusal and moves on', () => {
  const result = routeAction(
    { type: 'CLICK' },
    {
      contract: { allowedCapabilities: ['desktop'] },
      availability: { browser: { available: true }, desktop: { available: true } },
      resolved: { ref: 'node-1', point: { x: 4, y: 5 } },
    },
  );
  assert.equal(result.ok, true);
  // accessibility needs a `ref` for the ax source, so a point-only resolution
  // falls through to the gui channel
  assert.equal(result.channel, 'gui');
  assert.equal(result.reason, ROUTING_REASON.gui);
  assert.deepEqual(result.alternatives, ['dom', 'accessibility', 'vision']);
  assert.deepEqual(result.attempts[0], {
    channel: 'dom',
    capability: 'browser',
    controller: 'browser',
    ok: false,
    reason: 'capability "browser" is not allowed by the contract',
  });
  assert.deepEqual(result.attempts.slice(1), [
    {
      channel: 'accessibility',
      capability: 'desktop',
      controller: 'desktop',
      ok: false,
      reason: 'channel accessibility cannot carry CLICK here',
    },
    {
      channel: 'gui',
      capability: 'desktop',
      controller: 'desktop',
      ok: true,
      reason: ROUTING_REASON.gui,
    },
  ]);
});

test('an unavailable controller is described with the donor label and host reason', () => {
  const result = routeAction(
    { type: 'CLICK' },
    {
      availability: { browser: { available: false, reason: 'cdp detached' }, desktop: { available: false } },
      resolved: { ref: 'node-1', source: 'page', kind: 'selector' },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no available channel for CLICK');
  assert.deepEqual(result.alternatives, []);
  assert.equal(result.error.code, 'CONTROLLER_UNAVAILABLE');
  assert.deepEqual(result.attempts.map((attempt) => attempt.reason), [
    'browser controller unavailable: cdp detached',
    'accessibility controller was not provided by the host',
    'desktop controller unavailable',
    'desktop controller unavailable',
  ]);
  // the vision channel reports the desktop capability first when the desktop is
  // itself unavailable, so its own missing controller is never named
  assert.equal(result.attempts[3].channel, 'vision');
});

test('pageReady is not consulted on the api channel: a navigation still routes to the api', () => {
  // Donor fact, pinned: only the `dom` channel tests `pageReady`. `api` is
  // available as soon as the browser capability is, so a navigation still routes
  // even when no page is attached; the page reason only appears in
  // `describeUnavailable`, which is reached for `dom`.
  const navigate = routeAction({ type: 'BROWSER_NAVIGATE' }, { availability: { browser: { available: true } }, pageReady: false });
  assert.equal(navigate.ok, true);
  assert.equal(navigate.channel, 'api');
  assert.equal(navigate.reason, ROUTING_REASON.api_navigation);

  const domBlocked = routeAction(
    { type: 'DOM_CLICK', target: { selector: '#save' } },
    { availability: { browser: { available: true } }, pageReady: false },
  );
  assert.equal(domBlocked.ok, false);
  assert.equal(domBlocked.attempts[0].reason, 'no browser page is attached to the runtime');
});

test('a channel that is available but unsuited reports the unsuitability reason', () => {
  // DOM_CLICK's plan is only ['dom', 'accessibility']: with an unresolved target
  // and no desktop capability, neither can carry it and no gui fallback exists.
  const domBlocked = routeAction(
    { type: 'DOM_CLICK', target: { selector: '#save' } },
    { availability: { browser: { available: true }, desktop: { available: true } }, pageReady: true },
  );
  assert.equal(domBlocked.ok, false);
  assert.deepEqual(domBlocked.alternatives, []);
  assert.deepEqual(domBlocked.attempts.map((attempt) => attempt.channel), ['dom', 'accessibility']);
  assert.equal(domBlocked.attempts[0].reason, 'the target has not been resolved into a structured element yet');
  assert.equal(domBlocked.attempts[1].reason, 'the target has not been resolved into a structured element yet');
  assert.equal(domBlocked.reason, 'no available channel for DOM_CLICK');
  assert.equal(domBlocked.error.code, 'CONTROLLER_UNAVAILABLE');

  // CLICK does have gui and vision fallbacks. The desktop capability makes the
  // accessibility rung AVAILABLE (it consumes the desktop capability) but still
  // unsuited for an unresolved target, and the gui rung has no coordinate.
  const guiBlocked = routeAction({ type: 'CLICK' }, { availability: { desktop: { available: true } } });
  assert.equal(guiBlocked.ok, false);
  assert.deepEqual(guiBlocked.attempts.map((attempt) => [attempt.channel, attempt.reason]), [
    ['dom', 'browser controller was not provided by the host'],
    ['accessibility', 'the target has not been resolved into a structured element yet'],
    ['gui', 'no coordinate is known for this action'],
    ['vision', 'vision controller was not provided by the host'],
  ]);

  // a pointing action that does carry a point is suitable on gui
  const guiReady = routeAction(
    { type: 'CLICK', target: { point: { x: 5, y: 6 } } },
    { availability: { desktop: { available: true } } },
  );
  assert.equal(guiReady.ok, true);
  assert.equal(guiReady.channel, 'gui');
});

test('an unavailable channel is reported before an unsuited one on the same action', () => {
  // dom is unavailable (no page attached) while accessibility is available but
  // unsuited, so the two rungs carry different reasons in plan order.
  const result = routeAction(
    { type: 'DOM_CLICK', target: { selector: '#save' } },
    { availability: { browser: { available: true }, desktop: { available: true } }, pageReady: false },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.attempts.map((attempt) => attempt.reason), [
    'no browser page is attached to the runtime',
    'the target has not been resolved into a structured element yet',
  ]);
});

test('the accessibility channel accepts FOCUS without a resolved point, and CLICK is not in its plan list', () => {
  const focus = routeAction(
    { type: 'FOCUS', target: { window: { title: 'Editor' } } },
    { availability: { desktop: { available: true } }, resolved: { ref: 'wnd-1', source: 'ax' } },
  );
  assert.equal(focus.ok, true);
  assert.equal(focus.channel, 'accessibility');
  assert.equal(focus.reason, ROUTING_REASON.accessibility);

  // SWITCH_WINDOW's plan is ['api', 'gui']: the accessibility channel is never
  // considered for it, and gui needs a coordinate, so the window is unreachable.
  const switchWindow = routeAction(
    { type: 'SWITCH_WINDOW', target: { window: { title: 'Editor' } } },
    { availability: { desktop: { available: true } }, resolved: { ref: 'wnd-1', source: 'ax' } },
  );
  assert.equal(switchWindow.ok, false);
  assert.deepEqual(switchWindow.attempts.map((attempt) => attempt.channel), ['api', 'gui']);
});

test('an accessibility node resolves through the ax source', () => {
  const result = routeAction(
    { type: 'ACCESSIBILITY_INVOKE', target: { accessibility: { role: 'button', name: 'Save' } } },
    { availability: { accessibility: { available: true } }, resolved: { ref: 'ax-9', source: 'ax' } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.channel, 'accessibility');
  assert.equal(result.reason, ROUTING_REASON.accessibility);
});

test('TYPE prefers the DOM, then accessibility, then coordinates', () => {
  const ctx = (extra) => ({
    availability: { browser: { available: true }, accessibility: { available: true }, desktop: { available: true } },
    pageReady: true,
    ...extra,
  });
  assert.equal(routeAction({ type: 'TYPE' }, ctx({ resolved: { ref: 'n1', source: 'page', kind: 'selector' } })).channel, 'dom');
  assert.equal(routeAction({ type: 'TYPE' }, ctx({ resolved: { ref: 'n1', source: 'ax' } })).channel, 'accessibility');
  const gui = routeAction({ type: 'TYPE', target: { point: { x: 1, y: 2 } } }, ctx({}));
  assert.equal(gui.channel, 'gui');
  assert.equal(gui.reason, ROUTING_REASON.gui);
});

test('point and vision channels carry the donor reasons', () => {
  assert.equal(
    routeAction({ type: 'CLICK', target: { point: { x: 10, y: 20 } } }, { availability: { desktop: { available: true } } }).reason,
    ROUTING_REASON.gui,
  );
  assert.equal(
    routeAction({ type: 'SCREENSHOT_FULL' }, { availability: { vision: { available: true }, desktop: { available: true } } }).reason,
    ROUTING_REASON.vision,
  );
  assert.equal(
    routeAction({ type: 'SHELL_EXEC', params: { command: 'echo hi' } }, { availability: { shell: { available: true } } }).reason,
    ROUTING_REASON.shell,
  );
  assert.equal(
    routeAction({ type: 'FILE_READ', params: { path: 'a.txt' } }, { availability: { file: { available: true } } }).reason,
    ROUTING_REASON.file,
  );
  assert.equal(
    routeAction({ type: 'BROWSER_REFRESH' }, { availability: { browser: { available: true } } }).reason,
    ROUTING_REASON.api_navigation,
  );
  assert.equal(
    routeAction({ type: 'WAIT_EVENT' }, { availability: { browser: { available: true } } }).reason,
    ROUTING_REASON.api_host,
  );
});

test('OPEN_APP reaches the shell channel and the api channel is measured against browser availability', () => {
  const shell = routeAction({ type: 'OPEN_APP', params: { application: 'notepad' } }, { availability: { shell: { available: true } } });
  assert.equal(shell.channel, 'shell');
  assert.equal(shell.reason, ROUTING_REASON.shell);

  // WAIT_EVENT's api channel is available whenever the browser capability is;
  // its reason names the action rather than a navigation.
  const api = routeAction({ type: 'WAIT_STATE' }, { availability: { browser: { available: true } } });
  assert.equal(api.channel, 'api');
  assert.equal(api.reason, 'WAIT_STATE is carried by a host API');
});

test('availability entries are available unless explicitly set to false', () => {
  const present = routeAction({ type: 'FILE_EXISTS', params: { path: 'a' } }, { availability: { file: {} } });
  assert.equal(present.ok, true);
  assert.equal(present.channel, 'file');
  const absent = routeAction({ type: 'FILE_EXISTS', params: { path: 'a' } }, {});
  assert.equal(absent.ok, false);
  assert.equal(absent.attempts[0].reason, 'file controller was not provided by the host');
});

test('every routing reason is the donor string, reached through its own channel', () => {
  const reasons = {
    dom: routeAction(
      { type: 'DOM_CLICK', target: { selector: '#x' } },
      { availability: { browser: {} }, pageReady: true, resolved: { ref: 'r1', source: 'page', kind: 'selector' } },
    ),
    accessibility: routeAction(
      { type: 'ACCESSIBILITY_INVOKE', target: { accessibility: { role: 'button' } } },
      { availability: { desktop: {} }, resolved: { ref: 'a1', source: 'ax' } },
    ),
    gui: routeAction({ type: 'DRAG', target: { point: { x: 1, y: 1 } } }, { availability: { desktop: {} } }),
    vision: routeAction({ type: 'SCREENSHOT_FULL' }, { availability: { vision: {}, desktop: {} } }),
    shell: routeAction({ type: 'SHELL_EXEC', params: { command: 'echo' } }, { availability: { shell: {} } }),
    file: routeAction({ type: 'FILE_READ', params: { path: 'a' } }, { availability: { file: {} } }),
    apiBrowser: routeAction({ type: 'BROWSER_BACK' }, { availability: { browser: {} } }),
    apiHost: routeAction({ type: 'WAIT_EVENT' }, { availability: { browser: {} } }),
  };
  assert.equal(reasons.dom.channel, 'dom');
  assert.equal(reasons.dom.reason, ROUTING_REASON.dom);
  assert.equal(reasons.accessibility.channel, 'accessibility');
  assert.equal(reasons.accessibility.reason, ROUTING_REASON.accessibility);
  assert.equal(reasons.gui.channel, 'gui');
  assert.equal(reasons.gui.reason, ROUTING_REASON.gui);
  assert.equal(reasons.vision.channel, 'vision');
  assert.equal(reasons.vision.reason, ROUTING_REASON.vision);
  assert.equal(reasons.shell.channel, 'shell');
  assert.equal(reasons.shell.reason, ROUTING_REASON.shell);
  assert.equal(reasons.file.channel, 'file');
  assert.equal(reasons.file.reason, ROUTING_REASON.file);
  assert.equal(reasons.apiBrowser.channel, 'api');
  assert.equal(reasons.apiBrowser.reason, ROUTING_REASON.api_navigation);
  assert.equal(reasons.apiHost.channel, 'api');
  assert.equal(reasons.apiHost.reason, 'WAIT_EVENT is carried by a host API');

  // every plan entry of every action type maps to a known capability/controller
  for (const [type, plan] of Object.entries(CHANNEL_PLANS)) {
    const action = { type, params: {} };
    for (const channel of plan) {
      assert.equal(typeof CHANNEL_CAPABILITY[channel], 'string', `${type}/${channel} capability`);
      assert.equal(typeof CHANNEL_CONTROLLER[channel], 'string', `${type}/${channel} controller`);
    }
    assert.ok(Array.isArray(fallbackChannels(action)), `${type} fallbacks`);
  }
});
