/**
 * UTOPIA · Rooms · Room 08 — Focus Room (client).
 *
 * The countdown runs in the page; the running session is created on the server so
 * that a reload cannot silently lose it. If the page comes back and the server
 * still reports a running session, the room marks it interrupted and records only
 * the time that actually elapsed.
 */

let kit;
let api;

const state = {
  presets: [5, 15, 25, 50],
  selectedMinutes: 25,
  label: '',
  running: null,
  remainingMs: 0,
  tickHandle: null,
  paused: false,
  sessions: [],
  summary: null,
};

let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const presetRow = kit.el('div', { class: 'row', id: 'fc-presets' });
  const labelInput = kit.el('input', { type: 'text', id: 'fc-label', placeholder: 'What are you focusing on?' });
  const clock = kit.el('p', { class: 'mono', id: 'fc-clock', style: 'font-size:34px;margin:6px 0' , text: '25:00' });
  const phase = kit.el('p', { class: 'muted small', id: 'fc-phase', text: 'idle' });
  const startButton = kit.el('button', { class: 'primary', type: 'button', text: 'Start', id: 'fc-start' });
  const pauseButton = kit.el('button', { type: 'button', text: 'Pause', id: 'fc-pause', disabled: true });
  const resumeButton = kit.el('button', { type: 'button', text: 'Resume', id: 'fc-resume', disabled: true });
  const resetButton = kit.el('button', { type: 'button', text: 'Reset', id: 'fc-reset' });
  const feedback = kit.el('p', { class: 'feedback', id: 'fc-feedback' });

  const stats = kit.el('div', { class: 'stat-grid', id: 'fc-stats' });
  const history = kit.el('ul', { class: 'item-list', id: 'fc-history' });

  const timerPane = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Focus timer' }),
    kit.el('p', { class: 'muted small', text: 'Preset' }),
    presetRow,
    kit.el('label', { for: 'fc-label', text: 'Session label' }),
    labelInput,
    clock,
    phase,
    kit.el('div', { class: 'row' }, [startButton, pauseButton, resumeButton, resetButton]),
    feedback,
    kit.el('p', { class: 'muted small', text: 'This room shows no OS notification and runs no background service: the countdown lives in this page.' }),
  ]);

  const historyPane = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Session history' }),
    stats,
    history,
  ]);

  root.append(kit.el('div', { class: 'room-grid' }, [timerPane, historyPane]));
  dom = { presetRow, labelInput, clock, phase, startButton, pauseButton, resumeButton, resetButton, feedback, stats, history };

  await load();

  startButton.addEventListener('click', startSession);
  pauseButton.addEventListener('click', pauseSession);
  resumeButton.addEventListener('click', resumeSession);
  resetButton.addEventListener('click', resetTimer);

  return () => {
    if (state.tickHandle) clearInterval(state.tickHandle);
  };
}

