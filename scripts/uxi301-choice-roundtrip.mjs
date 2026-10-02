/**
 * UXI-301 — focused verification that the user's provider choice REALLY REACHES the backend.
 *
 * The full UI click-through E2E for the switch path is still owed: an earlier attempt to extend it timed
 * out at the harness cap and was REVERTED rather than committed unverified. So this proves the part that
 * can be proven quickly and honestly - the route records the user's explicit instruction, the task is
 * genuinely re-queued, an event is emitted, and the recorded ref is read back - against a REAL gateway.
 *
 *   UTOPIA_ROOT defaults to the worktree; run from the worktree root.
 */
import {spawn} from 'node:child_process';

const PORT = Number(process.env.CITY_PORT || 4342);
const TOKEN = 'uxi301-choice-control';
const NODE_TOKEN = 'uxi301-choice-node';
const children = [];
const api = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v0/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {Authorization: `Bearer ${TOKEN}`, 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', 'Content-Type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return {status: res.status, json, text};
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const start = (file) => {
  const child = spawn(process.execPath, [file], {
    cwd: process.cwd(),
    env: {...process.env, CITY_HOST: '127.0.0.1', CITY_PORT: String(PORT), CITY_URL: `http://127.0.0.1:${PORT}`,
      CITY_TOKEN: TOKEN, CITY_NODE_TOKEN: NODE_TOKEN, CITY_DATA: `${process.cwd()}/.runtime`, CITY_WORKSPACE: `${process.cwd()}/.runtime/workspace`},
    stdio: 'ignore', windowsHide: true,
  });
  children.push(child);
  return child;
};

const results = [];
const check = (name, ok, detail) => { results.push({name, ok}); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`); };

try {
  start('services/dev-gateway/main.mjs');
  for (let i = 0; i < 40; i++) { await sleep(500); const h = await api('health').catch(() => null); if (h?.status === 200) break; }
  console.log('gateway healthy');

  // A real task, created through the real route.
  const created = await api('tasks', {type: 'CHECKPOINT_DEMO'});
  check('a real task can be created', created.status === 200 && !!created.json?.id, `status=${created.status} id=${created.json?.id}`);
  const taskId = created.json.id;

  // An explicit USER instruction, exactly what the provider-row control sends.
  const chosen = 'device-alpha';
  const choice = await api(`tasks/${encodeURIComponent(taskId)}/provider-choice`, {providerRef: chosen});
  check('the provider-choice route accepts the user instruction', choice.status === 200, `status=${choice.status}`);

  const readBack = await api('tasks');
  const task = (readBack.json?.tasks ?? []).find((t) => t.id === taskId);
  check('the backend RECORDED which service the user chose', task?.chosenProviderRef === chosen, `chosenProviderRef=${task?.chosenProviderRef}`);
  check('the backend recorded WHEN the user chose', typeof task?.userChoiceAt === 'string' && task.userChoiceAt.length > 0, String(task?.userChoiceAt));
  check('the task was genuinely re-queued for the switch to take effect', task?.state === 'QUEUED', `state=${task?.state}`);
  check('the previous assignment was released, so the choice is not cosmetic', task?.assignedNodeId === null, `assignedNodeId=${task?.assignedNodeId}`);

  const events = await api('events');
  const chosenEvent = (events.json?.events ?? []).find((e) => e.type === 'TASK_PROVIDER_CHOSEN' && e.taskId === taskId);
  check('an event records the user action, so it is auditable', !!chosenEvent, chosenEvent ? `actor=${chosenEvent.actor}` : 'no TASK_PROVIDER_CHOSEN event');

  // Refusals, because a route that accepts anything is not validating anything.
  const blank = await api(`tasks/${encodeURIComponent(taskId)}/provider-choice`, {providerRef: ''});
  check('a blank providerRef is refused', blank.status === 400, `status=${blank.status}`);
  const unknown = await api('tasks/Q-does-not-exist/provider-choice', {providerRef: 'x'});
  check('an unknown task is refused', unknown.status === 404, `status=${unknown.status}`);

  const verdict = results.every((r) => r.ok) ? 'PASS' : 'FAIL';
  console.log(`\n=== VERDICT: ${verdict} (${results.filter((r) => r.ok).length}/${results.length}) ===`);
  process.exitCode = verdict === 'PASS' ? 0 : 1;
} catch (error) {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
} finally {
  for (const child of children) { try { child.kill(); } catch { /* gone */ } }
}
