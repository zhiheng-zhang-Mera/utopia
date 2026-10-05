package city.utopia.control
import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.delay

@Composable fun PairingPanel(log:PilotLog, incoming:String?, host:String, credential:String, manual:()->Unit, paired:(String,String,String,PairDescriptor)->Unit) {
 val context=LocalContext.current
 var mode by remember { mutableStateOf("") }; var message by remember { mutableStateOf("LAN DEVELOPMENT ONLY · NOT FOR PUBLIC INTERNET") }
 var pairingError by remember { mutableStateOf<String?>(null) }
 var cities by remember { mutableStateOf<Map<String,PairDescriptor>>(emptyMap()) }; val seen=remember { mutableMapOf<String,Long>() }; val identities=remember { mutableMapOf<String,PairDescriptor>() }
 var chosen by remember { mutableStateOf<PairDescriptor?>(null) }; var code by remember { mutableStateOf("") }; var phase by remember { mutableStateOf("UNPAIRED") }; val busy = phase == "PAIRING"
 // SHORT-CODE is its own mode, not a step that requires choosing a City first (it is the fifth button in the
 // row below). It still pairs through the one canonical path: the City descriptor is resolved from the address
 // this installation already knows, then the exchange is the same `pairing/exchange` call every other mode uses.
 var ownerCode by remember { mutableStateOf("") }; var ownerSession by remember { mutableStateOf<PairDescriptor?>(null) }
 val api=remember { PairingApi(log) }; val discoveryFence=remember { CallbackFence() }
 // Defined AFTER `api`/`identities` exist: a local function may only capture declarations that are already in
 // scope at its own position, and the first version of this fix was placed above them (compile error, recorded).
 fun resolveOwnerTarget(onReady:(PairDescriptor)->Unit) {
  val known=runCatching { endpoint(host) }.getOrNull()?.takeIf { it.isNotBlank() }
  if(known==null) { pairingError="Set the City address first (Settings)"; return }
  val direct=chosen ?: cities.values.firstOrNull { it.endpoint==known }
  if(direct!=null) { onReady(direct); return }
  api.descriptor(known) { result -> result.onSuccess { d -> runCatching { identities[d.cityId]=d; onReady(d) }.onFailure { pairingError=it.message?:"City identity conflict" } }.onFailure { pairingError=it.message?:"City unreachable" } }
 }
 fun generateOwnerCode() { pairingError=null; ownerCode=""; if(credential.isBlank()) { pairingError="No owner credential on this device · sign in with a token first (TOKEN)"; return }; resolveOwnerTarget { d -> api.session(d,credential) { result -> result.onSuccess { ownerSession=it }.onFailure { pairingError=it.message?:"Could not create a pairing session" } } } }
 fun exchange(d:PairDescriptor,m:String) { pairingError=null; phase=pairingTransition(phase,"submit"); api.pair(d,m,code) { result -> phase=pairingTransition(phase,if(result.isSuccess) "authenticated" else "error"); result.onSuccess { (h,t) -> paired(h,t,d.cityId,d) }.onFailure { pairingError=it.message?:"Pairing failed"; log.event("retry") } } }
 val discovery=remember { CityDiscovery(context,{ origin,expected ->
  val ticket=discoveryFence.ticket(); val sighted=System.currentTimeMillis()
  if(ticket!=null) api.discover(origin,expected) { result -> if(discoveryFence.accepts(ticket)) {
   result.onSuccess { d -> runCatching { mergeCity(identities,d); identities[d.cityId]=d; mergeCity(cities,d) }.onSuccess { cities=it; seen[d.cityId]=sighted }.onFailure { message=it.message?:"Identity conflict" } }.onFailure { message="City unreachable or descriptor rejected" }
  } }
 },{message=it; if(mode=="ble" && it=="Bluetooth disabled") { discoveryFence.invalidate(); cities=emptyMap(); seen.clear() }},{city -> discoveryFence.invalidate(); cities=cities-city; seen.remove(city)}) }
 fun qr(value:String) { mode="qr"; runCatching { parseQr(value).also { mergeCity(identities,it) } }.onSuccess { log.event("discovery"); exchange(it,"qr") }.onFailure { pairingError="Invalid or expired pairing QR"; log.event("descriptorError") } }
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
  pairingError?.let { Text(it, color=MaterialTheme.colorScheme.error) }
  // FIVE SHORT ACTIONS IN ONE ROW. The two entry methods that need text input (short code, manual token) are
  // reached by tapping their button, which reveals the input inline BELOW the row - so the primary actions stay
  // in one line while the inputs remain reachable without hunting for content laid out past the fold.
  val compact=ButtonDefaults.buttonColors(containerColor=MaterialTheme.colorScheme.surfaceVariant,contentColor=MaterialTheme.colorScheme.onSurfaceVariant)
  val compactText=MaterialTheme.typography.labelSmall
  val pickRow=rememberScrollState()
  @Composable fun ActionButton(label:String,primary:Boolean=false,enabled:Boolean,onClick:()->Unit) {
   if(primary) Button(onClick=onClick,enabled=enabled,shape=RoundedCornerShape(10.dp),contentPadding=PaddingValues(horizontal=2.dp,vertical=0.dp),modifier=Modifier.weight(1f).height(36.dp)) { Text(label,style=compactText,maxLines=1) }
   else OutlinedButton(onClick=onClick,enabled=enabled,colors=compact,shape=RoundedCornerShape(10.dp),contentPadding=PaddingValues(horizontal=2.dp,vertical=0.dp),modifier=Modifier.weight(1f).height(36.dp)) { Text(label,style=compactText,maxLines=1) }
  }
  Row(Modifier.fillMaxWidth().horizontalScroll(pickRow),horizontalArrangement=Arrangement.spacedBy(4.dp)) {
   ActionButton("QR",primary=true,enabled=!busy) { pairingError=null; discoveryFence.invalidate(); discovery.stop(); mode="qr"; cities=emptyMap(); chosen=null; log.start("qr"); log.event("action"); scan.launch(ScanOptions().setCaptureActivity(AutoZoomCaptureActivity::class.java).setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Keep the whole QR in view · Auto zoom 1–2×").setBeepEnabled(false).setOrientationLocked(false)) }
   ActionButton("LAN",enabled=!busy) { pairingError=null; discoveryFence.invalidate(); mode="mdns"; chosen=null; log.start(mode); log.event("action"); cities=emptyMap(); discovery.lan() }
   ActionButton("BLE",enabled=!busy) { pairingError=null; discoveryFence.invalidate(); discovery.stop(); mode="ble"; chosen=null; log.start(mode); log.event("action"); cities=emptyMap(); permission.launch(if(Build.VERSION.SDK_INT>=31) arrayOf(Manifest.permission.BLUETOOTH_SCAN,Manifest.permission.BLUETOOTH_CONNECT) else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)) }
   ActionButton("CODE",enabled=!busy) { pairingError=null; discovery.stop(); log.start("owner-code"); log.event("action"); generateOwnerCode() }
   ActionButton("TOKEN",enabled=!busy) { pairingError=null; discovery.stop(); log.start("manual"); manual() }
  }
  when(mode) {
   "qr" -> Text("Point the camera at the City's temporary pairing QR.")
   "mdns" -> Text("Pick a City found on this LAN.")
   "ble" -> Text("Bluetooth bootstrap: pick a City once it appears.")
   "owner-code" -> Text("Short-code join · connect to the City address in Settings using a one-time code.")
   "manual" -> Text("Manual connection: City URL and pairing token.")
   else -> Text("LAN DEVELOPMENT ONLY · NOT FOR PUBLIC INTERNET")
  }
  if(mode=="owner-code") {
   if(ownerSession==null) Text("Tap CODE to create a session on the City host (Settings address).")
   else { OutlinedTextField(ownerCode,{ownerCode=it},label={Text("Short pairing code")},visualTransformation=PasswordVisualTransformation(),singleLine=true,keyboardOptions=KeyboardOptions(imeAction=ImeAction.Done),keyboardActions=KeyboardActions(onDone={ val d=ownerSession; if(!busy && ownerCode.isNotBlank() && d!=null) exchange(d,"owner-code") }),modifier=Modifier.fillMaxWidth())
    Button(onClick={ val d=ownerSession; if(ownerCode.isNotBlank() && d!=null) exchange(d,"owner-code") },enabled=!busy && ownerCode.isNotBlank()) { Text(if(busy) "Pairing…" else "Connect with short code") } }
  }
  cities.values.forEach { d -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) { Text(d.displayName); Text(d.endpoint); Text(d.cityId,style=MaterialTheme.typography.labelSmall); Button(onClick={ pairingError=null; chosen=d; code=""; log.event("action") },enabled=!busy) { Text("Pair") } } } }
  if(chosen!=null) { Text("Create a pairing session on the City host, then enter its short code. Connect refreshes the current session."); OutlinedTextField(code,{code=it},label={Text("Short pairing code")},visualTransformation=PasswordVisualTransformation(),singleLine=true); Button(onClick={ exchange(chosen!!,mode) },enabled=!busy && code.isNotBlank()) { Text(if(busy) "Pairing…" else "Connect") } }
 }
}