async function load() {
  try {
    const payload = await api.get('/state');
    state.presets = payload.presets ?? state.presets;
    state.sessions = payload.sessions ?? [];
    state.summary = payload.summary;
    state.running = payload.active ?? null;
    renderPresets();
    renderStats();
    renderHistory();

    if (state.running) {
      const elapsed = Date.now() - Date.parse(state.running.startedAt);
      const planned = state.running.plannedMinutes * 60000;
      if (elapsed >= planned) {
        await completeSession(state.running.plannedMinutes * 60, false);
      } else {
        const elapsedSeconds = Math.max(0, Math.round(elapsed / 1000));
        await fetch(`${api.base}/sessions/abandon`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        state.running = null;
        kit.createFeedback(dom.feedback).set(
          `a previous session was still running when this page loaded; recorded ${Math.round(elapsedSeconds / 60)} min as interrupted`,
          'warn',
        );
        await refreshHistory();
      }
    }
    state.remainingMs = state.selectedMinutes * 60000;
    renderClock();
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

function renderPresets() {
  dom.presetRow.textContent = '';
  for (const minutes of state.presets) {
    dom.presetRow.append(
      kit.el('button', {
        type: 'button',
        class: state.selectedMinutes === minutes ? 'primary' : '',
        id: `fc-preset-${minutes}`,
        text: `${minutes} min`,
        disabled: Boolean(state.running),
        onclick: () => {
          state.selectedMinutes = minutes;
          state.remainingMs = minutes * 60000;
          renderPresets();
          renderClock();
        },
      }),
    );
  }
}

function renderClock() {
  const totalSeconds = Math.max(0, Math.round(state.remainingMs / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  dom.clock.textContent = `${minutes}:${seconds}`;
  dom.phase.textContent = state.running
    ? state.paused
      ? `paused · ${state.running.label ?? 'focus'}`
      : `running · ${state.running.label ?? 'focus'}`
    : 'idle';
  dom.startButton.disabled = Boolean(state.running);
  dom.pauseButton.disabled = !state.running || state.paused;
  dom.resumeButton.disabled = !state.running || !state.paused;
}

function renderStats() {
  dom.stats.textContent = '';
  const summary = state.summary ?? { sessionsToday: 0, minutesToday: 0, sessionsTotal: 0, minutesTotal: 0 };
  const entries = [
    ['Sessions today', summary.sessionsToday],
    ['Minutes today', summary.minutesToday],
    ['Sessions total', summary.sessionsTotal],
    ['Minutes total', summary.minutesTotal],
  ];
  for (const [label, value] of entries) {
    dom.stats.append(kit.el('div', { class: 'stat' }, [kit.el('b', { text: String(value) }), kit.el('span', { text: label })]));
  }
}

function renderHistory() {
  dom.history.textContent = '';
  if (state.sessions.length === 0) {
    dom.history.append(kit.el('li', { class: 'empty', text: 'No completed sessions yet.' }));
    return;
  }
  for (const session of state.sessions) {
    dom.history.append(
      kit.el('li', { class: 'item', id: `fc-session-${session.id}` }, [
        kit.el('div', { class: 'row between' }, [
          kit.el('h3', { text: session.label || 'focus' }),
          kit.el('span', { class: 'muted small', text: `${Math.round(session.elapsedSeconds / 60)} / ${session.plannedMinutes} min` }),
        ]),
        kit.el('p', { class: 'muted small', text: `${kit.formatWhen(session.startedAt)}${session.interrupted ? ' · interrupted' : ' · completed'}` }),
        kit.el('div', { class: 'row', style: 'margin-top:4px' }, [
          kit.el('button', { class: 'tiny danger', type: 'button', text: 'Delete', onclick: () => deleteSession(session.id) }),
        ]),
      ]),
    );
  }
}

async function refreshHistory() {
  const payload = await api.get('/state');
  state.sessions = payload.sessions ?? [];
  state.summary = payload.summary;
  renderStats();
  renderHistory();
}

async function startSession() {
  try {
    const created = await api.post('/sessions/start', {
      label: dom.labelInput.value.trim() || 'focus',
      plannedMinutes: state.selectedMinutes,
      elapsedSeconds: 0,
    });
    state.running = created.active;
    state.paused = false;
    state.remainingMs = state.selectedMinutes * 60000;
    tick();
    state.tickHandle = setInterval(tick, 250);
    renderPresets();
    renderClock();
    kit.createFeedback(dom.feedback).set('session started');
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

function tick() {
  if (!state.running || state.paused) return;
  const elapsed = Date.now() - Date.parse(state.running.startedAt);
  const planned = state.running.plannedMinutes * 60000;
  state.remainingMs = Math.max(0, planned - elapsed);
  renderClock();
  if (state.remainingMs <= 0) finish();
}

function pauseSession() {
  if (!state.running || state.paused) return;
  state.paused = true;
  if (state.tickHandle) clearInterval(state.tickHandle);
  state.tickHandle = null;
  renderClock();
  kit.createFeedback(dom.feedback).set('paused');
}

function resumeSession() {
  if (!state.running || !state.paused) return;
  // shift the start so the paused interval is not counted as focused time
  const alreadyElapsed = state.running.plannedMinutes * 60000 - state.remainingMs;
  state.running = { ...state.running, startedAt: new Date(Date.now() - alreadyElapsed).toISOString() };
  state.paused = false;
  state.tickHandle = setInterval(tick, 250);
  renderClock();
  kit.createFeedback(dom.feedback).set('resumed');
}

async function finish() {
  if (state.tickHandle) clearInterval(state.tickHandle);
  state.tickHandle = null;
  const plannedSeconds = (state.running?.plannedMinutes ?? state.selectedMinutes) * 60;
  await completeSession(plannedSeconds, false);
  kit.createFeedback(dom.feedback).set('session completed');
}

async function completeSession(elapsedSeconds, interrupted) {
  try {
    if (interrupted) {
      await fetch(`${api.base}/sessions/abandon`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } else {
      await api.post('/sessions/complete', { elapsedSeconds });
    }
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
  state.running = null;
  state.paused = false;
  state.remainingMs = state.selectedMinutes * 60000;
  renderPresets();
  renderClock();
  await refreshHistory();
}

async function resetTimer() {
  if (state.tickHandle) clearInterval(state.tickHandle);
  state.tickHandle = null;
  if (state.running) {
    const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(state.running.startedAt)) / 1000));
    await completeSession(elapsed, true);
    kit.createFeedback(dom.feedback).set('session ended and recorded as interrupted', 'warn');
    return;
  }
  state.paused = false;
  state.remainingMs = state.selectedMinutes * 60000;
  renderClock();
  kit.createFeedback(dom.feedback).set('timer reset');
}

async function deleteSession(id) {
  try {
    await api.del(`/sessions/${encodeURIComponent(id)}`);
    await refreshHistory();
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}
