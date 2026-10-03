// MESH-301 — node identity resolution: a STABLE physical identity and a CHANGEABLE display name.
//
// The Owner's rule, in code rather than in a record: a machine's name in the City defaults to `Alien-Win`, the
// display name may be customised, and the physical machine it refers to never changes. The City already models
// that split - it stores `id` (and `devicePrincipalId`, the same value) separately from `displayName` - so the
// only thing that must not be conflated is how the two are DERIVED.
//
// WHY THIS IS A MODULE AND NOT THREE LINES IN THE LAUNCHER: Mech measured that the persisted-identity mechanism
// described in Alien's kickoff record existed only in that record and in one local worktree, never on a branch -
// so identity stability rested on every caller happening to pass the same node id. That is exactly the kind of
// guarantee that breaks the moment a second host relies on it. Pulling the resolution out makes it testable, and
// `tests/mesh-node-identity.test.mjs` guards every rule below.
//
// PRECEDENCE
//   identity    = CITY_NODE_ID  >  --id <identity>  >  the identity persisted on this machine  >  'Alien-Win'
//   displayName = CITY_NODE_DISPLAY_NAME  >  the first positional argument  >  the identity
//
// A DISPLAY-NAME CHANGE NEVER MOVES THE IDENTITY: the persisted identity is written on first use and re-read
// afterwards, so renaming a machine leaves every record, handoff and event that refers to it intact.
export const DEFAULT_NODE_IDENTITY = 'Alien-Win';

export function resolveNodeIdentity({ argv = [], env = {}, readIdentity = () => null, writeIdentity = () => {} } = {}) {
  // Strip the `--id` PAIR only when the flag is actually present: with no flag the index is -1 and `idFlag + 1`
  // is 0, so a naive filter silently eats the display-name argument. That bug was measured before it was fixed.
  const idFlag = argv.indexOf('--id');
  const explicitId = idFlag >= 0 ? argv[idFlag + 1] ?? null : null;
  const positional = idFlag >= 0 ? argv.filter((_, i) => i !== idFlag && i !== idFlag + 1) : argv;
  const displayArg = positional[0] ?? null;

  let persistedId = null;
  try { persistedId = readIdentity() ?? null; } catch { /* a first run, or an unreadable file, must not stop the node */ }

  const identity = env.CITY_NODE_ID || explicitId || persistedId || DEFAULT_NODE_IDENTITY;
  const displayName = env.CITY_NODE_DISPLAY_NAME || displayArg || identity;

  // Persist on first use AND when the identity is explicitly changed, so the next run re-reads this machine's
  // stable identity instead of falling back to the default.
  if (persistedId !== identity) {
    try { writeIdentity(identity); } catch { /* a read-only workspace must not stop the node from running */ }
  }

  return Object.freeze({
    identity,
    displayName,
    renamed: persistedId !== null && persistedId === identity && displayName !== persistedId,
  });
}
