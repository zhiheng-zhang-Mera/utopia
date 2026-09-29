package city.utopia.control
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.time.Instant
private fun bytes(value:Long) = if(value<0) "Unavailable" else "%.1f GB".format(value/1073741824.0)
@Composable fun DeviceCard(node:JSONObject, online:Boolean, now:Instant, detail:Boolean=false, tasks:List<JSONObject> = emptyList(), events:List<JSONObject> = emptyList(), click:()->Unit={}) {
 val t=node.optJSONObject("telemetry"); val status=telemetryStatus(online,node.optBoolean("online"),t?.optString("observedAt"),now)
 Card(Modifier.fillMaxWidth().clickable(onClick=click)) { Column(Modifier.padding(18.dp),verticalArrangement=Arrangement.spacedBy(9.dp)) {
 Text(node.optString("displayName"),style=MaterialTheme.typography.titleLarge); Text(status)
 Text("Platform: ${node.optJSONObject("metadata")?.optString("platform","Unknown")?:"Unknown"} · Agent ${node.optString("agentVersion","Unavailable")}")
 val cpu=t?.optJSONObject("cpu"); Text("CPU: ${if(cpu==null || cpu.isNull("usagePercent")) "Unavailable" else "%.1f%%".format(cpu.optDouble("usagePercent"))}")
 val m=t?.optJSONObject("memory"); Text("Memory: ${bytes(m?.optLong("usedBytes",-1)?:-1)} / ${bytes(m?.optLong("totalBytes",-1)?:-1)}")
 Text("Last seen: ${node.optString("lastHeartbeatAt","Unavailable")}")
 if(detail) {
 Text("Identity: ${node.optString("id")}")
 val disk=t?.optJSONObject("disk"); Text("Disk: ${bytes(disk?.optLong("usedBytes",-1)?:-1)} / ${bytes(disk?.optLong("totalBytes",-1)?:-1)} · Free ${bytes(disk?.optLong("freeBytes",-1)?:-1)}")
 Text("Uptime: ${if(t==null || t.isNull("uptimeSeconds")) "Unavailable" else "${t.optLong("uptimeSeconds")} seconds"}")
 Text("Observed: ${t?.optString("observedAt")?:"Unavailable"}")
 Text("Capabilities: ${node.optJSONArray("capabilities")?:"Unavailable"}")
 Text("Current task",style=MaterialTheme.typography.titleMedium)
 val current=tasks.filter { it.optString("assignedNodeId")==node.optString("id") && canCancel(it.optString("state")) }; if(current.isEmpty()) Text("No active task"); current.forEach { Text("${it.optString("id")} · ${it.optString("state")}") }
 Text("Recent node events",style=MaterialTheme.typography.titleMedium)
 events.filter { it.optJSONObject("payload")?.optString("nodeId")==node.optString("id") || tasks.any { task -> task.optString("assignedNodeId")==node.optString("id") && task.optString("id")==it.optString("taskId") } }.takeLast(8).reversed().forEach { Text("${it.optString("type")} · ${it.optString("timestamp")}") }
 }
 } }
}
