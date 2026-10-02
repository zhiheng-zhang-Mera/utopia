// UXI-390 REQUIRED REPAIRS C-1 and C-2 (Mech's review verdict): the same semantics must render IN THE SAME
// WORDS on the Web surface and the Android surface.
//
// Why a guard is the repair's other half: the Web side reads its words from its language pack, while the
// Android side uses hardcoded Kotlin literals - Mech measured that apps/android has NO strings.xml and no
// getString(R.string...), so nothing in the build stops the two surfaces drifting apart. That is precisely how
// C-1 existed ("Technical detail" on Web, "Scheduling detail" on Android) and how C-2 existed (the Web action
// note carries its reason, the Android one did not). A one-off edit fixes today's text; this guard is what
// keeps the next edit on either side from recreating the divergence.
//
// It compares the two sides rather than restating either one: every expected string is READ OUT OF the Web
// language pack, so a change to the Web wording without the Android wording FAILS here. Every extraction
// asserts it found something, because an empty parse that passes is the failure mode this programme keeps
// catching.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const DIR = new URL('../apps/android/app/src/main/java/city/utopia/control/', import.meta.url);
const panel = readFileSync(new URL('SchedulerPanel.kt', DIR), 'utf8');
const en = readFileSync(new URL('../apps/web/i18n/en.js', import.meta.url), 'utf8');

/** Read a key's value out of the Web English pack, failing loudly when the key is absent. */
function webWord(key) {
  const found = en.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  assert.ok(found, `apps/web/i18n/en.js must define ${key}; an empty parse cannot pass`);
  assert.ok(found[1].trim().length > 0, `${key} must not be empty`);
  return found[1];
}

test('UXI-390 C-1: the Advanced disclosure is named with the Web pack\'s own words on Android', () => {
  const summary = webWord('scheduler.advanced.summary');
  assert.equal(summary, 'Technical detail', 'the Web pack is the source of truth for this wording');
  assert.ok(
    panel.includes(`title = "${summary}"`),
    `SchedulerPanel must name the disclosure "${summary}" - the words the Web surface renders`,
  );
  // The negative control is deliberately PRECISE rather than a blanket substring ban. The file is allowed to
  // document the old wording in a comment - this programme's records are what make a repair legible, and the
  // first version of this guard failed on exactly that, flagging the comment that explains the repair. What
  // must not happen is that the divergent words are RENDERED, so the check is that the phrase is not passed as
  // a literal to anything that shows it.
  const rendered = panel.match(/(?:title\s*=\s*|Text\(\s*)"Scheduling detail"/g) ?? [];
  assert.equal(rendered.length, 0, `"Scheduling detail" must not be rendered anywhere; found ${rendered.length} use(s)`);
});

test('UXI-390 C-2: a disabled control states its reason in the Web pack\'s own words', () => {
  const notWired = webWord('scheduler.action.notWired');
  const nothingToSwitchTo = webWord('scheduler.action.nothingToSwitchTo');
  const chooseFromList = webWord('scheduler.action.chooseFromList');

  // All three are distinct, so a copy-paste of one over another cannot pass this test.
  assert.equal(new Set([notWired, nothingToSwitchTo, chooseFromList]).size, 3, 'the three reasons must differ');

  for (const word of [notWired, nothingToSwitchTo, chooseFromList]) {
    assert.ok(
      panel.includes(`"${word}"`),
      `SchedulerPanel must carry the reason "${word}" as the Web surface renders it`,
    );
  }

  // The reasons must be composed onto the label the same way the Web composes them, `label · reason`, rather
  // than rendered as a separate element a user could read as unrelated to the control.
  assert.match(
    panel,
    /"\$\{action\.label\} · \$note"/,
    'the action label must be composed as `label · reason`, matching apps/web/scheduler.js',
  );
  // And the choice of reason must be the same test the Web uses, not a new rule invented on this side.
  assert.match(
    panel,
    /view\.providers\.any \{ it\.selectable \}/,
    'the CHOOSE_PROVIDER reason must be chosen by the same anySelectable test the Web surface uses',
  );
  assert.match(
    panel,
    /in SchedulerPresentation\.UNWIRED_ACTIONS -> "not yet available"/,
    'an unrouted action must be labelled with the reason, not left as a bare greyed label',
  );
});
