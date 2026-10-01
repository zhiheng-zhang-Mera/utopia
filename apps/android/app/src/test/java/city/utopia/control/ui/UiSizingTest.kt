package city.utopia.control.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * UI-102 · the narrow-width / large-font fitting decision, pinned as a test.
 *
 * The on-device defect was a 320dp viewport at `font_scale = 1.5` rendering the five
 * bottom labels as `Ho`/`As`/`Ro`/`De`/`Ac`. Clipped text still satisfies every "the label
 * is present" check a UI test could make, so the thing worth pinning is the arithmetic:
 * which candidate size is chosen for a given measured width, and — the part that keeps the
 * fix honest — that the chosen candidate is one that actually fits.
 *
 * The widths here are synthetic but sized from the real configuration: at 320dp with five
 * entries the bar gives an entry roughly 50dp ≈ 150px at density 3.0, and `Activity` at
 * 11sp with `fontScale = 1.5` needs more than that.
 */
class UiSizingTest {

  /** The five primary surfaces, as measured widest-line widths at 11sp with fontScale 1.5. */
  private val primaryLabelsPx = listOf(
    "Home" to 108,
    "Ask" to 92,
    "Rooms" to 152,
    "Devices" to 182,
    "Activity" to 196,
  )

  /** 11sp → 10sp → 9sp, largest first, as the bar passes them. */
  private val spans = listOf(11, 10, 9)

  /**
   * `Activity` (the binding constraint) as measured at each candidate size, in the same
   * largest→smallest order as [spans]: 196px at 11sp, 178px at 10sp, 160px at 9sp.
   */
  private val activityPx = listOf(196, 178, 160)

  @Test
  fun `all five primary labels fit their slot at the reference configuration`() {
    // 720x1600 at font_scale 1.0 — the configuration that already rendered correctly.
    val slotPx = 210
    for ((name, widthPx) in primaryLabelsPx) {
      assertTrue("$name should fit at the reference width", widthPx <= slotPx)
    }
  }

  @Test
  fun `a narrow slot steps down instead of clipping the label`() {
    // Room for the 10sp rendering but not the 11sp one: 10sp is chosen, and crucially the
    // label is still a label — this is a step-down, not a degradation.
    val stepped = chooseNavLabel(activityPx, availablePx = 180, spans = spans)
    assertEquals(NavLabelMode.Label, stepped.mode)
    assertEquals(10, stepped.spanSize)
    assertTrue(activityPx[1] <= 180)

    // Room for the 9sp rendering only.
    val smallest = chooseNavLabel(activityPx, availablePx = 160, spans = spans)
    assertEquals(NavLabelMode.Label, smallest.mode)
    assertEquals(9, smallest.spanSize)
  }

  @Test
  fun `the chosen size is always one that fits, or the caller is told none does`() {
    for (available in 0..260) {
      val choice = chooseNavLabel(activityPx, available, spans)
      if (choice.showsLabel) {
        val index = spans.indexOf(choice.spanSize)
        assertTrue(
          "chose ${choice.spanSize}sp (width ${activityPx[index]}px) for ${available}px",
          activityPx[index] <= available,
        )
        // and no larger candidate fitted, otherwise we shrank for nothing
        for (larger in 0 until index) {
          assertTrue("shrank past a candidate that fitted", activityPx[larger] > available)
        }
      } else {
        assertTrue("degraded although 9sp fitted at ${available}px", activityPx.last() > available)
      }
    }
  }

  @Test
  fun `the largest fitting size wins, not the smallest`() {
    // This is the regression that an ascending scan produces: 178px fits in 180px, but so
    // does 160px, and picking the smaller one shrinks every label on every phone for no
    // reason while still looking plausible in a screenshot.
    assertEquals(1, largestLabelFitPx(activityPx, 180))
    assertEquals(0, largestLabelFitPx(activityPx, 196))
    assertEquals(0, largestLabelFitPx(activityPx, 400))
    // One pixel under the 10sp width drops the whole step, and one pixel under the 9sp
    // width is the degradation boundary.
    assertEquals(1, largestLabelFitPx(activityPx, 178))
    assertEquals(2, largestLabelFitPx(activityPx, 160))
    assertNull(largestLabelFitPx(activityPx, 159))
  }

  @Test
  fun `a mis-ordered measurement list is rejected rather than silently mis-picked`() {
    // Ascending input makes "first fit" the SMALLEST size, which is the wrong answer and is
    // invisible in review. The contract is enforced, so this cannot regress quietly.
    try {
      largestLabelFitPx(listOf(160, 178, 196), 180)
      throw AssertionError("an ascending list should not have been accepted")
    } catch (expected: IllegalArgumentException) {
      assertTrue(expected.message!!.contains("largest to smallest"))
    }
  }

  @Test
  fun `below the floor the entry degrades to icon-only rather than to a fragment`() {
    // The exact 320dp case: an entry slot of roughly 150px at density 3.0.
    val choice = chooseNavLabel(activityPx, availablePx = 150, spans = spans)
    assertEquals(NavLabelMode.IconOnly, choice.mode)
    assertFalse(choice.showsLabel)
    // The smallest candidate is still reported, so the caller can render the accessibility
    // name at a conservative size rather than inventing one.
    assertEquals(9, choice.spanSize)
  }

  @Test
  fun `an unmeasurable slot yields instead of guessing`() {
    assertNull(largestLabelFitPx(activityPx, availablePx = 0))
    assertNull(largestLabelFitPx(emptyList(), availablePx = 500))
    assertNull(largestLabelFitPx(listOf(196), availablePx = -1))
    // A slot too small for even the smallest candidate is "no fit", not "index 0".
    assertEquals(NavLabelMode.IconOnly, chooseNavLabel(listOf(196), availablePx = 20, spans = listOf(11)).mode)
  }

  @Test
  fun `a size that exactly fills the slot is a fit`() {
    // Off-by-one here is the difference between a full label and a degraded entry.
    assertEquals(0, largestLabelFitPx(listOf(200), availablePx = 200))
    val exact = chooseNavLabel(listOf(200), availablePx = 200, spans = listOf(11))
    assertEquals(NavLabelMode.Label, exact.mode)
    assertEquals(11, exact.spanSize)
  }
}
