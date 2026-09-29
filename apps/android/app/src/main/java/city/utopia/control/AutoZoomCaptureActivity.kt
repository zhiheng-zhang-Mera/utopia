package city.utopia.control

import android.os.Handler
import android.os.Looper
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.camera.CameraSettings
import org.json.JSONObject
import java.io.File
import java.time.Instant

/** Camera-only scan. No preview frames or decoded pairing material are recorded. */
class AutoZoomCaptureActivity : CaptureActivity() {
 private lateinit var scanner:DecoratedBarcodeView
 private val handler=Handler(Looper.getMainLooper())
 private var step=0
 @Volatile private var active=false
 private val adjust=object:Runnable {
  override fun run() {
   if(!active) return
   val currentStep=step++
   scanner.barcodeView.cameraInstance?.changeCameraParameters { parameters ->
    if(active) {
     val ratios=if(parameters.isZoomSupported) parameters.zoomRatios else null
     val selected=scanZoomIndex(ratios,parameters.maxZoom,currentStep)
     // Readback is the previous camera state; a request alone is not proof of application.
     val observed=ratios?.getOrNull(parameters.zoom)
     if(selected!=null) parameters.zoom=selected
     runCatching {
      val row=JSONObject().put("timestamp",Instant.now().toString())
       .put("event","cameraZoom").put("supported",parameters.isZoomSupported)
       .put("observedRatioPercent",observed?:JSONObject.NULL)
       .put("requestedRatioPercent",selected?.let { ratios?.get(it) }?:JSONObject.NULL)
       .put("focusMode",parameters.focusMode)
      File(filesDir,"scan-camera-events.jsonl").appendText(row.toString()+"\n")
     }
    }
    parameters
   }
   handler.postDelayed(this,2200)
  }
 }
 override fun initializeContent():DecoratedBarcodeView {
  scanner=super.initializeContent()
  return scanner
 }
 override fun onResume() {
  // Intent initialization replaces CameraSettings after initializeContent().
  scanner.barcodeView.cameraSettings.focusMode=CameraSettings.FocusMode.CONTINUOUS
  super.onResume()
  runCatching { File(filesDir,"scan-camera-events.jsonl").writeText("") }
  active=true; step=0
  handler.postDelayed(adjust,800)
 }
 override fun onPause() {
  active=false; handler.removeCallbacks(adjust)
  super.onPause()
 }
 override fun onDestroy() {
  active=false; handler.removeCallbacks(adjust)
  super.onDestroy()
 }
}
