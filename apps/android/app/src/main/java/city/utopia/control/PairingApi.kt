package city.utopia.control
import android.content.Context
import android.os.Handler
import android.os.Looper
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors

class PilotLog(private val context: Context) {
 var trialId = UUID.randomUUID().toString(); private var mode = "saved"; private var actions=0; private var retries=0
 @Synchronized fun start(value: String) { trialId=UUID.randomUUID().toString(); mode=value; actions=0; retries=0; event("start") }
 @Synchronized fun event(name: String) { if(name=="action") actions++; if(name=="retry") retries++; val row=JSONObject().put("trialId",trialId).put("mode",mode).put("event",name).put("timestamp",Instant.now().toString()).put("userActions",actions).put("retryCount",retries); val file=java.io.File(context.filesDir,"pairing-events.jsonl"); if(file.length()>2_000_000) { val previous=java.io.File(context.filesDir,"pairing-events.previous.jsonl"); file.copyTo(previous,overwrite=true); file.writeText("") }; context.openFileOutput("pairing-events.jsonl",Context.MODE_APPEND).bufferedWriter().use { it.appendLine(row.toString()) } }
 /**
  * MESH-301 step 5 — THIS surface's own observation receipt.
  *
  * Written in the same JSONL vocabulary as `scripts/mesh301-mesh-probe.mjs`, so `merge` can read an Android
  * receipt beside a desktop one and produce ONE convergence table. The reason it is recorded ON THE DEVICE is
  * the whole point of step 5: the number has to be what Android observed, at the moment Android observed it.
  * A timestamp produced anywhere else would be a claim about Android rather than a measurement by Android.
  *
  * One session is one receipt: `surfaceReset()` truncates, because a file holding two sessions' boundaries
  * interleaved is unreadable rather than merely untidy (that defect was already found once, in the desktop
  * probe, by running it).
  */
 @Synchronized fun surfaceReset() { runCatching { context.openFileOutput("surface-observations.jsonl",Context.MODE_PRIVATE).close() }; surface("start") }
 @Synchronized fun surface(kind: String, seq: Int = -1, type: String = "", serverAt: String = "", from: Int = -1, to: Int = -1) {
  runCatching {
   val row = JSONObject().put("surface", android.os.Build.MODEL.ifBlank { "android-device" }).put("kind", kind).put("at", Instant.now().toString()).put("observedAt", System.currentTimeMillis())
   if (seq >= 0) { row.put("seq", seq); if (kind == "resync") row.put("maxSeq", seq); if (kind == "stop") row.put("serverMaxSeq", seq) }
   // R1: a gap the surface declares about ITSELF. `merge` reports these as declared, never as silent misses -
   // and never as convergence either, because a hole is a hole however honestly it is labelled.
   if (from >= 0 && to >= from) { row.put("gapFrom", from); row.put("gapTo", to) }
   if (type.isNotEmpty()) row.put("type", type)
   if (serverAt.isNotEmpty()) row.put("serverAt", serverAt)
   context.openFileOutput("surface-observations.jsonl", Context.MODE_APPEND).bufferedWriter().use { it.appendLine(row.toString()) }
  }
 }
}
class PairingApi(private val log: PilotLog, private val enrollmentStore: NativeEnrollmentStore? = null, private val installation: (() -> JSONObject)? = null) {
 private val http=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(6,java.util.concurrent.TimeUnit.SECONDS).build()
 private val executor=Executors.newSingleThreadExecutor(); private val main=Handler(Looper.getMainLooper())
 private val fence=CallbackFence()
 private fun submit(action:(Long)->Unit) { val ticket=fence.ticket()?:return; try { executor.execute { if(fence.accepts(ticket)) action(ticket) } } catch(_:java.util.concurrent.RejectedExecutionException) { /* disposal raced submission */ } }
 private fun request(origin: String,path: String, body: JSONObject?=null, credential: String?=null): JSONObject {
  val r=Request.Builder().url(origin+"/api/v0/pairing/"+path).header("X-City-Api-Version","0").header("X-City-Schema-Version","0")
  // The pairing family is split: `info`/`exchange` are public by design (a joining client has no credential yet),
  // while `session` MINTS a one-time code and is therefore an owner action the City authenticates. The first
  // version sent no credential at all, so tapping the short-code entry in this app answered 401 and looked like a
  // broken feature. The credential is only attached where the route requires it.
  if(credential!=null && credential.isNotBlank()) r.header("Authorization","Bearer $credential")
  if(body!=null) r.post(body.toString().toRequestBody("application/json".toMediaType()))
  return http.newCall(r.build()).execute().use { response -> check(response.isSuccessful) { "Pairing rejected (HTTP ${response.code}); refresh session or check code" }; val data=JSONObject(response.body!!.string()); check(compatible(data.optInt("apiVersion",-1),data.optInt("schemaVersion",-1))) { "Protocol version mismatch" }; data }
 }
 private fun descriptorSync(origin: String): PairDescriptor {
  val data=request(origin,"info"); val d=data.getJSONObject("descriptor"); check(d.getInt("descriptorVersion")==1 && compatible(d.getInt("apiVersion"),d.getInt("schemaVersion"))) { "Descriptor version mismatch" }
  val e=d.getJSONObject("endpoint"); val actual=endpoint("${e.getString("scheme")}://${e.getString("host")}:${e.getInt("port")}"); check(actual==origin) { "Endpoint identity conflict" }
  return PairDescriptor(d.getString("cityId"),actual,if(d.isNull("pairingSessionId")) "" else d.optString("pairingSessionId",""),if(d.isNull("expiresAt")) "" else d.optString("expiresAt",""),displayName=d.optString("displayName"))
 }
 // Public, callback-shaped descriptor read. The short-code entry resolves the City from the address this
 // installation already knows, so it does not need discovery or a previously chosen City.
 fun descriptor(origin: String, done: (Result<PairDescriptor>)->Unit) { submit { ticket -> val result=runCatching { descriptorSync(endpoint(origin)) }; main.post { if(fence.accepts(ticket)) done(result) } } }
 /**
  * PAIR BY SHORT CODE WITHOUT MINTING ONE.
  *
  * The common case is the one this shape exists for: the code was created on ANOTHER surface (the City's Web
  * page, another trusted device, or an owner on the far side of the network), and this device only has to type it.
  * Minting requires the owner credential for that City, which a joining device by definition does not hold, so
  * requiring a local mint before accepting a code would make the normal join impossible.
  *
  * The method label is resolved from what the City is asked next: `pair` performs the descriptor read first and
  * chooses the QR method only when the descriptor carries a session secret, so a typed code is submitted as
  * `mdns` (the City's short-code path) and never as a malformed QR secret.
  */
 fun pairWithCode(rawAddress: String, code: String, done: (Result<Triple<String,String,PairDescriptor>>)->Unit) {
  submit { ticket -> log.event("action"); log.event("pairingSubmitted")
   val prepared=runCatching {
    val origin=endpoint(RelayDial.target(rawAddress)?.origin ?: error("Invalid City address")); val descriptor=descriptorSync(origin); val method=if(descriptor.secret.isNullOrBlank()) "mdns" else "qr"
    if(method=="qr" && code.isBlank()) error("This City issued a QR session; scan the QR or use a short code")
    descriptor to method
   }
   prepared.onFailure { failure -> log.event("pairingError"); main.post { if(fence.accepts(ticket)) done(Result.failure(failure)) } }
   prepared.onSuccess { (descriptor,method) ->
    pair(descriptor,method,code) { inner -> main.post { if(fence.accepts(ticket)) done(inner) } }
   }
  }
 }
 // Mint a one-time pairing session on the City: the owner action every normal join consumes. Returns the
 // refreshed descriptor, whose session id and expiry are what the UI shows.
 fun session(d: PairDescriptor, credential: String, done: (Result<PairDescriptor>)->Unit) { submit { ticket -> val result=runCatching { val body=request(d.endpoint,"session",null,credential); val desc=body.optJSONObject("descriptor"); val mine=if(desc==null) d else run { val e=desc.getJSONObject("endpoint"); PairDescriptor(desc.getString("cityId"),endpoint("${e.getString("scheme")}://${e.getString("host")}:${e.getInt("port")}"),desc.optString("pairingSessionId",""),desc.optString("expiresAt",""),displayName=desc.optString("displayName")) }; log.event("pairingSession"); mine }; main.post { if(fence.accepts(ticket)) done(result) } } }
 fun discover(origin: String, expectedCity: String?=null, done: (Result<PairDescriptor>)->Unit) { submit { ticket -> val result=runCatching { descriptorSync(endpoint(origin)).also { check(expectedCity==null || expectedCity==it.cityId) { "City identity conflict" }; log.event("discovery") } }; main.post { if(fence.accepts(ticket)) done(result) } } }
 fun pair(d: PairDescriptor,mode: String,code: String,done: (Result<Triple<String,String,PairDescriptor>>)->Unit) { submit { ticket -> log.event("action"); log.event("pairingSubmitted"); var enrolled:NativeEnrollment?=null; val result=runCatching {
  val active=exchangeDescriptor(d,descriptorSync(d.endpoint),mode)
  val body=JSONObject().put("cityId",d.cityId).put("sessionId",active.session).put("method",mode); if(mode=="qr") body.put("secret",d.secret) else body.put("shortCode",code)
  installation?.invoke()?.let { body.put("installation",it) }
  val reply=request(d.endpoint,"exchange",body); check(reply.getString("cityId")==d.cityId) { "City identity conflict" }; val e=reply.getJSONObject("endpoint"); check(endpoint("${e.getString("scheme")}://${e.getString("host")}:${e.getInt("port")}")==d.endpoint) { "Endpoint identity conflict" }; val credential=if(installation!=null) { val record=parseNativeEnrollment(reply,d.cityId,body.getJSONObject("installation").getString("instanceId")); enrolled=record; record.sessionCredential } else reply.getString("credential"); log.event("authenticated"); Triple(d.endpoint,credential,active)
 }; if(result.isFailure) log.event("pairingError"); main.post { if(fence.accepts(ticket)) { val saved=runCatching { enrolled?.let { enrollmentStore?.save(d.endpoint,it) };result.getOrThrow() }; done(saved) } } } }
 fun close() { fence.close(); main.removeCallbacksAndMessages(null); executor.shutdownNow(); http.dispatcher.cancelAll() }
}
