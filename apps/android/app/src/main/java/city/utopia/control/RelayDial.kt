package city.utopia.control

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * JOIN-590 · the DIAL side of the relay, for Android.
 *
 * WHY THIS EXISTS. A handset can carry the existing join protocol over a reachable City socket.
 * This transport does not create a route to a City hidden behind unreachable NAT. The City end already exists (`services/dev-gateway/server.mjs` accepts a peer that dials `/api/v0/relay`);
 * this file is the Android client that DIALS it. It is a port of the Web layer's `apps/web/relay-dial.mjs` and
 * deliberately keeps the same wire shape instead of inventing a second one:
 *
 *   → `{"kind":"relay-request","requestId":…,"path":…,"method":"POST","body":…}`
 *   ← `{"requestId":…,"ok":…,"status":…,"response":{"ok":…,"status":…,"payload":…}}`
 *   ← `{"type":"RELAY_READY","peerRef":…,"role":…,"verified":…,"payloads":[…]}`
 *
 * THE LOAD-BEARING DECISION (inherited, not re-decided): the forwarded payload is a JOIN-HANDSHAKE PAYLOAD THAT
 * ALREADY EXISTS. The path must be on the City's own whitelist and the body is exactly what this app would have
 * POSTed directly, so the City that receives the forward runs its own route: the same one-time claim authorises
 * it and the same owner surface approves it. The relay is a pipe, not a second trust model.
 *
 * WHAT IT REFUSES TO DO:
 *   * it never opens a socket to more than the ONE host it was asked to dial;
 *   * it refuses any path outside the whitelist BEFORE dialling, so a compromised caller cannot turn a City into
 *     an open proxy;
 *   * it never hangs: the handshake and every forwarded request carry their own bounded timeout and both failures
 *     are TYPED;
 *   * it never treats `RELAY_READY` as trust — that frame only reports the peer ref the CITY decided.
 */
class RelayDialError(code: String, detail: String, val status: Int? = null, val fallback: Boolean = true) : Exception("$code: $detail") {
  val code: String = code
}

data class RelayCity(val host: String, val port: Int, val secure: Boolean)
data class RelayTarget(val host:String,val port:Int?,val secure:Boolean) {
 val origin:String get()=(if(secure) "https" else "http")+"://"+host+(port?.let { ":$it" }?:"")
}

/** Mirrors the City's own `RELAY_PAYLOAD_PATHS`. A literal on purpose: the client must refuse BEFORE it dials. */
val RELAY_PAYLOAD_PATHS: Set<String> = setOf(
  "/api/v0/join/info",
  "/api/v0/join/nearby",
  "/api/v0/join/request",
  "/api/v0/join/status",
  "/api/v0/join/exchange",
  "/api/v0/device/session",
)

const val RELAY_DIAL_PATH = "/api/v0/relay"
const val RELAY_DIAL_TIMEOUT_MS = 8000L
const val RELAY_FORWARD_TIMEOUT_MS = 20000L

/** One live pipe. `forward` is asynchronous because the answer arrives as a frame, and a blocking call on the UI
 *  thread would freeze the surface it exists to serve. */
