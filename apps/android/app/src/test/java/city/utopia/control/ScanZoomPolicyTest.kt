package city.utopia.control

import org.junit.Assert.*
import org.junit.Test

class ScanZoomPolicyTest {
 @Test fun neverExceedsTwoTimesOrAdvertisedIndex() {
  val ratios=listOf(100,125,150,175,200,400)
  for(step in 0..30) assertTrue(scanZoomIndex(ratios,5,step)!! in 0..4)
  assertEquals(1,scanZoomIndex(ratios,1,2))
 }
 @Test fun returnsToWideViewToRecoverFromCropping() {
  val ratios=listOf(100,150,200)
  assertEquals(listOf(0,1,2,0), (0..3).map { scanZoomIndex(ratios,2,it) })
 }
 @Test fun malformedCapabilitiesDoNotCauseCameraWrites() {
  assertNull(scanZoomIndex(null,0,0))
  assertNull(scanZoomIndex(emptyList(),2,0))
  assertNull(scanZoomIndex(listOf(0,50),1,1))
  assertNull(scanZoomIndex(listOf(100),-1,1))
 }
}
