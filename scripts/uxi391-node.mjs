// UXI-391 — launch ONE reference node with an explicit id.
//
// `agents/reference-node/main.mjs` passes no `id`, so `startAgent` falls back to its default and TWO copies
// register as ONE device. Mech hit this during its UXI-390 review ("the two nodes had to be started with
// distinct ids to have two devices at all"), and UXI-391's single-machine dual-node E2E needs two devices to
// exist at all. This launcher is the smallest thing that makes that possible without touching the node's own
// entry point.
//
// Usage: node scripts/uxi391-node.mjs <nodeId> [displayName]
import { startAgent } from '../agents/reference-node/agent.mjs';

const id = process.argv[2] ?? process.env.CITY_NODE_ID ?? 'Alien-test';
const displayName = process.argv[3] ?? process.env.CITY_NODE_DISPLAY_NAME ?? id;
if (!id) {
  console.error('usage: node scripts/uxi391-node.mjs <nodeId> [displayName]');
  process.exit(2);
}

const agent = await startAgent({
  url: process.env.CITY_URL || 'http://127.0.0.1:4310',
  token: process.env.CITY_NODE_TOKEN,
  workspace: process.env.CITY_WORKSPACE || '.runtime/workspace',
  id,
  displayName,
});
console.log(`City Node Reference Agent started as ${id}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await agent.stop(); process.exit(0); });
}
