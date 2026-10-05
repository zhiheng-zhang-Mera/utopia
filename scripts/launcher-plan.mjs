// Which way should this start go?
//
// Extracted from the launcher so the decision can be tested without spawning a City: importing the launcher runs it.
//
// Three modes, and the default matters more than the other two:
//
//   standalone + page      (default) one person, one machine: open THIS host's City and let it follow the page
//   standalone + service   this machine is hosting for other devices: the City must not exit when a page closes
//   online                 joining or being joined: the only mode that follows a stored membership or adjusts a role
//
// A stored device enrollment used to divert an ordinary start to some other City, which is why `online` is explicit:
// the act of going online is what changes the role, and nothing else.
export const MODES = Object.freeze(['standalone-page', 'standalone-service', 'online-member']);

export function planStart({ args = [] } = {}) {
  const has = key => args.includes('--' + key);
  if (has('online')) return { mode: 'online-member', lifecycle: 'online', hosting: false, reason: '--online asks to use the stored membership' };
  if (has('host-only')) return { mode: 'standalone-service', lifecycle: 'service', hosting: true, reason: '--host-only hosts this City for other devices' };
  return { mode: 'standalone-page', lifecycle: 'page', hosting: false, reason: 'the default single-machine start follows the page that opened it' };
}

/** Does this mode follow a stored membership instead of this host's own City? */
export const followsMembership = plan => plan.mode === 'online-member';

/** Does this mode deliberately host this host's own City, whatever membership happens to be on disk? */
export const hostsOwnCity = plan => plan.hosting === true;

/**
 * May this start use a stored device enrollment?
 *
 * The owner's rule is "starting a City ignores the role; going online is what adjusts it", and the accepted JOIN-503
 * contract in the same repository refines it: a host that is ALREADY a member of a City reconnects to that City without
 * launching a host City of its own, and reports CITY_UNREACHABLE when that City is down rather than quietly becoming a
 * different City. Both are satisfied by one rule:
 *
 *   - an explicit HOSTING start (--host-only, and the hosting script) never consults a membership;
 *   - any other start may follow a membership that still exists on disk (a reconnect, which is what being online means
 *     for that host);
 *   - and no start except an online one ever WRITES the role (that is enforced in the gateway, not here).
 *
 * What must never happen, and what this predicate exists to prevent, is a start that silently turns a member host into
 * a second, unrelated City in the same state directory.
 */
export const mayFollowStoredMembership = plan => !hostsOwnCity(plan);

/** Does this mode tie the City's life to the page that opened it? */
export const pageTied = plan => plan.lifecycle === 'page';

/**
 * What the person who just started a City should be told about the life they got.
 *
 * The start mode is a fact about their own machine, and the honest place to disclose it is the moment the City starts -
 * not later, when the City disappears because a page closed. Returned as plain lines so the launcher and its tests read
 * the same words instead of two drifting copies.
 */
export function describeStart({ lifecycle, roleIgnored } = {}) {
  const lines = [];
  if (lifecycle === 'page') lines.push('This City follows this page: closing it closes the City.');
  else if (lifecycle === 'service') lines.push('This City keeps running on its own: close this page whenever you like.');
  else if (lifecycle === 'online') lines.push('This City is online and keeps running on its own.');
  if (roleIgnored) lines.push('A single-machine start does not use the stored role; going online is what changes the role.');
  return lines;
}
