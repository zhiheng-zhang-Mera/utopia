package city.utopia.control

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.Looper
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class CityState(val connection: String = "OFFLINE", val snapshot: JSONObject? = null, val message: String = "Choose Scan QR, Nearby Cities (LAN), Nearby via Bluetooth, or Manual connection.", val feed: JSONObject? = null)

class CityClient(context: Context, private val host: String, private val token: String, private val log: PilotLog, private val expectedCity: String?, private val changed: (CityState) -> Unit) {
 private val handler = Handler(Looper.getMainLooper())
 private val executor = Executors.newSingleThreadScheduledExecutor()
 private val http = OkHttpClient.Builder().connectTimeout(3, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).callTimeout(6, TimeUnit.SECONDS).pingInterval(3, TimeUnit.SECONDS).build()
 private val connectivity = context.getSystemService(ConnectivityManager::class.java)
 /**
  * MESH-301: this control surface declares ITSELF on the event-stream handshake, so the City records which
  * surface is attached rather than every surface having to infer it privately.
  *
  * The physical identity is generated once and PERSISTED, never derived from the label: a device keeps one
  * identity while its display name stays free to change, which is the same rule the worker nodes follow. The
  * label is `Build.MODEL`, which is what the Owner's naming rule asks an Android control client to show.
  */
 private val identityPrefs = context.getSharedPreferences("city-connection", Context.MODE_PRIVATE)
 private val clientRef: String = identityPrefs.getString("clientRef", null) ?: ("android-" + Build.MODEL.replace(Regex("[^A-Za-z0-9-]"), "-")).also { identityPrefs.edit().putString("clientRef", it).apply() }
 private val clientLabel: String = Build.MODEL.ifBlank { "android-device" }
 @Volatile private var closed = false
 @Volatile private var socket: WebSocket? = null
 @Volatile private var socketOnline = false
 private var snapshot: JSONObject? = null
 /**
  * UXI-301: the scheduler presentation feed from GET /api/v0/presentation, held beside the snapshot so
  * the Devices surface can explain WHY something is waiting using the same semantics as Web.
  *
  * It is fetched non-fatally: a gateway that does not serve the route, or a transient failure, leaves
  * this null and the surface says the status is not being reported. It must NOT fall back to deriving a
  * status from the snapshot here, because that would be the Android client recomputing scheduling truth
  * - which the workbook forbids and which is how the two surfaces would start to disagree.
  */
 @Volatile private var feed: JSONObject? = null
 private var snapshotLogged = false
 @Volatile private var pendingResync = false
 // R2 FIX. A boolean was not enough: `refresh()` also runs every 2 seconds, so a refresh that had ALREADY
 // started when the socket reopened could consume the flag and stamp the resync with a snapshot read from
 // BEFORE the reconnection (measured: resync said maxSeq 392 while 394 already existed). A generation counter
 // makes the stamp provable instead of merely likely - the snapshot is only allowed to witness a
 // re-convergence if it was fetched inside the generation that opened.
 @Volatile private var openGeneration = 0
 @Volatile private var resyncedGeneration = -1
 @Volatile private var lastObservedSeq = 0
 @Volatile private var wasDown = false
 @Volatile private var lastServerMaxSeq = 0
 private fun maxEventSeq(snapshot: JSONObject): Int { val arr = snapshot.optJSONArray("events") ?: return 0; var max = 0; for (i in 0 until arr.length()) max = maxOf(max, arr.optJSONObject(i)?.optInt("seq", 0) ?: 0); return max }
 private var lastPublishedConnection = ""
 private fun publish(connection: String, message: String = "") { val value = CityState(connection, snapshot, message, feed); handler.post { if (!closed) { if (connection != lastPublishedConnection) { android.util.Log.i("UtopiaConnection", connection); log.event("connection_" + connection); if(connection == "ONLINE") log.event("websocketOnline"); lastPublishedConnection = connection }; changed(value) } } }
 private fun request(path: String, body: JSONObject? = null): JSONObject {
  val builder = Request.Builder().url(host.trimEnd('/') + "/api/v0/" + path).header("Authorization", "Bearer $token").header("X-City-Api-Version", "0").header("X-City-Schema-Version", "0")
  if (body != null) builder.post(body.toString().toRequestBody("application/json".toMediaType()))
  (if(path.startsWith("capabilities/")) http.newBuilder().readTimeout(25, TimeUnit.SECONDS).callTimeout(26, TimeUnit.SECONDS).build() else http).newCall(builder.build()).execute().use { response ->
   val raw = response.body?.string() ?: "{}"
   if (!response.isSuccessful && (path.startsWith("capabilities/") || path.startsWith("capability-invocations/"))) {
    val error = runCatching { JSONObject(raw) }.getOrNull()
    throw CapabilityRequestException(error?.optString("errorCode")?.takeIf { it.isNotBlank() } ?: "HTTP_${response.code}",response.code,error?.optString("error")?.takeIf { it.isNotBlank() } ?: "Request failed: ${response.code}")
   }
   val data = JSONObject(raw)
   if (!response.isSuccessful) error(data.optString("error", "Connection failed: ${response.code}"))
   check(compatible(data.optInt("apiVersion", -1), data.optInt("schemaVersion", -1))) { "Protocol mismatch: version 0 required" }
   return data
  }
 }
 private fun submit(action: () -> Unit) { if (!closed) runCatching { executor.execute { if (!closed) action() } } }
 /**
  * MESH-301 — the ONE place this surface gives a socket up, so the receipt can never miss a drop.
  *
  * WHY THIS EXISTS. `refresh()`'s failure path and the network callback both did
  * `socketOnline = false; socket?.cancel(); socket = null` — they nulled the field FIRST, and the
  * `webSocket === socket` guard in `onFailure` then compared against null and discarded the callback that
  * would have recorded the drop. Measured consequence: a real run lost `seq 233` while the receipt recorded
  * NO `stale` and NO `reconnected`, i.e. the surface was silently stale. That is precisely what the workbook
  * forbids - cached or missing events presented as live consistency - and it is worse than being honestly
  * offline, because nothing downstream can tell the two apart.
  *
  * The rule this restores: a socket is either held, or it was surrendered through here and the surrender is
  * in the receipt. There is no third state.
  */
 private fun dropSocket(message: String) {
  val gone = socket
  if (gone != null) { socket = null; socketOnline = false; wasDown = true; log.surface("stale"); runCatching { gone.cancel() } }
  publish("OFFLINE", message)
 }
 private fun refresh() {
  if (closed || host.isBlank() || token.isBlank()) return
  try {
   if (!socketOnline) publish("RECONNECTING", "Fetching the latest city snapshot…")
   val generationAtFetch = openGeneration
   val fresh = request("city")
   check(expectedCity == null || fresh.optString("cityId") == expectedCity) { "City identity conflict; clear pairing and verify host" }
   snapshot = fresh
   lastServerMaxSeq = maxEventSeq(fresh)
   // MESH-301 (R2): the snapshot may witness a re-convergence ONLY if it was fetched inside the generation
   // that opened. `generationAtFetch` was captured before the request, so a refresh that began before the
   // socket reopened cannot stamp the resync with a pre-reconnection view.
   if (generationAtFetch == openGeneration && resyncedGeneration != openGeneration) {
    resyncedGeneration = openGeneration
    log.surface("resync", lastServerMaxSeq)
   }
   // UXI-301: the scheduler feed is fetched NON-FATALLY. A gateway without the route leaves this null
   // and the surface reports "not being reported" rather than inventing a status. The failure mode this
   // must never have is presenting a healthy surface because the fetch silently failed.
   feed = runCatching { request("presentation") }.getOrNull()
   if(!snapshotLogged) { log.event("authenticated"); log.event("snapshotLoaded"); snapshotLogged=true }
   if (socket == null) openStream()
   publish(if (socketOnline) "ONLINE" else "RECONNECTING")
  } catch (e: Exception) { dropSocket(e.message ?: "Gateway unavailable") }
 }
 private fun openStream() {
  val url = host.trimEnd('/').replaceFirst("http", "ws") + "/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=" + java.net.URLEncoder.encode(clientRef, "UTF-8") + "&clientLabel=" + java.net.URLEncoder.encode(clientLabel, "UTF-8")
  socket = http.newWebSocket(Request.Builder().url(url).header("Authorization", "Bearer $token").build(), object : WebSocketListener() {
   override fun onOpen(webSocket: WebSocket, response: Response) { if (closed) { webSocket.cancel(); return }; socketOnline = true; if (wasDown) { wasDown = false; log.surface("reconnected") }; openGeneration += 1; submit { refresh() } }
   // R1 FIX - the surface declares its OWN gaps.
   //
   // Events emitted between the network dying and `onLost` firing are gone before any staleness signal exists,
   // so a receipt cannot bound a gap it never saw begin. Two numbers from that run, kept apart because Mech's
   // review caught them conflated in an earlier version of this comment: the surface's own declaration for the
   // hole was 436..470, i.e. 35 events, and 8 of the affected seqs fell OUTSIDE the declared offline interval
   // (the pre-`stale` part) and had therefore appeared as silent MISSING before this fix.
   // But the surface CAN see the discontinuity itself: if seq jumps, it knows exactly what it missed. Writing
   // that down turns a silent hole into a declared one, which is the difference the workbook actually asks
   // for - the prohibition is on presenting missing events as live consistency, not on losing them.
   override fun onMessage(webSocket: WebSocket, text: String) { if (webSocket === socket) { runCatching {
     val e = JSONObject(text).optJSONObject("event")
     if (e != null) {
       val seq = e.optInt("seq", -1)
       if (seq > 0) {
         if (lastObservedSeq > 0 && seq > lastObservedSeq + 1) log.surface("gap", -1, "", "", lastObservedSeq + 1, seq - 1)
         lastObservedSeq = seq
       }
       log.surface("event", seq, e.optString("type"), e.optString("timestamp"))
     }
   }; submit { refresh() } } }
   override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (webSocket === socket) { socketOnline = false; socket = null; wasDown = true; log.surface("stale"); publish("OFFLINE", "Connection interrupted. Retrying…") } }
   override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (webSocket === socket) { socketOnline = false; socket = null; wasDown = true; log.surface("stale"); publish("OFFLINE", "Connection closed. Retrying…") } }
  })
 }
 private val callback = object : ConnectivityManager.NetworkCallback() {
  override fun onLost(network: Network) { dropSocket("Network lost. Showing cached data.") }
  override fun onAvailable(network: Network) { submit { refresh() } }
 }
 fun start() { log.surfaceReset(); connectivity.registerDefaultNetworkCallback(callback); executor.scheduleWithFixedDelay({ refresh() }, 0, 2, TimeUnit.SECONDS) }
 fun createTask(done: (String) -> Unit) { submit { try { val task = request("tasks", JSONObject().put("type", "CHECKPOINT_DEMO")); handler.post { if (!closed) done(task.getString("id")) }; refresh() } catch (e: Exception) { publish(if (socketOnline) "ONLINE" else "OFFLINE", e.message ?: "Task creation failed") } } }
 /**
  * MESH-301 step 4 — a strict target-device safe task, issued from this control surface.
  *
  * The target travels inside `input`, which is where every other route's parameters travel. That is more than
  * tidiness: the gateway's request fingerprint already covers `input`, so the SAME idempotency key cannot be
  * made to mean two different devices, and replaying a key returns the first Action instead of executing a
  * second time. The low-level `/tasks` route is deliberately NOT used, because it accepts only `type`.
  *
  * `done` receives the created task id, or null when the City refused. An unknown target is REFUSED rather
  * than silently queued, and the refusal is reported through the same publish channel as any other failure -
  * so a refused target cannot be mistaken for a waiting one.
  */
 fun createTargetedTask(targetDeviceRef: String, idempotencyKey: String, done: (String?) -> Unit) {
  submit {
   try {
    val body = JSONObject()
      .put("route", "CITY_TASK")
      .put("target", "city.task")
      .put("operation", "CHECKPOINT_DEMO")
      .put("input", JSONObject().put("targetDeviceRef", targetDeviceRef))
      .put("idempotencyKey", idempotencyKey)
    val data = request("actions", body)
    val taskId = data.optJSONObject("action")?.optJSONObject("backendRef")?.optString("taskId")?.takeIf { it.isNotBlank() }
    handler.post { if (!closed) done(taskId) }
    refresh()
   } catch (e: Exception) {
    publish(if (socketOnline) "ONLINE" else "OFFLINE", e.message ?: "Targeted task failed")
    handler.post { if (!closed) done(null) }
   }
  }
 }
 private fun capabilityError(error: Exception): JSONObject { val failure=capabilityFailure(error,socketOnline);return JSONObject().put("status","FAILED").put("errorCode",failure.code).put("httpStatus",failure.status ?: JSONObject.NULL).put("error",failure.message) }
 fun invokeCapability(id: String, operation: String, input: JSONObject, done: (JSONObject) -> Unit) { submit { val response=try { request("capabilities/$id/invoke",JSONObject().put("operationId",operation).put("input",input)) } catch(e: Exception) { capabilityError(e) };handler.post {if(!closed)done(response)};refresh() } }
 fun invocationDetail(id: String, done: (JSONObject) -> Unit) { submit { val response=try { request("capability-invocations/"+java.net.URLEncoder.encode(id,"UTF-8")) } catch(e: Exception) { capabilityError(e) };handler.post {if(!closed)done(response)} } }
 private fun row(path: String, body: JSONObject? = null): JSONObject = try { request(path, body) } catch(e: Exception) { val failure=capabilityFailure(e,socketOnline);JSONObject().put("errorCode",failure.code).put("httpStatus",failure.status ?: JSONObject.NULL).put("error",failure.message) }
 private fun deliver(response: JSONObject, done: (JSONObject) -> Unit) { handler.post { if(!closed) done(response) } }
 /** T1 — GET /api/v0/rooms. The returned hubUrl is loopback-only and is never used by Android. */
 fun rooms(done: (JSONObject) -> Unit) { submit { deliver(row("rooms"),done) } }
 fun actions(limit: Int, done: (JSONObject) -> Unit) { submit { deliver(row("actions?limit="+limit.coerceIn(1,200)),done) } }
 fun actionDetail(actionId: String, done: (JSONObject) -> Unit) { submit { deliver(row("actions/"+java.net.URLEncoder.encode(actionId,"UTF-8")),done) } }
 /**
  * POST /api/v0/ask.
  *
  * `idempotencyKey` identifies ONE user action: retrying the same action with the same key
  * makes the gateway replay its first Action instead of executing again. A new action must
  * carry a new key.
  */
 fun ask(text: String, selection: JSONObject?, confirm: Boolean, idempotencyKey: String?, done: (JSONObject) -> Unit) {
  submit {
   val body=JSONObject().put("text",text)
   if(selection!=null)body.put("selection",selection)
   if(confirm)body.put("confirm",true)
   if(!idempotencyKey.isNullOrBlank())body.put("idempotencyKey",idempotencyKey)
   deliver(row("ask",body),done)
  }
 }
 fun askTargets(done: (JSONObject) -> Unit) { submit { deliver(row("ask/targets"),done) } }
 fun cancel(id: String) { submit { try { request("tasks/$id/cancel", JSONObject()); refresh() } catch (e: Exception) { publish(if (socketOnline) "ONLINE" else "OFFLINE", e.message ?: "Cancel failed") } } }
 fun providerChoice(id: String, providerRef: String) {
  if (providerRef.isBlank()) { publish(if (socketOnline) "ONLINE" else "OFFLINE", "No service named for the choice"); return }
  submit { try { request("tasks/$id/provider-choice", JSONObject().put("providerRef", providerRef)); refresh() } catch (e: Exception) { publish(if (socketOnline) "ONLINE" else "OFFLINE", e.message ?: "Choice failed") } }
 }
 fun close() { log.surface("stop", lastServerMaxSeq); closed = true; runCatching { connectivity.unregisterNetworkCallback(callback) }; socket?.cancel(); executor.shutdownNow(); http.dispatcher.cancelAll(); http.connectionPool.evictAll() }
}
