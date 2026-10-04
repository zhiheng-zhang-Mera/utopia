// Route resolution over a `uiautomator dump` XML tree.
//
// WHY THIS MODULE EXISTS, and it is a defect I introduced rather than a hypothetical:
// scripts/device-task-pilot.mjs used to reach the task surface with a hard-coded
// `input tap 108 2195`. That was host-specific (it assumes roughly a 1080x2400 device) but it
// WORKED on the device the E2E is run against. I replaced it with a label lookup,
//
//     nodeByText(source,text) => [...matchAll(/<node\s+([^>]+)>/g)].find(m => m[1].includes('text="'+text+'"'))
//
// which returns the FIRST node carrying the label and does not filter for a node of any size. On the
// shipped shell that first match is a zero-bounds node, the tap lands on (0,0), and the route
// silently does nothing.
//
// MEASURED against real captures, not a hand-made example. The shipped shell's bottom bar has this
// document-order shape, and three separate traps follow from it:
//
//     [CLICK "" 0,2155][200,2244]     <- tab slot 0, EMPTY text
//     [     "Home"     [0,0][0,0]]    <- its label, ZERO-SIZED, clickable=false
//     [     "Devices"  [0,0][0,0]]    <- the ACTIVE tab: label only, NO clickable node
//     [CLICK "" [440,2155][640,2244]] <- tab slot 2
//     [     "Tasks"    [0,0][0,0]]
//     ... Activity, Settings likewise
//
//   1. TRAP: a zero-bounds filter alone is NOT the fix. Every nav label is zero-sized, so filtering
//      them leaves nothing to tap: the lookup returns undefined and the caller crashes on the next
//      line instead of silently mis-tapping. Trading a silent no-op for a crash is not a fix.
//   2. TRAP: the label can be a HEADING. `text="Devices"` occurs twice in one real capture - the
//      sized page heading at [56,268][339,354] and the zero-sized nav label. A label-only lookup can
//      therefore return page content and tap it. Requiring a nav target to lie inside the bottom
//      band removes this, and the band is also where both shells put their real tabs.
//   3. TRAP: the ACTIVE tab has no clickable node, so tabs cannot be addressed by clickable ordinal.
//      On the Devices page the clickable band holds only four nodes, and band[0] happens to be Home;
//      on the Home page Home is the active tab and carries no clickable, so band[0] would be
//      Devices. An ordinal over clickables is therefore page-dependent and silently wrong. Targets
//      are paired to labels in document order instead, giving a STABLE index that does not move when
//      the active page changes.
//
// On the earlier shell (UI-102 era) the Home label IS sized - e.g. [43,1535][102,1560] - though its
// `clickable` is still false, because the clickable target is an ancestor. Tapping the centre of the
// sized label works there, which is why the old geometry-derived tap behaved. That case is kept as
// the first strategy so the module does not regress the shell it used to handle.
//
// Callers get null rather than a zero-bounds node, so "could not resolve" is a loud decision at the
// call site instead of a tap on the screen corner. Which strategy answered is reported, not hidden.

export const NAV_LABELS = ['Home', 'Tasks', '首页', '任务', 'Activity', 'Actions', '行动', '操作记录'];

const NODE_RE = /<node\s+([^>]*?)\s*\/?>/g;
const BOUNDS_RE = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/;
const TEXT_RE = /text="([^"]*)"/;

/** Attribute strings of every `<node>` in the dump, in document order. */
export const nodesOf = (xml) => [...String(xml).matchAll(NODE_RE)].map((m) => m[1]);

/** Parsed bounds, or null when the node carries none. */
export const boundsOf = (attrs) => {
  const m = BOUNDS_RE.exec(attrs);
  return m ? { left: +m[1], top: +m[2], right: +m[3], bottom: +m[4] } : null;
};

/** A node is usable as a tap target only when it occupies at least one pixel in both axes. */
export const isSized = (attrs) => {
  const b = boundsOf(attrs);
  return !!b && b.right > b.left && b.bottom > b.top;
};

export const textOf = (attrs) => {
  const m = TEXT_RE.exec(attrs);
  return m ? m[1] : '';
};

/** Tap point at the centre of a node, as the strings `input tap` expects. */
export const centreOf = (attrs) => {
  const b = boundsOf(attrs);
  if (!b) throw Error('centreOf: node has no bounds');
  return [String((b.left + b.right) >> 1), String((b.top + b.bottom) >> 1)];
};

