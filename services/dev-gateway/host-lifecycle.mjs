// Which life does this gateway process have, and does it consult a stored role?
//
// Extracted from main.mjs because this predicate has now hidden a real regression twice: once when it was read from
// `CITY_LIFECYCLE` alone, which made a member agent (spawned with CITY_MEMBER_FILE, no page, no hosting) start as a
// PRIMARY City of its own. A rule that decides whether a process becomes a City or a client of one belongs somewhere it
// can be tested without spawning anything.
//
// The three declared values, and what they mean together:
//
//   page     single machine, one person: the City follows the page that opened it. Role ignored.
//   service  single machine, hosting for other devices: never exits on its own. Role ignored.
//   online   joining or being joined: the only declared value that consults the stored role and writes it back.
//
// And one value that is not declared, because it is implied by what the process IS:
//
//   a member agent (CITY_MEMBER_FILE) is online by construction. It exists to be online inside another City, so it must
//   never be page-tied and must never be treated as a host start. This is not a fourth mode; it is the same `online`
//   life reached from the member side, and folding it in here is what keeps the member path from silently becoming a
//   second, unrelated City.
export const LIFECYCLES = Object.freeze(['page', 'service', 'online']);

export function resolveLifecycle(env = {}) {
  const declared = LIFECYCLES.includes(env.CITY_LIFECYCLE) ? env.CITY_LIFECYCLE : 'page';
  const memberAgentFile = env.CITY_MEMBER_FILE || null;
  const online = declared === 'online' || Boolean(memberAgentFile);
  return {
    declared,
    /** The life in effect. `online` whenever a member agent is involved, whatever was declared. */
    lifecycle: online ? 'online' : declared,
    online,
    memberAgentFile,
    /** True when a stored role must NOT be consulted or written: every life except `online`. */
    roleIgnored: !online,
    /** The gateway's page-tiedness. Only a plain `page` start follows a page; a member agent never does. */
    gatewayLifecycle: !online && declared === 'page' ? 'page' : 'service',
  };
}

/**
 * Which membership file, if any, may this start use?
 *
 * The owner's rule is "starting a City ignores the role; only going online adjusts it", and the accepted contracts in
 * this repository draw the line more precisely than a single boolean. Extracted here because getting it wrong produced
 * two hosted-CI regressions in a row, both in the same predicate:
 *
 *   1. a MEMBER AGENT (CITY_MEMBER_FILE) is online by construction and must never become a host City of its own;
 *   2. a STORED MEMBER SELECTION must be FOLLOWED, because that is this host resuming a membership it already holds -
 *      `tests/host-city-launcher.test.mjs` asserts that a normal main.mjs restart preserves the member role, and a
 *      restart that silently promoted itself to PRIMARY would be a different City wearing the same state directory;
 *   3. a LEFTOVER device enrollment with NO stored selection must NOT divert an ordinary start. THAT was the reported
 *      defect: enrolling once made every later plain start a member agent for somebody else's City;
 *   4. a stored selection whose credential is gone must REFUSE, not quietly start a PRIMARY City in its place - the
 *      person's host is a member of a City; pretending otherwise hides a lost credential behind a new identity.
 *
 * `onlineOnly` controls only case 3: the leftover-enrollment fallback is an online convenience, never a default.
 */
export function selectMemberFile({env = {}, selection = null, hasRoleSelection = false, deviceFile = null, deviceEnrollment = null, online = false} = {}) {
  const memberAgentFile = env.CITY_MEMBER_FILE || null;
  if (memberAgentFile) return {file: memberAgentFile, source: 'MEMBER_AGENT', refuse: null};
  if (selection?.role === 'MEMBER') {
    const file = selection.memberEnrollmentFile ?? null;
    // The gateway is given the credential that the selection names; a missing one is a refusal, never a fallback.
    return deviceEnrollment ? {file, source: 'STORED_MEMBER_SELECTION', refuse: null} : {file: null, source: 'STORED_MEMBER_SELECTION', refuse: 'Selected member credential unavailable; no PRIMARY fallback started'};
  }
  if (online && !hasRoleSelection && deviceEnrollment) return {file: deviceFile, source: 'LEFTOVER_ENROLLMENT', refuse: null};
  return {file: null, source: 'NONE', refuse: null};
}