class RelayConnection internal constructor(
  val city: RelayCity,
  val peerRef: String?,
  val verified: Boolean,
  val role: String,
  private val socket: WebSocket,
  private val main: Handler,
  private val inFlight: ConcurrentHashMap<String, PendingForward>,
) {
  /**
   * Forward one whitelisted City route over the pipe and answer with the City's own envelope.
   *
   * The caller re-checks `ok`: a City that answered 403 is a SUCCESSFUL forward carrying a refusal. Flattening the
   * two would make every refusal look like a transport fault, which is the confusion the `response` wrapper on the
   * wire exists to prevent.
   */
  fun forward(path: String, body: JSONObject = JSONObject(), timeoutMs: Long = RELAY_FORWARD_TIMEOUT_MS, onAnswer: (Result<JSONObject>) -> Unit) {
    val normalised = (if (path.startsWith("/")) path else "/$path").substringBefore('?')
    if (normalised !in RELAY_PAYLOAD_PATHS) { onAnswer(Result.failure(RelayDialError("RELAY_PATH_REFUSED", "the relay does not carry $normalised", status = 403, fallback = false))); return }
    val requestId = "dial-" + System.currentTimeMillis().toString(36) + "-" + Integer.toHexString((Math.random() * 0xffff).toInt())
    val timer = Runnable {
      inFlight.remove(requestId)?.let { onAnswer(Result.failure(RelayDialError("RELAY_TIMEOUT", "the relay did not answer $normalised within $timeoutMs ms", status = 504))) }
    }
    inFlight[requestId] = PendingForward(normalised, timer, onAnswer)
    main.postDelayed(timer, timeoutMs)
    val frame = JSONObject().put("kind", "relay-request").put("requestId", requestId).put("path", normalised).put("method", "POST").put("body", body)
    val sent = runCatching { socket.send(frame.toString()) }.getOrDefault(false)
    if (!sent) { main.removeCallbacks(timer); inFlight.remove(requestId); onAnswer(Result.failure(RelayDialError("RELAY_SEND_FAILED", "the relay socket refused the frame"))) }
  }

  fun close() { runCatching { socket.close(1000, "client closing") } }
}

internal class PendingForward(val path: String, val timer: Runnable, val onAnswer: (Result<JSONObject>) -> Unit)

object RelayDial {

  val client: OkHttpClient by lazy {
    OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
      .connectTimeout(8, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)   // a relay pipe is long-lived; each forwarded request carries its own timeout
      .pingInterval(20, TimeUnit.SECONDS)
      .build()
  }

  /** `ws://host:port/api/v0/relay?apiVersion=0&schemaVersion=0` plus the optional peer declaration parameters. */
  fun socketUrl(host: String, port: Int? = null, secure: Boolean = false, installationId: String? = null, label: String? = null, clientUrl: String? = null): String {
    val bare = host.trim().removePrefix("https://").removePrefix("http://").removePrefix("wss://").removePrefix("ws://").substringBefore('/')
    require(bare.isNotEmpty()) { "no relay host was given to dial" }
    val scheme = if (secure) "wss" else "ws"
    val authority = if (port == null || bare.substringAfterLast(':', "").isNotEmpty()) bare else "$bare:$port"
    val params = mutableListOf("apiVersion=0", "schemaVersion=0")
    fun add(key: String, value: String?) { if (!value.isNullOrBlank()) params += "$key=" + URLEncoder.encode(value, "UTF-8") }
    add("installationId", installationId); add("label", label); add("clientUrl", clientUrl)
    return "$scheme://$authority$RELAY_DIAL_PATH?" + params.joinToString("&")
  }

