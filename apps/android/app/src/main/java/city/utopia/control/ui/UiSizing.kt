package city.utopia.control.ui

/**
 * UI-102 · narrow-width / large-font fitting arithmetic.
 *
 * This module is Compose Material 3 on BOM 2025.04.01, which resolves to Compose
 * Foundation 1.8.0 and Material 3 1.3.2. Automatic text sizing
 * (`BasicText(autoSize = ...)` / `TextAutoSize`, which landed in Compose 1.9 /
 * Material 3 1.4) is NOT available here, so "shrink the label until it fits" has to be
 * decided from measurements this code makes itself.
 *
 * The decision is kept pure — plain numbers in, a plain enum out — for two reasons:
 *  - it is the whole failure mode. A 320dp viewport at `font_scale = 1.5` clipped the five
 *    bottom labels to `Ho`/`As`/`Ro`/`De`/`Ac`, and clipped text is invisible to
 *    `contentDescription`, so only a code-level assertion can pin the chosen size;
 *  - the module cannot build `androidTest` offline (`ui-test-junit4` and `androidx.test`
 *    are absent from this machine's Gradle cache — recorded in UI-102's report), so a JVM
 *    test over these functions is the strongest instrument available.
 *
 * Every function assumes what `Text` assumes with `softWrap = false`: a single line, and
 * measured width proportional to the requested font size. Under those assumptions the
 * measured sizes are monotonic in size, so scanning down and stopping at the first fit is
 * exactly "the largest size that fits".
 */

/** What the bar draws for one entry. Degrading to [IconOnly] is deliberate, never incidental. */
enum class NavLabelMode {
  /** Full label, at [NavLabelChoice.spanSize]. */
  Label,

  /** No room for a legible label: icon only, with the label kept as the accessibility name. */
  IconOnly,
}

/**
 * @param mode whether the label is drawn
 * @param spanSize the `TextUnit` value to render at: index into the `spans` passed to
 *   [chooseNavLabel] for [NavLabelMode.Label], or `spans.last()` — the smallest, most
 *   conservative size — for [NavLabelMode.IconOnly].
 */
data class NavLabelChoice(val mode: NavLabelMode, val spanSize: Int) {
  val showsLabel: Boolean get() = mode == NavLabelMode.Label
}

/**
 * Picks the largest candidate size whose widest line still fits [availablePx].
 *
 * @param measuredPx line widths, one per candidate size and in the SAME order as those
 *   candidates: `measuredPx[i]` is the width of the label at `spans[i]`. Each entry is the
 *   widest line the whole label needs at that size. [TextUnit] values are rendered exactly as
 *   passed, so the ambient `fontScale` is already inside these numbers and must not be
 *   applied a second time.
 * @param availablePx the width the label slot actually offers, in the same pixels.
 * @return the index of the largest candidate that fits, or `null` when every candidate
 *   overflows. `null` means "no legible label at any size we are willing to render", which
 *   the caller must degrade intentionally (see [chooseNavLabel]) rather than clip.
 * @throws IllegalArgumentException if [measuredPx] is not ordered largest → smallest, since
 *   a mis-ordered list would quietly select the smallest candidate instead of the largest.
 */
fun largestLabelFitPx(measuredPx: List<Int>, availablePx: Int): Int? {
  if (measuredPx.isEmpty() || availablePx <= 0) return null
  /* `measuredPx` is candidate-ordered largest → smallest, and the widths it holds are
     measured widths, so they must fall monotonically. Enforcing the contract here rather
     than trusting it: a list given in the other order silently picks the SMALLEST size that
     fits, which is the wrong answer and looks like it works. */
  require(measuredPx.zipWithNext().all { (a, b) -> a >= b }) {
    "measuredPx must be ordered largest to smallest, was $measuredPx"
  }
  /* The first candidate that fits is the largest one that fits, because the scan is
     descending. Scanning ascending and remembering the last fit would also be correct, but
     it would keep going after it had the answer. */
  val fit = measuredPx.indexOfFirst { it <= availablePx }
  return if (fit < 0) null else fit
}

/**
 * The whole bottom-bar sizing decision, independent of Compose.
 *
 * [spans] must be ordered largest → smallest so index 0 is the preferred size.
 *
 * Why a floor at all: a 5-entry bar on a 320dp viewport has roughly 50dp per entry, and
 * `Activity` is seven glyphs. Shrinking without a floor buys a variable pile of tiny type
 * instead of a decision, so below the floor we stop and switch to an icon-only entry that
 * keeps a real `contentDescription`. The label is not deleted; it moves to the
 * accessibility name and returns the moment the width allows.
 */
fun chooseNavLabel(measuredPx: List<Int>, availablePx: Int, spans: List<Int>): NavLabelChoice {
  require(spans.isNotEmpty()) { "spans must offer at least one candidate size" }
  val fit = largestLabelFitPx(measuredPx, availablePx)
  return if (fit == null) {
    NavLabelChoice(NavLabelMode.IconOnly, spans.last())
  } else {
    NavLabelChoice(NavLabelMode.Label, spans[fit])
  }
}
