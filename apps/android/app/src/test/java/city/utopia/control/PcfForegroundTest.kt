package city.utopia.control

import org.junit.Assert.*
import org.junit.Test

class PcfForegroundTest {
 @Test fun pauseImmediatelyRefusesDispatchAndCompletionWithoutBackgroundApproval() {
  val visibility=PcfForegroundState();val activity=Any()
  val worker=PcfWorkerProvider();worker.optIn(PcfWorkerBinding("city","device","control","worker","principal","handle"),true)
  assertFalse(visibility.visible())
  visibility.resumed(activity)
  assertTrue(visibility.visible())
  val ticket=worker.ticket(PcfWorkerConditions(foreground=visibility.visible()))
  visibility.paused(activity)
  assertFalse(visibility.visible())
  val background=PcfWorkerConditions(foreground=visibility.visible())
  assertEquals("BACKGROUND_NOT_APPROVED",worker.availability(background))
  assertFalse(worker.accepts(ticket,background))
  assertThrows(IllegalStateException::class.java) { worker.execute("text.normalize.v1","a",background) }
 }
 @Test fun onlyActuallyResumedActivitiesCountAndDestroyClearsVisibility() {
  val state=PcfForegroundState();val first=Any();val second=Any()
  state.paused(first);assertFalse(state.visible())
  state.resumed(first);state.resumed(first);state.resumed(second)
  state.paused(first);assertTrue(state.visible())
  state.destroyed(second);assertFalse(state.visible())
  state.resumed(first);state.clear();assertFalse(state.visible())
 }
}