/** Display size of the dump. Derived from the nodes, so no hard-coded device geometry is needed. */
export const screenOf = (xml) => {
  let right = 0, bottom = 0;
  for (const attrs of nodesOf(xml)) {
    const b = boundsOf(attrs);
    if (!b) continue;
    if (b.right > right) right = b.right;
    if (b.bottom > bottom) bottom = b.bottom;
  }
  return { width: right, height: bottom };
};

/** Anything at or below this fraction of the display height is navigation, not page content. */
export const inNavBand = (bounds, height, bandRatio = 0.85) =>
  !!bounds && bounds.top >= height * bandRatio;

/** Clickable, sized nodes in the bottom band, ordered left to right. */
export const navBandOf = (xml, { bandRatio = 0.85 } = {}) => {
  const { height } = screenOf(xml);
  return nodesOf(xml)
    .filter((a) => /clickable="true"/.test(a) && isSized(a))
    .map((a) => ({ attrs: a, bounds: boundsOf(a) }))
    .filter((n) => inNavBand(n.bounds, height, bandRatio))
    .sort((p, q) => p.bounds.left - q.bounds.left);
};

/**
 * Pair each navigation label with its tappable target, in document order.
 *
 * The shipped shell emits a tab's clickable node immediately BEFORE its label, and omits the
 * clickable node for whichever tab is active. So a running queue of not-yet-consumed band nodes,
 * consumed by the next label that follows, recovers the mapping; a label that finds the queue empty
 * is the active tab and yields `target: null`. The result is indexed by LABEL position, which is
 * stable across pages - unlike an index over clickable nodes, which shifts with the active tab.
 */
export const navTargetsOf = (xml, { bandRatio = 0.85 } = {}) => {
  const { height } = screenOf(xml);
  const queue = [];
  const targets = [];
  for (const attrs of nodesOf(xml)) {
    if (/clickable="true"/.test(attrs) && isSized(attrs) && inNavBand(boundsOf(attrs), height, bandRatio)) {
      queue.push(attrs);
      continue;
    }
    const label = textOf(attrs);
    if (label === '' || isSized(attrs)) continue; // nav labels are the zero-sized, non-empty ones
    if (!/class="android\.widget\.TextView"/.test(attrs)) continue;
    const owner = queue.shift() ?? null;
    targets.push({ label, attrs: owner, active: owner === null });
  }
  return targets;
};

/**
 * Resolve a tappable route to the given tab.
 * Returns `{attrs, bounds, centre, via}` or **null** when nothing tappable was found.
 * `via` is `'label'` or `'nav-band'`, reported so a run can say which strategy it relied on.
 *
 * Strategy 1: the paired target for the first requested label that HAS one. This is the shipped
 * shell, and it is tried first because a paired target is known to be a real in-band clickable node.
 * Strategy 2: among requested labels the pairing does NOT know about, the lowest sized one. Lowest
 * because navigation sits at the bottom of the screen on every device, so "lowest matching label"
 * separates a nav entry from a page heading without any height threshold - a threshold is what broke
 * the 160dp device, where the bar sits at 82% of a 640px screen and a 0.85 band excluded it.
 *
 * A label that the pairing knows about is deliberately NOT eligible for strategy 2, even when its
 * paired target is null: on the shipped shell `Devices` is the active tab with no clickable node AND
 * a sized page heading of the same name, and falling back would tap that heading.
 */
export const resolveRoute = (xml, { labels = NAV_LABELS, bandRatio = 0.85 } = {}) => {
  const targets = navTargetsOf(xml, { bandRatio });
  const paired = labels
    .map((l) => targets.find((t) => t.label === l && t.attrs))
    .find(Boolean);
  if (paired) {
    return {
      attrs: paired.attrs,
      bounds: boundsOf(paired.attrs),
      centre: centreOf(paired.attrs),
      via: 'nav-band',
      label: paired.label,
    };
  }
  const known = new Set(targets.map((t) => t.label));
  const sized = labels
    .flatMap((l) => (known.has(l) ? [] : nodesOf(xml).filter((a) => textOf(a) === l && isSized(a))))
    .sort((p, q) => boundsOf(q).top - boundsOf(p).top)[0];
  if (sized) {
    return { attrs: sized, bounds: boundsOf(sized), centre: centreOf(sized), via: 'label' };
  }
  return null;
};

/** Sized label target for action buttons; zero-bounds labels are never tappable. */
export const nodeByLabel=(xml,labels)=>nodesOf(xml).find(attrs=>labels.includes(textOf(attrs))&&isSized(attrs))??null;
