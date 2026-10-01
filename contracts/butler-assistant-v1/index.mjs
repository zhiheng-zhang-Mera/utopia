// Public surface of the Butler Assistant Zone contract (BA-001).
//
// Consumers (BA-002 shared brain, BA-003 embodiment, BA-007 settings surface,
// Web/Android clients) import only from this entry point.
export * from './personalization.mjs';
export * from './zone.mjs';

export const BUTLER_ASSISTANT_CONTRACT = Object.freeze({
 id: 'butler-assistant-zone',
 version: 1,
 profile_schema_version: 1,
 bundle_version: 1,
 ports: Object.freeze(['address', 'voice', 'appearance', 'personality', 'duties', 'companion']),
 authority: 'profile-descriptive-only'
});
