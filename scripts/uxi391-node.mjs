// MESH-301 — launch ONE reference node with the Owner's naming rule applied.
//
// The rule ("this machine joins as Alien-Win; the display name may be customised; the physical machine never
// changes") and its precedence live in `scripts/mesh-node-identity.mjs`, which is unit-tested; this file only
// supplies the machine's identity store and starts the agent. Mech measured that the mechanism previously
// existed only in a record, so the mechanism is now code on this task's branch.
//
// Usage: node scripts/uxi391-node.mjs [displayName] [--id <identity>]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startAgent } from '../agents/reference-node/agent.mjs';
import { resolveNodeIdentity } from './mesh-node-identity.mjs';

const identityFile = process.env.CITY_NODE_IDENTITY_FILE || resolve(process.cwd(), '.city-node-identity.json');

const resolved = resolveNodeIdentity({
  argv: process.argv.slice(2),
  env: process.env,
  readIdentity: () => JSON.parse(readFileSync(identityFile, 'utf8'))?.id ?? null,
  writeIdentity: (id) => writeFileSync(
    identityFile,
    `${JSON.stringify({ id, firstSeenAt: new Date().toISOString(), note: 'stable physical identity; the display name may change without changing this' }, null, 2)}\n`,
    'utf8',
  ),
});

console.log(`City node identity=${resolved.identity} displayName=${resolved.displayName}${resolved.renamed ? ' (renamed: the identity is unchanged)' : ''}`);

const agent = await startAgent({
  url: process.env.CITY_URL || 'http://127.0.0.1:4310',
  token: process.env.CITY_NODE_TOKEN,
  workspace: process.env.CITY_WORKSPACE || '.runtime/workspace',
  id: resolved.identity,
  displayName: resolved.displayName,
});
console.log(`City Node Reference Agent started as ${resolved.displayName} (identity ${resolved.identity})`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await agent.stop(); process.exit(0); });
}
