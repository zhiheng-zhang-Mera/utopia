/**
 * UTOPIA · Rooms · Room D8 — Evidence Engine Lab (client).
 * Build the sample evidence bundle, read the manifest, integrityRoot, claims,
 * disputes, missing providers and the PASS/HOLD decision, and watch a tampered
 * artifact fail closed. Nothing is stored and no provider is ever contacted.
 */

let kit;
let api;
let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const capabilities = await api.get('/capabilities');

  const decisionBox = kit.el('div', { id: 'ee-decision' });
  const integrityBox = kit.el('div', { id: 'ee-integrity' });
  const manifestBox = kit.el('div', { class: 'scroll-y', id: 'ee-manifest' });
  const claimsBox = kit.el('div', { class: 'scroll-y', id: 'ee-claims' });
  const disputesBox = kit.el('div', { id: 'ee-disputes' });
  const feedback = kit.el('p', { class: 'feedback', id: 'ee-feedback' });
  const promptBox = kit.el('pre', { class: 'mono small', id: 'ee-prompt' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Evidence bundle' }),
    kit.el('p', { class: 'muted small', text: 'The decision comes from the durable claim and dispute state, never from how far a task got.' }),
    kit.el('p', { class: 'muted small', id: 'ee-rule', text: capabilities.pass_rule }),
    kit.el('div', { class: 'row' }, [
      kit.el('button', { class: 'primary', type: 'button', text: 'Build bundle', id: 'ee-build' }),
      kit.el('button', { type: 'button', text: 'Build with a dispute', id: 'ee-dispute' }),
      kit.el('button', { type: 'button', text: 'Tamper with a proposal', id: 'ee-tamper' }),
      kit.el('button', { type: 'button', text: 'Build without a provider', id: 'ee-missing' }),
    ]),
    feedback,
    decisionBox,
    integrityBox,
    disputesBox,
    promptBox,
  ]);

  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Artifact manifest' }),
    manifestBox,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:16px', text: 'Claims and their evidence' }),
    claimsBox,
  ]);

  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));
  dom = { decisionBox, integrityBox, manifestBox, claimsBox, disputesBox, feedback, promptBox };

  document.getElementById('ee-build').addEventListener('click', () => build({}));
  document.getElementById('ee-dispute').addEventListener('click', () => build({
    disputes: [{ topic: 'trust anchor', positions: ['keep it', 're-verify it'] }],
  }));
  document.getElementById('ee-missing').addEventListener('click', () => build({
    task: { ...capabilities.sample_task, providerIds: [...capabilities.sample_task.providerIds, 'provider-delta'] },
  }));
  document.getElementById('ee-tamper').addEventListener('click', tamper);

  await build({});
  return () => {};
}

async function sample() {
  const response = await api.get('/task/sample');
  return response;
}

