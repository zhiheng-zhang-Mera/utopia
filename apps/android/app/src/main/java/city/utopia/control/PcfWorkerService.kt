package city.utopia.control

import android.app.*
import android.content.*
import android.net.ConnectivityManager
import android.os.*

/** App-local, default-inactive short service. There is no remote activation or launch-intent grant. */
class PcfWorkerService:Service() {
 private val provider=PcfWorkerProvider()
 private val lease=PcfWorkerLease()
 private val handler=Handler(Looper.getMainLooper())
 private val foreground=PcfForegroundState()
 private val lifecycle=object:Application.ActivityLifecycleCallbacks {
  override fun onActivityResumed(activity:Activity) { foreground.resumed(activity) }
  override fun onActivityPaused(activity:Activity) { foreground.paused(activity) }
  override fun onActivityStopped(activity:Activity) { foreground.paused(activity) }
  override fun onActivityDestroyed(activity:Activity) { foreground.destroyed(activity) }
  override fun onActivityCreated(activity:Activity,state:Bundle?) { }
  override fun onActivityStarted(activity:Activity) { }
  override fun onActivitySaveInstanceState(activity:Activity,state:Bundle) { }
 }
 private val expiry=Runnable { halt() }
 inner class LocalBinder:Binder() {
  /** Caller must resolve this grant through the authenticated worker enrollment path before activation. */
  fun activate(binding:PcfWorkerBinding, ownerApproved:Boolean, backgroundApproved:Boolean=false) {
   check(foreground.visible()) { "Observed resumed activity required" }
   provider.optIn(binding,ownerApproved,backgroundApproved)
   try {
    check(provider.availability(conditions())==null) { "Resource policy refused activation" }
    startForeground(719,notification())
    lease.activate(SystemClock.elapsedRealtime())
    handler.removeCallbacks(expiry);handler.postDelayed(expiry,120000)
   } catch(error:RuntimeException) { halt();throw error }
  }
  fun preprocess(executor:String,input:String):String {
   check(lease.active(SystemClock.elapsedRealtime())) { "Service activation expired" }
   val ticket=provider.ticket(conditions())
   val result=provider.execute(executor,input,conditions())
   check(lease.active(SystemClock.elapsedRealtime()) && provider.accepts(ticket,conditions())) { "Execution reclaimed; result discarded" }
   return result
  }
  fun stop()=halt()
  fun revoke()=halt()
 }
 private val binder=LocalBinder()
 override fun onCreate() { super.onCreate();application.registerActivityLifecycleCallbacks(lifecycle) }
 override fun onBind(intent:Intent):IBinder=binder
 override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int {
  // Starting the service cannot grant execution. STOP is the sole intent command.
  if(intent?.action==STOP || !lease.active(SystemClock.elapsedRealtime())) halt()
  return START_NOT_STICKY
 }
 override fun onTaskRemoved(rootIntent:Intent?) { halt();super.onTaskRemoved(rootIntent) }
 override fun onDestroy() {
  application.unregisterActivityLifecycleCallbacks(lifecycle);foreground.clear()
  handler.removeCallbacks(expiry);lease.stop();provider.onOsReclaimed();super.onDestroy()
 }
 override fun onTimeout(startId:Int) { halt() }
 private fun halt() { handler.removeCallbacks(expiry);lease.stop();provider.stop();stopForeground(STOP_FOREGROUND_REMOVE);stopSelf() }
 private fun conditions():PcfWorkerConditions {
  val power=getSystemService(PowerManager::class.java)
  val battery=registerReceiver(null,IntentFilter(Intent.ACTION_BATTERY_CHANGED))
  val level=battery?.getIntExtra(BatteryManager.EXTRA_LEVEL,-1) ?: -1
  val scale=battery?.getIntExtra(BatteryManager.EXTRA_SCALE,-1) ?: -1
  val network=getSystemService(ConnectivityManager::class.java)
  val capabilities=network.getNetworkCapabilities(network.activeNetwork)
  return PcfWorkerConditions(foreground.visible(),if(level>=0 && scale>0) level*100/scale else -1,
   if(Build.VERSION.SDK_INT>=29) power.currentThermalStatus else -1,
   network.isActiveNetworkMetered,capabilities?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)==true,
   power.isPowerSaveMode,true)
 }
 private fun notification():Notification {
  getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL,"Optional local compute",NotificationManager.IMPORTANCE_LOW))
  val stop=PendingIntent.getService(this,719,Intent(this,PcfWorkerService::class.java).setAction(STOP),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  return Notification.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.stat_notify_sync)
   .setContentTitle("Utopia local compute").setContentText("Approved CPU preprocessing; stops within two minutes")
   .setOngoing(true).addAction(Notification.Action.Builder(null,"Stop",stop).build()).build()
 }
 companion object { private const val CHANNEL="pcf719-worker";private const val STOP="city.utopia.control.PCF_STOP" }
}
