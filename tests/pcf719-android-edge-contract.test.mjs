import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source/seam guards only. Native behavior is exercised by PcfWorkerTest/PcfForegroundTest;
// these checks do not claim instrumentation or physical-device acceptance.
const source = name => readFileSync(new URL(`../apps/android/app/src/main/java/city/utopia/control/${name}.kt`, import.meta.url), 'utf8');
const service = source('PcfWorkerService');
const provider = source('PcfWorkerProvider');
const manifest = readFileSync(new URL('../apps/android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');

test('PCF-719 service stays non-exported and has no launch-intent grant', () => {
  assert.match(manifest, /<service[^>]*android:name="\.PcfWorkerService"[^>]*android:exported="false"[^>]*foregroundServiceType="shortService"/);
  assert.match(service, /return START_NOT_STICKY/);
  assert.doesNotMatch(service, /getStringExtra|credentialSecret|setAppForeground/);
  assert.match(service, /check\(foreground\.visible\(\)\)/);
  assert.match(service, /provider\.optIn\(binding,ownerApproved,backgroundApproved\)/);
});

test('PCF-719 visibility comes from observed application lifecycle and fresh execution checks', () => {
  assert.match(service, /application\.registerActivityLifecycleCallbacks\(lifecycle\)/);
  assert.match(service, /application\.unregisterActivityLifecycleCallbacks\(lifecycle\)/);
  assert.match(service, /onActivityResumed\(activity:Activity\) \{ foreground\.resumed\(activity\) \}/);
  assert.match(service, /onActivityPaused\(activity:Activity\) \{ foreground\.paused\(activity\) \}/);
  assert.match(service, /onActivityDestroyed\(activity:Activity\) \{ foreground\.destroyed\(activity\) \}/);
  assert.match(service, /PcfWorkerConditions\(foreground\.visible\(\)/);
  assert.match(service, /provider\.ticket\(conditions\(\)\)/);
  assert.match(service, /provider\.accepts\(ticket,conditions\(\)\)/);
  assert.doesNotMatch(service, /appForeground|fun set.*Foreground/);
});

test('PCF-719 allowlist, identity separation and fail-closed resource gates remain bounded', () => {
  assert.match(provider, /controlInstallationId != workerInstallationId/);
  assert.match(provider, /require\(ownerApproved\)/);
  assert.match(provider, /executor=="text\.normalize\.v1"/);
  assert.match(provider, /input\.length<=16384/);
  for (const reason of ['BACKGROUND_NOT_APPROVED','LOW_BATTERY','THERMAL_LIMIT','POWER_SAVING','OFFLINE','METERED_NETWORK','PERMISSION_REVOKED']) {
    assert.ok(provider.includes(`"${reason}"`), reason);
  }
  assert.doesNotMatch(service + provider, /CameraManager|MediaRecorder|AudioRecord|Runtime\.getRuntime|ProcessBuilder|UUID/);
  assert.match(service, /fun revoke\(\)=halt\(\)/);
  assert.match(service, /onTaskRemoved\(rootIntent:Intent\?\) \{ halt\(\)/);
});
