package city.utopia.control

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant

/**
 * UI-102 review repair R-1: the node card must render the heartbeat as the same relative
 * age Web renders, instead of the gateway's raw ISO-8601 string.
 *
 * Pinned here rather than checked by eye because the defect this repairs was invisible to
 * the instrument the author had been using: a uiautomator dump reports a node's full text
 * and its layout bounds, so it cannot tell a raw timestamp from a formatted one, nor show
 * that the long string was clipped by the card edge.
 */
class RelativeAgeTest {
  private val now = Instant.parse("2026-10-01T15:42:41.730Z")

  @Test fun `a fresh heartbeat reads as zero seconds ago`() {
    assertEquals("0s ago", relativeAge("2026-10-01T15:42:41.730Z", now))
  }

  @Test fun `the age is the elapsed seconds, matching the Web convention`() {
    assertEquals("3s ago", relativeAge("2026-10-01T15:42:38.730Z", now))
    assertEquals("3661s ago", relativeAge("2026-10-01T14:41:40.730Z", now))
  }

  @Test fun `a clock-skewed future heartbeat never renders a negative age`() {
    assertEquals("0s ago", relativeAge("2026-10-01T15:43:41.730Z", now))
  }

  @Test fun `an absent or malformed heartbeat degrades to the existing wording`() {
    assertEquals("Unavailable", relativeAge(null, now))
    assertEquals("Unavailable", relativeAge("not-a-timestamp", now))
    assertEquals("Unavailable", relativeAge("", now))
  }
}