async function build({ disputes = [], task = null } = {}) {
  try {
    const build = await sample();
    const payload = { task: task ?? build.task, artifacts: build.artifacts, disputes, providerIds: (task ?? build.task).providerIds };
    const result = await api.post('/bundle/build', payload);
    render(result);
    if (result.ok === false) {
      kit.createFeedback(dom.feedback).set(`${result.code}: ${result.reason}`, 'error');
      return;
    }
    const rehydrate = await api.post('/claims/rehydrate', payload);
    dom.promptBox.textContent = rehydrate.ok ? Object.values(rehydrate.prompts)[0] ?? '' : '';
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

async function tamper() {
  try {
    const build = await sample();
    const target = build.artifacts.find((artifact) => artifact.kind === 'proposal');
    const result = await api.post('/artifact/tamper', { artifactId: target.id });
    render(result);
    if (result.ok === false) {
      kit.createFeedback(dom.feedback).set(
        `${result.code}: the mutated content no longer matches the hash stored at capture — refused, not re-hashed`,
        'error',
      );
      return;
    }
    kit.createFeedback(dom.feedback).set('unexpected: the tampered bundle was accepted', 'error');
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

function render(result) {
  dom.decisionBox.textContent = '';
  dom.integrityBox.textContent = '';
  dom.manifestBox.textContent = '';
  dom.claimsBox.textContent = '';
  dom.disputesBox.textContent = '';
  if (result.ok === false) {
    dom.decisionBox.append(kit.el('p', { class: 'mono', text: `${result.code} · artifact ${result.artifactId ?? '—'}` }));
    return;
  }
  const summary = result.summary;
  dom.decisionBox.append(
    kit.el('p', { class: 'badge', text: summary.decision }),
    kit.el('p', { class: 'mono small', text: `artifacts ${summary.artifacts} · claims ${summary.claims} · unresolved disputes ${summary.unresolvedDisputes} · missing providers ${summary.missingProviderIds.length}` }),
  );
  for (const reason of summary.reasons ?? []) {
    dom.decisionBox.append(kit.el('p', { class: 'muted small', text: `reason: ${reason}` }));
  }
  dom.decisionBox.append(kit.el('p', {
    class: 'mono small',
    text: `claims by status: ${Object.entries(summary.claimsByStatus).map(([status, count]) => `${status} ${count}`).join(' · ') || 'none'}`,
  }));
  kit.createFeedback(dom.feedback).set(
    summary.decision === 'PASS' ? 'evidence PASS: every provider answered, nothing is disputed or insufficient' : 'HOLD_FOR_REVIEW: at least one rule is unmet',
    summary.decision === 'PASS' ? 'ok' : 'warn',
  );

  dom.integrityBox.append(
    kit.el('p', { class: 'muted small', text: 'integrityRoot (SHA-256 over the sorted manifest `id:hash` lines)' }),
    kit.el('p', { class: 'mono small', text: summary.integrityRoot }),
  );

  const manifestTable = kit.el('table', { class: 'grid' });
  manifestTable.append(kit.el('tr', {}, [
    kit.el('th', { text: 'artifact' }),
    kit.el('th', { text: 'kind' }),
    kit.el('th', { text: 'provider' }),
    kit.el('th', { text: 'sha256' }),
    kit.el('th', { text: 'bytes' }),
  ]));
  for (const entry of result.bundle.manifest) {
    manifestTable.append(kit.el('tr', {}, [
      kit.el('td', { class: 'mono small', text: entry.artifactId }),
      kit.el('td', { text: entry.kind }),
      kit.el('td', { class: 'mono small', text: entry.providerId }),
      kit.el('td', { class: 'mono small', text: String(entry.sha256).slice(0, 16) }),
      kit.el('td', { text: String(entry.bytes) }),
    ]));
  }
  dom.manifestBox.append(manifestTable);

  const claimsTable = kit.el('table', { class: 'grid' });
  claimsTable.append(kit.el('tr', {}, [
    kit.el('th', { text: 'status' }),
    kit.el('th', { text: 'claim' }),
    kit.el('th', { text: 'evidence' }),
    kit.el('th', { text: 'missing labels' }),
  ]));
  for (const claim of result.bundle.claims) {
    claimsTable.append(kit.el('tr', {}, [
      kit.el('td', { class: 'mono small', text: claim.status }),
      kit.el('td', { text: claim.text.slice(0, 90) }),
      kit.el('td', { class: 'mono small', text: (claim.evidenceArtifactIds ?? []).join(', ') }),
      kit.el('td', { class: 'mono small', text: (claim.missingEvidenceLabels ?? []).join(', ') || '—' }),
    ]));
  }
  dom.claimsBox.append(claimsTable);

  if (result.bundle.disputes.length) {
    dom.disputesBox.append(kit.el('p', { class: 'muted small', text: 'disputes' }));
    for (const dispute of result.bundle.disputes) {
      dom.disputesBox.append(kit.el('p', {
        class: 'mono small',
        text: `${dispute.unresolved ? 'unresolved' : 'resolved'} · ${dispute.topic} · ${dispute.positions.join(' vs ')}`,
      }));
    }
  }
  if (result.bundle.missingProviderIds.length) {
    dom.disputesBox.append(kit.el('p', { class: 'mono small', text: `missing providers: ${result.bundle.missingProviderIds.join(', ')}` }));
  }
}
