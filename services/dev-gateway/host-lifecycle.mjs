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
