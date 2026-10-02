package city.utopia.control

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import city.utopia.control.theme.Space
import city.utopia.control.theme.UtopiaColors
import city.utopia.control.theme.UtopiaIcons
import city.utopia.control.theme.UtopiaTheme
import city.utopia.control.ui.MeasuredStatusChip
import city.utopia.control.ui.TechnicalDetails
import city.utopia.control.ui.UtFeedback
import city.utopia.control.ui.UtLabel
import city.utopia.control.ui.UtopiaNavigationBar
import org.json.JSONArray
import org.json.JSONObject

/* UI-102: the old brand pair is remapped onto the adopted direction so the screens
   that already referenced Ink/Moss move with the theme instead of needing edits.
   Ink is now the body ink, Moss the lime signal. */
private val Ink = UtopiaColors.Ink
private val Moss = UtopiaColors.Lime
private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }

class MainActivity : ComponentActivity() {
 override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); setContent { UtopiaTheme { CityApp() } } }
 @Composable private fun CityApp() {
  val log = remember { PilotLog(this@MainActivity) }
  var now by remember { mutableStateOf(java.time.Instant.now()) }
  LaunchedEffect(Unit) { while(true) { kotlinx.coroutines.delay(1000); now=java.time.Instant.now() } }
  val prefs = remember { getSharedPreferences("city-connection", MODE_PRIVATE) }
  var host by remember { mutableStateOf(prefs.getString("host", "http://") ?: "") }
  var token by remember { mutableStateOf(prefs.getString("token", "") ?: "") }
  var settingsRevision by remember { mutableIntStateOf(0) }
  var state by remember { mutableStateOf(CityState()) }
  var page by remember { mutableStateOf(if (token.isBlank() || intent?.data != null) "Find" else "Devices") }
  var selectedNode by remember { mutableStateOf<String?>(null) }
  var selected by remember { mutableStateOf<String?>(null) }
  var client by remember { mutableStateOf<CityClient?>(null) }
  var creating by remember { mutableStateOf(false) }
  DisposableEffect(settingsRevision) {
   val c = CityClient(this@MainActivity, host, token, log, prefs.getString("cityId", null)) { state = it; creating = false }
   client = c; c.start(); onDispose { c.close() }
  }
  val online = state.connection == "ONLINE"
  val tasks = state.snapshot?.optJSONArray("tasks").objects()
  val nodes = state.snapshot?.optJSONArray("nodes").objects()
  val events = state.snapshot?.optJSONArray("events").objects()
  /* UI-102: five phone-sized primary entries instead of nine, and real tintable
     vector icons instead of Unicode geometry drawn as text. Everything that is not a
     primary surface is reachable from the header overflow, so no capability is lost
     while the bar stops being a wall of tabs. */
  val primaryNav = listOf(
   "Home" to UtopiaIcons.Home,
   "Ask" to UtopiaIcons.Ask,
   "Rooms" to UtopiaIcons.Tools,
   "Devices" to UtopiaIcons.Devices,
   "Activity" to UtopiaIcons.Activity,
  )
  val advancedNav = listOf(
   "Services" to "能力服务",
   "Tasks" to "任务",
   "Action" to "操作记录",
   "Settings" to "设置",
   "Find" to "配对",
  )
  val advancedOpen = remember { mutableStateOf(false) }
  Scaffold(containerColor = MaterialTheme.colorScheme.background, bottomBar = {
   /* UI-102 narrow-width fix: this was `NavigationBar { NavigationBarItem(label = { Text(name,
      maxLines = 1) }) }`, which at 320dp / font_scale 1.5 clipped every label to its first two
      characters (`Ho`, `As`, `Ro`, `De`, `Ac`) — `maxLines` without an `overflow` is `Clip`, and
      there is no width at which that becomes readable. UtopiaNavigationBar measures each label
      against the slot it really has, steps the size down while it fits, and degrades to an
      icon-only entry named by `contentDescription` only when nothing legible fits. */
   UtopiaNavigationBar(primaryNav, page, onSelect = { page = it; selected = null; selectedNode = null })
  }) { padding ->
   LazyColumn(Modifier.fillMaxSize().padding(padding).imePadding().padding(horizontal = 18.dp), verticalArrangement = Arrangement.spacedBy(Space.md), contentPadding = PaddingValues(top = Space.lg, bottom = Space.xl)) {
    item { Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) { Text("UTOPIA", color = MaterialTheme.colorScheme.onBackground, fontWeight = FontWeight.Bold, letterSpacing = 3.sp); Spacer(Modifier.width(Space.md)); MeasuredStatusChip(state.connection); Spacer(Modifier.width(Space.xs)); Box { IconButton(onClick = { advancedOpen.value = true }) { Icon(UtopiaIcons.More, contentDescription = "更多", tint = MaterialTheme.colorScheme.onSurfaceVariant) }; DropdownMenu(expanded = advancedOpen.value, onDismissRequest = { advancedOpen.value = false }) { advancedNav.forEach { (target, label) -> DropdownMenuItem(text = { Text(label) }, onClick = { page = target; selected = null; selectedNode = null; advancedOpen.value = false }) } } } } }
    item { Column { Text(if (selected != null) "Task details" else when (page) { "Home" -> "Digital City"; "Find" -> "Welcome"; "Ask" -> "Ask / Do"; "Rooms" -> "Rooms · local tools"; "Action" -> "Actions"; "Devices" -> if(selectedNode == null) "Devices" else "Device details"; "Services" -> "City services"; "Tasks" -> "Your tasks"; "Activity" -> "City activity"; else -> "Connect your city" }, fontSize = 32.sp, color = Ink, fontWeight = FontWeight.Medium); Text(if (online) "Your devices. One shared view." else "Cached information · connection is not live", fontSize = 12.sp, color = Color.Gray) } }
    if (state.message.isNotBlank()) item { UtFeedback(state.message, kind = "error") }
    if (page == "Find") {
     item { PairingPanel(log, intent?.dataString, { page="Settings" }, { h,t,id -> host=h; token=t; prefs.edit().putString("host",h).putString("token",t).putString("cityId",id).apply(); state=CityState("RECONNECTING"); settingsRevision++; page="Devices"; intent.data=null }) }
    } else if (page == "Devices") {
     // UXI-301: show WHY things are waiting ahead of the device list, on the overview only - a single
     // device's detail view is about that device, and repeating the fleet-wide panel there would bury it.
     // UXI-390: the surface now WIRES its actions instead of omitting the handler. supportedActions names
     // the ones this surface actually implements, and the panel renders anything else DISABLED rather than
     // inert - the honesty rule. CHOOSE_PROVIDER sends the service the panel resolved from the feed, to the
     // same backend route the web surface already uses.
     if(selectedNode==null) item {
       SchedulerStatusPanel(
         state.feed, online,
         supportedActions = setOf("CANCEL"),
         onChooseProvider = { taskId, providerRef -> client?.providerChoice(taskId, providerRef) },
         onAction = { taskId, token, providerRef ->
           when (token) {
             "CANCEL" -> client?.cancel(taskId)
           }
         },
       )
     }
     if(nodes.isEmpty()) item { Text("Waiting for devices") }
     nodes.filter { selectedNode == null || it.optString("id")==selectedNode }.forEach { n -> item { DeviceCard(n,online,now,selectedNode!=null,tasks,events) { selectedNode=n.optString("id") } } }
     if(selectedNode!=null) item { OutlinedButton(onClick={selectedNode=null}) { Text("All devices") } }
    } else if (page == "Services") {
     item { ServicesPanel(state,client) }
    } else if (page == "Rooms") {
     item { RoomsPanel(state,client) }
    } else if (page == "Ask") {
     item { AskPanel(state,client) }
    } else if (page == "Action") {
     item { ActionsPanel(state,client) }
    } else if (page == "Settings") {
     item { OutlinedButton(onClick={ client?.close(); prefs.edit().clear().apply(); token=""; host="http://"; state=CityState(); settingsRevision++; page="Find"; log.event("clearPairing") }) { Text("Clear pairing / Find your City") } }
     item { OutlinedTextField(host, { host = it }, label = { Text("City URL") }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
     item { OutlinedTextField(token, { token = it }, label = { Text("Pairing token") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth()) }
     item { Button(onClick = { val valid = runCatching { val u = java.net.URI(host.trim()); u.scheme in listOf("http", "https") && u.host != null && u.userInfo == null && u.query == null && (u.path.isNullOrBlank() || u.path == "/") }.getOrDefault(false); if (valid && token.isNotBlank()) { host = host.trim().trimEnd('/'); token = token.trim(); log.event("action"); log.event("discovery"); log.event("pairingSubmitted"); prefs.edit().remove("cityId").putString("host", host).putString("token", token).apply(); state = CityState("RECONNECTING"); settingsRevision++; page = "Devices" } else { state = state.copy(message = "Enter a valid HTTP city URL and pairing token.") } }, modifier = Modifier.fillMaxWidth()) { Text("Save and connect") } }
     item { Panel { Text("Connection diagnostics", fontWeight = FontWeight.Bold); Text("apiVersion = 0 · schemaVersion = 0"); Text("Credentials stay in app-private storage. LAN development only.", fontSize = 12.sp) } }
    } else if (selected != null) {
     val t = tasks.find { it.optString("id") == selected }
     if (t != null) {
      item { Panel { Text(t.optString("type"), fontWeight = FontWeight.Bold); Text(t.optString("id"), fontSize = 11.sp); Text(t.optString("state"), color = Ink); LinearProgressIndicator(progress = { t.optInt("progress") / 100f }, modifier = Modifier.fillMaxWidth()); Text("Node: " + t.optString("assignedNodeId"), fontSize = 12.sp); Text("Checkpoint", fontWeight = FontWeight.Bold); Text(t.opt("lastCheckpoint").toString(), fontSize = 12.sp); Text("Result", fontWeight = FontWeight.Bold); Text(t.opt("result").toString(), fontSize = 12.sp); if (!t.isNull("error")) Text(t.optString("error")); if (canCancel(t.optString("state"))) OutlinedButton(onClick = { client?.cancel(t.getString("id")) }, enabled = online) { Text("Cancel task") } } }
      events.filter { it.optString("taskId") == selected }.forEach { e -> item { EventRow(e) } }
     }
    } else {
     if (page == "Home") {
      item { Panel { Text("RUNTIME NODES", fontSize = 11.sp, color = Color.Gray); if (nodes.isEmpty()) Text("Waiting for a runtime node"); nodes.forEach { n -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(n.optString("displayName"), fontWeight = FontWeight.Bold); Text(if (!online) "UNKNOWN" else if (n.optBoolean("online")) "ONLINE" else "OFFLINE", fontSize = 12.sp) } } } }
      item { Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { Metric("Running", tasks.count { canCancel(it.optString("state")) }, Modifier.weight(1f)); Metric("Completed", tasks.count { it.optString("state") == "COMPLETED" }, Modifier.weight(1f)) } }
     }
     if (page in listOf("Home", "Tasks")) {
      item { Button(onClick = { creating = true; client?.createTask { selected = it; page = "Tasks"; creating = false } }, enabled = online && !creating, colors = ButtonDefaults.buttonColors(containerColor = Moss, contentColor = Ink), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().height(54.dp)) { Text(if (creating) "Creating…" else "Run Test Task", fontWeight = FontWeight.Bold) } }
      item { Text(if (page == "Home") "RECENT TASKS" else "TASK REGISTRY", fontSize = 11.sp, letterSpacing = 2.sp, color = Color.Gray) }
      val visible = if (page == "Home") tasks.takeLast(3) else tasks
      if (visible.isEmpty()) item { Text("No tasks yet. Start with a safe test task.", color = Color.Gray) }
      visible.reversed().forEach { t -> item { Panel(Modifier.clickable { selected = t.getString("id"); page = "Tasks" }) { Text(t.optString("type"), fontWeight = FontWeight.Bold); Text(t.optString("state"), color = Ink, fontSize = 12.sp); Text(t.optString("id"), fontSize = 10.sp, color = Color.Gray) } } }
     }
     if (page == "Activity") events.reversed().forEach { e -> item { EventRow(e) } }
    }
    if (state.snapshot != null && page != "Settings") item { Text("Last snapshot: " + clockLabel(state.snapshot?.optString("updatedAt")), color = Color.Gray, fontSize = 10.sp) }
   }
  }
 }
}
/* UI-102: this used to be `.background(Color.White, RoundedCornerShape(16.dp))`. After
   increment 1 changed the theme it was painting white 16dp-rounded cards on a dark HUD -
   a defect increment 1 introduced and did not propagate. It now uses the theme surface,
   the direction's cut corners and the spacing scale, which fixes every call site at once. */
@Composable fun Panel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
 Column(
  modifier.fillMaxWidth().clip(MaterialTheme.shapes.large).background(MaterialTheme.colorScheme.surface).padding(Space.lg),
  verticalArrangement = Arrangement.spacedBy(Space.sm),
  content = content,
 )
}
@Composable private fun Metric(label: String, count: Int, modifier: Modifier) {
 Panel(modifier) {
  UtLabel(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
  Text(count.toString(), style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.primary)
 }
}
/* The event's ordering number and task id are internal identifiers: folded, not deleted.
   The surface keeps what happened and when. */
@Composable private fun EventRow(e: JSONObject) {
 Panel {
  Text(e.optString("type"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
  Text(clockLabel(e.optString("timestamp")), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
  TechnicalDetails(listOf(
   "seq" to e.optInt("seq").toString(),
   "taskId" to e.optString("taskId"),
  ))
 }
}
