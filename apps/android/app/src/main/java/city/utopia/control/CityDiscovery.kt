package city.utopia.control
import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper

class CityDiscovery(private val context: Context, private val found:(String,String?)->Unit, private val status:(String)->Unit, private val lost:(String)->Unit) {
 private val main=Handler(Looper.getMainLooper()); private val nsd=context.getSystemService(NsdManager::class.java)
 private var listener:NsdManager.DiscoveryListener?=null; private var scanner:BluetoothLeScanner?=null; private var callback:ScanCallback?=null
 private var radioReceiver:BroadcastReceiver?=null
 @Volatile private var bleScanning=false
 private val services=java.util.concurrent.ConcurrentHashMap<String,String>(); private val fence=CallbackFence(); private val seen=mutableMapOf<String,Long>()
 private fun report(ticket:Long,value:String) { main.post { if(fence.accepts(ticket)) status(value) } }
 private fun candidate(ticket:Long,origin:String,city:String?,bleOnly:Boolean=false) { main.post { if(fence.accepts(ticket) && (!bleOnly || bleScanning)) { val now=System.currentTimeMillis(); if(now-(seen[origin]?:0)>=5000) { seen[origin]=now; found(origin,city) } } } }
 fun lan() { stop(); val ticket=fence.ticket()?:return; report(ticket,"Searching LAN…"); listener=object:NsdManager.DiscoveryListener {
 override fun onDiscoveryStarted(type:String) {}
 override fun onDiscoveryStopped(type:String) {}
 override fun onStartDiscoveryFailed(type:String,error:Int) { report(ticket,"LAN discovery unavailable ($error)") }
 override fun onStopDiscoveryFailed(type:String,error:Int) {}
 override fun onServiceLost(service:NsdServiceInfo) { main.post { if(fence.accepts(ticket)) { services.remove(service.serviceName)?.let(lost); status("City left LAN · waiting for rediscovery") } } }
 override fun onServiceFound(service:NsdServiceInfo) { if(!fence.accepts(ticket))return; nsd.resolveService(service,object:NsdManager.ResolveListener {
 override fun onResolveFailed(service:NsdServiceInfo,error:Int) { report(ticket,"Discovery retry needed ($error)") }
 override fun onServiceResolved(service:NsdServiceInfo) { if(!fence.accepts(ticket))return; val a=service.attributes; if(a["v"]?.toString(Charsets.UTF_8)!="1" || a["api"]?.toString(Charsets.UTF_8)!="0" || a["schema"]?.toString(Charsets.UTF_8)!="0")return; val city=a["city"]?.toString(Charsets.UTF_8)?:return; services[service.serviceName]=city; candidate(ticket,"http://${service.host.hostAddress}:${service.port}",city) }
 }) }
 }; nsd.discoverServices("_utopia-city._tcp.",NsdManager.PROTOCOL_DNS_SD,listener) }
 fun ble() { stop(); val ticket=fence.ticket()?:return; val permission=if(Build.VERSION.SDK_INT>=31) Manifest.permission.BLUETOOTH_SCAN else Manifest.permission.ACCESS_FINE_LOCATION
 if(context.checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED) { report(ticket,"Permission denied; allow Nearby devices to scan"); return }
 val current=object:ScanCallback() { override fun onScanResult(type:Int,result:ScanResult) { if(!fence.accepts(ticket) || !bleScanning)return; val data=result.scanRecord?.getManufacturerSpecificData(0xffff)?:return; runCatching { bleAdvertisementEndpoint(data) }.onSuccess { candidate(ticket,it,null,true) } }; override fun onScanFailed(code:Int) { if(!fence.accepts(ticket) || !bleScanning)return; bleScanning=false; report(ticket,"Bluetooth scan failed ($code)") } }; callback=current
 try {
  val receiver=object:BroadcastReceiver() {
   override fun onReceive(context:Context,intent:Intent) {
    if(!fence.accepts(ticket) || intent.action!=BluetoothAdapter.ACTION_STATE_CHANGED)return
    when(intent.getIntExtra(BluetoothAdapter.EXTRA_STATE,BluetoothAdapter.ERROR)) {
     BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> {
      bleScanning=false; callback?.let { runCatching { scanner?.stopScan(it) } }; seen.clear()
      report(ticket,"Bluetooth disabled")
     }
     BluetoothAdapter.STATE_ON -> { bleScanning=false; report(ticket,"Bluetooth enabled · tap Nearby via Bluetooth to scan") }
    }
   }
  }
  val filter=IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
  // Bluetooth broadcasts originate from a privileged system component; the action is protected.
  if(Build.VERSION.SDK_INT>=33) context.registerReceiver(receiver,filter,Context.RECEIVER_EXPORTED) else context.registerReceiver(receiver,filter)
  radioReceiver=receiver
  val adapter=context.getSystemService(BluetoothManager::class.java)?.adapter; scanner=adapter?.bluetoothLeScanner; val message=discoveryPermission(true,adapter?.isEnabled==true,scanner!=null); report(ticket,message); if(message=="Scanning") { bleScanning=true; scanner?.startScan(listOf(ScanFilter.Builder().setManufacturerData(0xffff,BLE_PREFIX).build()),ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),current) } } catch(e:SecurityException) { bleScanning=false; report(ticket,"Bluetooth permission denied") } }
 fun stop() { fence.invalidate(); bleScanning=false; radioReceiver?.let { runCatching { context.unregisterReceiver(it) } }; radioReceiver=null; main.removeCallbacksAndMessages(null); listener?.let { runCatching { nsd.stopServiceDiscovery(it) } }; listener=null; callback?.let { runCatching { scanner?.stopScan(it) } }; callback=null; scanner=null; seen.clear(); services.clear() }
 fun close() { stop(); fence.close() }
}


