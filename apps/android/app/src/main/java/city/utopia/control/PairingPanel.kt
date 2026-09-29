package city.utopia.control
import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.delay

@Composable fun PairingPanel(log:PilotLog, incoming:String?, manual:()->Unit, paired:(String,String,String)->Unit) {
 val context=LocalContext.current
 var mode by remember { mutableStateOf("") }; var message by remember { mutableStateOf("LAN DEVELOPMENT ONLY · NOT FOR PUBLIC INTERNET") }
 var cities by remember { mutableStateOf<Map<String,PairDescriptor>>(emptyMap()) }; val seen=remember { mutableMapOf<String,Long>() }; val identities=remember { mutableMapOf<String,PairDescriptor>() }
 var chosen by remember { mutableStateOf<PairDescriptor?>(null) }; var code by remember { mutableStateOf("") }; var phase by remember { mutableStateOf("UNPAIRED") }; val busy = phase == "PAIRING"
 val api=remember { PairingApi(log) }; val discoveryFence=remember { CallbackFence() }
 fun exchange(d:PairDescriptor,m:String) { phase=pairingTransition(phase,"submit"); api.pair(d,m,code) { result -> phase=pairingTransition(phase,if(result.isSuccess) "authenticated" else "error"); result.onSuccess { (host,token) -> paired(host,token,d.cityId) }.onFailure { message=it.message?:"Pairing failed"; log.event("retry") } } }
 val discovery=remember { CityDiscovery(context,{ origin,expected ->
  val ticket=discoveryFence.ticket(); val sighted=System.currentTimeMillis()
  if(ticket!=null) api.discover(origin,expected) { result -> if(discoveryFence.accepts(ticket)) {
   result.onSuccess { d -> runCatching { mergeCity(identities,d); identities[d.cityId]=d; mergeCity(cities,d) }.onSuccess { cities=it; seen[d.cityId]=sighted }.onFailure { message=it.message?:"Identity conflict" } }.onFailure { message="City unreachable or descriptor rejected" }
  } }
 },{message=it},{city -> discoveryFence.invalidate(); cities=cities-city; seen.remove(city)}) }
 fun qr(value:String) { mode="qr"; runCatching { parseQr(value).also { mergeCity(identities,it) } }.onSuccess { log.event("discovery"); exchange(it,"qr") }.onFailure { message="Invalid or expired pairing QR"; log.event("descriptorError") } }
 val scan=rememberLauncherForActivityResult(ScanContract()) { result -> result.contents?.let { qr(it) } ?: run { message="Scan cancelled" } }
 val permission=rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results -> if(results.values.all { it }) discovery.ble() else { message="Nearby devices permission denied. Manual connection remains available."; log.event("permissionDenied") } }
 DisposableEffect(Unit) { val lifecycle=(context as androidx.lifecycle.LifecycleOwner).lifecycle; val observer=androidx.lifecycle.LifecycleEventObserver { _,event -> if(event==androidx.lifecycle.Lifecycle.Event.ON_STOP) { discoveryFence.invalidate(); discovery.stop(); cities=emptyMap(); message="Discovery paused while app is in the background" }; if(event==androidx.lifecycle.Lifecycle.Event.ON_START) { if(mode=="mdns") discovery.lan() else if(mode=="ble") discovery.ble() } }; lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer); discoveryFence.close(); discovery.close(); api.close() } }
 LaunchedEffect(incoming) { if(incoming!=null) { log.start("qr"); qr(incoming) } }
 LaunchedEffect(mode) { while(true) { delay(3000); val now=System.currentTimeMillis()
  if(mode=="ble") cities=cities.filter { discoveryFresh(seen[it.key],now) }
  if(mode=="mdns") { val ticket=discoveryFence.ticket(); if(ticket!=null) cities.values.toList().forEach { d -> api.discover(d.endpoint,d.cityId) { result -> if(discoveryFence.accepts(ticket)) { if(result.isSuccess && cities.containsKey(d.cityId)) cities=cities+(d.cityId to result.getOrThrow()) else { cities=cities-d.cityId; message="City unavailable · retry discovery" } } } } }
 } }
 Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
  Text("Find your City / 找到你的城市",style=MaterialTheme.typography.headlineMedium)
  Text(message)
  Button(onClick={ discoveryFence.invalidate(); discovery.stop(); mode="qr"; chosen=null; log.start("qr"); log.event("action"); scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the City pairing QR").setBeepEnabled(false).setOrientationLocked(false)) },enabled=!busy,modifier=Modifier.fillMaxWidth()) { Text("Scan QR") }
  OutlinedButton(onClick={ discoveryFence.invalidate(); mode="mdns"; chosen=null; log.start(mode); log.event("action"); cities=emptyMap(); discovery.lan() },enabled=!busy,modifier=Modifier.fillMaxWidth()) { Text("Nearby Cities (LAN)") }
  OutlinedButton(onClick={ discoveryFence.invalidate(); mode="ble"; chosen=null; log.start(mode); log.event("action"); cities=emptyMap(); permission.launch(if(Build.VERSION.SDK_INT>=31) arrayOf(Manifest.permission.BLUETOOTH_SCAN,Manifest.permission.BLUETOOTH_CONNECT) else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)) },enabled=!busy,modifier=Modifier.fillMaxWidth()) { Text("Nearby via Bluetooth") }
  OutlinedButton(onClick={ discovery.stop(); log.start("manual"); manual() },enabled=!busy,modifier=Modifier.fillMaxWidth()) { Text("Manual connection") }
  cities.values.forEach { d -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) { Text(d.displayName); Text(d.endpoint); Text(d.cityId,style=MaterialTheme.typography.labelSmall); Button(onClick={ chosen=d; code=""; log.event("action") },enabled=!busy) { Text("Pair") } } } }
  if(chosen!=null) { Text("Create a pairing session on the City host, then enter its short code. Connect refreshes the current session."); OutlinedTextField(code,{code=it},label={Text("Short pairing code")},visualTransformation=PasswordVisualTransformation(),singleLine=true); Button(onClick={ exchange(chosen!!,mode) },enabled=!busy && code.isNotBlank()) { Text(if(busy) "Pairing…" else "Connect") } }
 }
}
