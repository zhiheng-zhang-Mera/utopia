/**
 * UI-000 · real icon system.
 *
 * The current product uses ASCII/Unicode geometry (◈ ▦ ◇ ≋ ◉ ▤ ≣ ⊞ ⚙ ▣) as its
 * "icons". The UI-000 hard rule forbids that. This module is a small, real SVG
 * icon set: one 24×24 grid, `currentColor` stroke, no icon font, no dependency.
 *
 * All three candidates consume this same set so an icon can never be a reason for
 * the candidates to look "different" in a way that encodes missing function.
 */

const wrap = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICON_PATHS = {
  /* primary surfaces */
  home: wrap('<path d="M4 10.5 12 4l8 6.5"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>'),
  ask: wrap('<path d="M20 12a7 7 0 0 1-7 7H9l-4 3v-4.6A7 7 0 0 1 4 12a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7Z"/><path d="M9.5 12h.01M12.5 12h.01M15.5 12h.01"/>'),
  tools: wrap('<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h4"/><path d="M12 17h8"/><circle cx="10" cy="17" r="2"/>'),
  devices: wrap('<rect x="3" y="5" width="13" height="9" rx="1.5"/><path d="M6 17h7"/><path d="M9.5 14v3"/><rect x="17" y="9" width="4.5" height="10" rx="1.5"/>'),
  activity: wrap('<path d="M3 12h3.5l2-6 3 12 2.5-8 1.8 4H21"/>'),

  /* advanced surfaces */
  services: wrap('<path d="M12 3.5 20 8v8l-8 4.5L4 16V8Z"/><path d="M12 12v8.5"/><path d="M4 8l8 4 8-4"/>'),
  tasks: wrap('<path d="M4 6.5 6 8.5 9.5 5"/><path d="M4 17.5 6 19.5 9.5 16"/><path d="M12 7h8"/><path d="M12 18h8"/>'),
  actions: wrap('<path d="M5 5v9a3 3 0 0 0 3 3h11"/><path d="M15 13.5 18.5 17 15 20.5"/><circle cx="5" cy="5" r="1.6"/>'),
  pairing: wrap('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h3v3"/><path d="M20 20h-3"/>'),
  settings: wrap('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1"/>'),

  /* status and domain */
  check: wrap('<path d="M4.5 12.5 9.5 17.5 19.5 7"/>'),
  alert: wrap('<path d="M12 4.5 21 19.5H3Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>'),
  running: wrap('<path d="M12 3.6a8.4 8.4 0 1 0 8.4 8.4"/><path d="M20.4 12A8.4 8.4 0 0 0 12 3.6"/>'),
  offline: wrap('<path d="M5 5l14 14"/><path d="M9.5 5.6A8.4 8.4 0 0 1 20.4 12a8.4 8.4 0 0 1-1.2 4.3"/><path d="M6.3 8.2A8.4 8.4 0 0 0 12 20.4"/>'),
  search: wrap('<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5 20 20"/>'),
  chevron: wrap('<path d="M9 6l6 6-6 6"/>'),
  plus: wrap('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  close: wrap('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
  cpu: wrap('<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3"/>'),
  memory: wrap('<rect x="3.5" y="7" width="17" height="10" rx="1.5"/><path d="M7 17v3M12 17v3M17 17v3"/>'),
  disk: wrap('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/>'),
  clock: wrap('<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>'),
  room: wrap('<path d="M4 20V5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5V20"/><path d="M16 10h3a1 1 0 0 1 1 1v9"/><path d="M3 20h18"/><path d="M11 12h.01"/>'),
  user: wrap('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  shield: wrap('<path d="M12 3.5 19 6v6c0 4-3 7-7 8.5C8 19 5 16 5 12V6Z"/>'),
  filter: wrap('<path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/>'),
  expand: wrap('<path d="M9 6l6 6-6 6"/>'),
};

export const ICON_IDS = Object.keys(ICON_PATHS);

/**
 * Return the SVG markup for an icon. Unknown ids fall back to a neutral dot rather
 * than silently rendering nothing, so a typo shows up in review.
 */
export function icon(id) {
  return ICON_PATHS[id] ?? wrap('<circle cx="12" cy="12" r="2.5"/>');
}

export default { ICON_PATHS, ICON_IDS, icon };
