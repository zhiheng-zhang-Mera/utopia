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
  if (has('online')) return { mode: 'online-member', lifecycle: 'online', reason: '--online asks to use the stored membership' };
  if (has('host-only')) return { mode: 'standalone-service', lifecycle: 'service', reason: '--host-only hosts this City for other devices' };
  return { mode: 'standalone-page', lifecycle: 'page', reason: 'the default single-machine start follows the page that opened it' };
}

/** Does this mode follow a stored membership instead of this host's own City? */
export const followsMembership = plan => plan.mode === 'online-member';

/** Does this mode tie the City's life to the page that opened it? */
export const pageTied = plan => plan.lifecycle === 'page';
