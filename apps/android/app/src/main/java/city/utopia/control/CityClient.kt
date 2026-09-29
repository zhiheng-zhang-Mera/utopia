package city.utopia.control

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class CityState(val connection: String = "OFFLINE", val snapshot: JSONObject? = null, val message: String = "Choose Scan QR, Nearby Cities (LAN), Nearby via Bluetooth, or Manual connection.")

class CityClient(context: Context, private val host: String, private val token: String, private val log: PilotLog, private val expectedCity: String?, private val changed: (CityState) -> Unit) {
 private val handler = Handler(Looper.getMainLooper())
 private val executor = Executors.newSingleThreadScheduledExecutor()
 private val http = OkHttpClient.Builder().connectTimeout(3, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).callTimeout(6, TimeUnit.SECONDS).pingInterval(3, TimeUnit.SECONDS).build()
 private val connectivity = context.getSystemService(ConnectivityManager::class.java)
 @Volatile private var closed = false
 @Volatile private var socket: WebSocket? = null
 @Volatile private var socketOnline = false
 private var snapshot: JSONObject? = null
 private var snapshotLogged = false
 private var lastPublishedConnection = ""
 private fun publish(connection: String, message: String = "") { val value = CityState(connection, snapshot, message); handler.post { if (!closed) { if (connection != lastPublishedConnection) { android.util.Log.i("UtopiaConnection", connection); log.event("connection_" + connection); if(connection == "ONLINE") log.event("websocketOnline"); lastPublishedConnection = connection }; changed(value) } } }
 private fun request(path: String, body: JSONObject? = null): JSONObject {
  val builder = Request.Builder().url(host.trimEnd('/') + "/api/v0/" + path).header("Authorization", "Bearer $token").header("X-City-Api-Version", "0").header("X-City-Schema-Version", "0")
  if (body != null) builder.post(body.toString().toRequestBody("application/json".toMediaType()))
  http.newCall(builder.build()).execute().use { response ->
   val data = JSONObject(response.body?.string() ?: "{}")
   if (!response.isSuccessful) error(data.optString("error", "Connection failed: ${response.code}"))
   check(compatible(data.optInt("apiVersion", -1), data.optInt("schemaVersion", -1))) { "Protocol mismatch: version 0 required" }
   return data
  }
 }
 private fun submit(action: () -> Unit) { if (!closed) runCatching { executor.execute { if (!closed) action() } } }
 private fun refresh() {
  if (closed || host.isBlank() || token.isBlank()) return
  try {
   if (!socketOnline) publish("RECONNECTING", "Fetching the latest city snapshot…")
   val fresh = request("city")
   check(expectedCity == null || fresh.optString("cityId") == expectedCity) { "City identity conflict; clear pairing and verify host" }
   snapshot = fresh
   if(!snapshotLogged) { log.event("authenticated"); log.event("snapshotLoaded"); snapshotLogged=true }
   if (socket == null) openStream()
   publish(if (socketOnline) "ONLINE" else "RECONNECTING")
  } catch (e: Exception) { socketOnline = false; socket?.cancel(); socket = null; publish("OFFLINE", e.message ?: "Gateway unavailable") }
 }
 private fun openStream() {
  val url = host.trimEnd('/').replaceFirst("http", "ws") + "/api/v0/events/stream?apiVersion=0&schemaVersion=0"
  socket = http.newWebSocket(Request.Builder().url(url).header("Authorization", "Bearer $token").build(), object : WebSocketListener() {
   override fun onOpen(webSocket: WebSocket, response: Response) { if (closed) { webSocket.cancel(); return }; socketOnline = true; submit { refresh() } }
   override fun onMessage(webSocket: WebSocket, text: String) { if (webSocket === socket) submit { refresh() } }
   override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (webSocket === socket) { socketOnline = false; socket = null; publish("OFFLINE", "Connection interrupted. Retrying…") } }
   override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (webSocket === socket) { socketOnline = false; socket = null; publish("OFFLINE", "Connection closed. Retrying…") } }
  })
 }
 private val callback = object : ConnectivityManager.NetworkCallback() {
  override fun onLost(network: Network) { socketOnline = false; socket?.cancel(); socket = null; publish("OFFLINE", "Network lost. Showing cached data.") }
  override fun onAvailable(network: Network) { submit { refresh() } }
 }
 fun start() { connectivity.registerDefaultNetworkCallback(callback); executor.scheduleWithFixedDelay({ refresh() }, 0, 2, TimeUnit.SECONDS) }
 fun createTask(done: (String) -> Unit) { submit { try { val task = request("tasks", JSONObject().put("type", "CHECKPOINT_DEMO")); handler.post { if (!closed) done(task.getString("id")) }; refresh() } catch (e: Exception) { publish(if (socketOnline) "ONLINE" else "OFFLINE", e.message ?: "Task creation failed") } } }
 fun cancel(id: String) { submit { try { request("tasks/$id/cancel", JSONObject()); refresh() } catch (e: Exception) { publish(if (socketOnline) "ONLINE" else "OFFLINE", e.message ?: "Cancel failed") } } }
 fun close() { closed = true; runCatching { connectivity.unregisterNetworkCallback(callback) }; socket?.cancel(); executor.shutdownNow(); http.dispatcher.cancelAll(); http.connectionPool.evictAll() }
}
