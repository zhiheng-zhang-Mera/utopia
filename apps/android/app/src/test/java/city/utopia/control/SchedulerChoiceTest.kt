package city.utopia.control

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SchedulerChoiceTest {
 @Test fun absentOrMalformedChoicesDoNotInventAvailability() {
  assertNull(SchedulerChoice.fromEntry(JSONObject()))
  assertNull(SchedulerChoice.fromEntry(JSONObject("""{"userChoices":{"version":2,"decisionRequired":true}}""")))
  assertFalse(SchedulerChoice.fromEntry(JSONObject("""{"userChoices":{"version":1,"decisionRequired":true,"alternateDevice":{"allowed":true}}}"""))!!.allowed)
 }
 @Test fun canonicalRevisionAndRefusalArePreserved() {
  val accepted=SchedulerChoice.fromEntry(JSONObject("""{"userChoices":{"version":1,"decisionRequired":true,"alternateDevice":{"allowed":true,"expectedUpdatedAt":"2026-10-05T00:00:00.000Z"}}}"""))!!
  assertTrue(accepted.allowed)
  assertEquals("2026-10-05T00:00:00.000Z",accepted.revision)
  val refused=SchedulerChoice.fromEntry(JSONObject("""{"userChoices":{"version":1,"decisionRequired":true,"alternateDevice":{"allowed":false,"reason":"TARGET_DEVICE_BOUND"}}}"""))!!
  assertFalse(refused.allowed)
  assertEquals("TARGET_DEVICE_BOUND",refused.reason)
 }
}
