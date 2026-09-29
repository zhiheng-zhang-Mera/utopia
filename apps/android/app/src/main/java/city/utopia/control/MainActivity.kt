package city.utopia.control

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONArray
import org.json.JSONObject

private val Ink = Color(0xFF19382F)
private val Moss = Color(0xFFC8EEA1)
private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }

class MainActivity : ComponentActivity() {
 override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); setContent { MaterialTheme(colorScheme = lightColorScheme(primary = Ink, secondary = Moss, background = Color(0xFFF4F6F0))) { CityApp() } } }
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
  Scaffold(containerColor = Color(0xFFF4F6F0), bottomBar = {
   NavigationBar(containerColor = Color.White) { listOf("Home" to "◈", "Devices" to "◇", "Services" to "◉", "Tasks" to "▤", "Activity" to "≋", "Settings" to "⚙").forEach { (name, icon) -> NavigationBarItem(selected = page == name, onClick = { page = name; selected = null; selectedNode = null }, icon = { Text(icon, fontSize = 22.sp) }, label = { Text(name) }) } }
  }) { padding ->
   LazyColumn(Modifier.fillMaxSize().padding(padding).imePadding().padding(horizontal = 22.dp), verticalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(top = 22.dp, bottom = 28.dp)) {
    item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("UTOPIA", color = Ink, fontWeight = FontWeight.Bold, letterSpacing = 3.sp); Text(state.connection, color = if (online) Color(0xFF456B29) else Color(0xFFA15C38), fontSize = 12.sp) } }
    item { Column { Text(if (selected != null) "Task details" else when (page) { "Home" -> "Digital City"; "Find" -> "Welcome"; "Devices" -> if(selectedNode == null) "Devices" else "Device details"; "Services" -> "City services"; "Tasks" -> "Your tasks"; "Activity" -> "City activity"; else -> "Connect your city" }, fontSize = 32.sp, color = Ink, fontWeight = FontWeight.Medium); Text(if (online) "Your devices. One shared view." else "Cached information · connection is not live", fontSize = 12.sp, color = Color.Gray) } }
    if (state.message.isNotBlank()) item { Text(state.message, color = Color(0xFFA15C38), fontSize = 12.sp) }
    if (page == "Find") {
     item { PairingPanel(log, intent?.dataString, { page="Settings" }, { h,t,id -> host=h; token=t; prefs.edit().putString("host",h).putString("token",t).putString("cityId",id).apply(); state=CityState("RECONNECTING"); settingsRevision++; page="Devices"; intent.data=null }) }
    } else if (page == "Devices") {
     if(nodes.isEmpty()) item { Text("Waiting for devices") }
     nodes.filter { selectedNode == null || it.optString("id")==selectedNode }.forEach { n -> item { DeviceCard(n,online,now,selectedNode!=null,tasks,events) { selectedNode=n.optString("id") } } }
     if(selectedNode!=null) item { OutlinedButton(onClick={selectedNode=null}) { Text("All devices") } }
    } else if (page == "Services") {
     item { ServicesPanel(state,client) }
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
    if (state.snapshot != null && page != "Settings") item { Text("Last snapshot: " + state.snapshot?.optString("updatedAt"), color = Color.Gray, fontSize = 10.sp) }
   }
  }
 }
}
@Composable private fun Panel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) { Column(modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(16.dp)).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content) }
@Composable private fun Metric(label: String, count: Int, modifier: Modifier) { Panel(modifier) { Text(label, fontSize = 12.sp, color = Color.Gray); Text(count.toString(), fontSize = 32.sp, color = Ink) } }
@Composable private fun EventRow(e: JSONObject) { Panel { Text(e.optString("type"), fontSize = 13.sp, fontWeight = FontWeight.Medium); Text("#${e.optInt("seq")} · ${e.optString("taskId")}", fontSize = 10.sp, color = Color.Gray); Text(e.optString("timestamp"), fontSize = 10.sp, color = Color.Gray) } }