  /** Parse `host[:port]` (or a URL) into the host/port a dial needs. Returns null when there is no host at all. */
  fun target(address: String): RelayTarget? {
    val trimmed = address.trim()
    if (trimmed.isEmpty()) return null
    val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) trimmed else "http://$trimmed"
    val uri = runCatching { URI(withScheme) }.getOrNull() ?: return null
    val host = uri.host ?: return null
    if(uri.scheme !in listOf("http","https","ws","wss") || uri.userInfo!=null || uri.query!=null || uri.fragment!=null || (uri.path.isNotBlank() && uri.path!="/") || (uri.port!=-1 && uri.port !in 1..65535))return null
    return RelayTarget(host,uri.port.takeIf { it > 0 },uri.scheme in listOf("https","wss"))
  }

  /**
   * Dial a City's relay endpoint and wait until IT says the peer is registered.
   *
   * The wait is on the City's own `RELAY_READY` frame rather than on `onOpen`: a socket that opened and was then
   * refused by the admission policy must not look like a working path, and that refusal has to arrive as a typed
   * error the surface can report.
   */
  fun dial(
    host: String,
    port: Int? = null,
    secure: Boolean = false,
    credential: String? = null,
    installationId: String? = null,
    label: String? = null,
    clientUrl: String? = null,
    handshakeTimeoutMs: Long = RELAY_DIAL_TIMEOUT_MS,
    onReady: (RelayConnection) -> Unit,
    onFailure: (RelayDialError) -> Unit,
  ) {
    val main = Handler(Looper.getMainLooper())
    val url = try { socketUrl(host, port, secure, installationId, label, clientUrl) } catch (error: Throwable) {
      onFailure(RelayDialError("RELAY_NO_TARGET", error.message ?: "no relay host", fallback = false)); return
    }
    // OkHttp speaks to a ws:// URL through an http(s) URL, and (unlike a browser) can set an Authorization header,
    // so the credential travels as a header. The City selects no subprotocol, so offering one the server will not
    // echo would be a needless handshake failure.
    val httpUrl = url.replaceFirst("ws://", "http://").replaceFirst("wss://", "https://")
    val builder = Request.Builder().url(httpUrl)
    if (!credential.isNullOrBlank()) builder.header("Authorization", "Bearer $credential")
    val inFlight = ConcurrentHashMap<String, PendingForward>()
    val settled = AtomicBoolean(false)
    val held = arrayOfNulls<WebSocket>(1)

    val watchdog = Runnable {
      if (settled.compareAndSet(false, true)) {
        runCatching { held[0]?.close(1000, "handshake timeout") }
        onFailure(RelayDialError("RELAY_TIMEOUT", "no relay-ready frame within $handshakeTimeoutMs ms"))
      }
    }
    main.postDelayed(watchdog, handshakeTimeoutMs)

    fun fail(error: RelayDialError) {
      if (!settled.compareAndSet(false, true)) return
      main.removeCallbacks(watchdog)
      runCatching { held[0]?.close(1000, error.code) }
      onFailure(error)
    }

    val listener = object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) { held[0] = webSocket }

      override fun onMessage(webSocket: WebSocket, text: String) {
        val frame = runCatching { JSONObject(text) }.getOrNull() ?: return
        if (frame.optString("type") == "RELAY_READY") {
          if (!settled.compareAndSet(false, true)) return
          main.removeCallbacks(watchdog)
          val parsed = runCatching { URI(httpUrl) }.getOrNull()
          onReady(RelayConnection(
            city = RelayCity(parsed?.host ?: host, parsed?.port?.takeIf { it > 0 } ?: if (secure) 443 else 80, secure),
            peerRef = frame.optString("peerRef").takeIf { it.isNotEmpty() },
            verified = frame.optBoolean("verified", false),
            role = frame.optString("role", "unknown"),
            socket = webSocket, main = main, inFlight = inFlight,
          ))
          return
        }
        val requestId = frame.optString("requestId").takeIf { it.isNotEmpty() } ?: return
        val waiting = inFlight.remove(requestId) ?: return
        main.removeCallbacks(waiting.timer)
        val response = frame.optJSONObject("response")
        if (response == null && frame.has("error")) {
          waiting.onAnswer(Result.failure(RelayDialError("RELAY_REMOTE_ERROR", frame.optString("error"), frame.optInt("status", 502))))
        } else {
          val answer = response ?: JSONObject().put("ok", frame.optBoolean("ok")).put("status", frame.optInt("status", 502)).put("payload", frame.opt("payload"))
          waiting.onAnswer(Result.success(answer))
        }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        fail(RelayDialError("RELAY_UNREACHABLE", "could not reach the relay at ${host}: ${t.message ?: t.javaClass.simpleName}", status = response?.code))
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        fail(RelayDialError("RELAY_DIAL_CLOSED", "the relay connection closed before it was ready"))
        for ((_, waiting) in inFlight) { main.removeCallbacks(waiting.timer); waiting.onAnswer(Result.failure(RelayDialError("RELAY_DIAL_CLOSED", "the relay connection closed while ${waiting.path} was in flight"))) }
        inFlight.clear()
      }
    }

    runCatching { client.newWebSocket(builder.build(), listener) }
      .onFailure { fail(RelayDialError("RELAY_UNREACHABLE", it.message ?: "could not open the relay socket")) }
  }
}
