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
}
class PairingApi(private val log: PilotLog) {
 private val http=OkHttpClient.Builder().callTimeout(6,java.util.concurrent.TimeUnit.SECONDS).build()
 private val executor=Executors.newSingleThreadExecutor(); private val main=Handler(Looper.getMainLooper())
 private val fence=CallbackFence()
 private fun submit(action:(Long)->Unit) { val ticket=fence.ticket()?:return; try { executor.execute { if(fence.accepts(ticket)) action(ticket) } } catch(_:java.util.concurrent.RejectedExecutionException) { /* disposal raced submission */ } }
 private fun request(origin: String,path: String, body: JSONObject?=null): JSONObject {
  val r=Request.Builder().url(origin+"/api/v0/pairing/"+path).header("X-City-Api-Version","0").header("X-City-Schema-Version","0")
  if(body!=null) r.post(body.toString().toRequestBody("application/json".toMediaType()))
  return http.newCall(r.build()).execute().use { response -> check(response.isSuccessful) { "Pairing rejected (HTTP ${response.code}); refresh session or check code" }; val data=JSONObject(response.body!!.string()); check(compatible(data.optInt("apiVersion",-1),data.optInt("schemaVersion",-1))) { "Protocol version mismatch" }; data }
 }
 private fun descriptor(origin: String): PairDescriptor {
  val data=request(origin,"info"); val d=data.getJSONObject("descriptor"); check(d.getInt("descriptorVersion")==1 && compatible(d.getInt("apiVersion"),d.getInt("schemaVersion"))) { "Descriptor version mismatch" }
  val e=d.getJSONObject("endpoint"); val actual=endpoint("${e.getString("scheme")}://${e.getString("host")}:${e.getInt("port")}"); check(actual==origin) { "Endpoint identity conflict" }
  return PairDescriptor(d.getString("cityId"),actual,if(d.isNull("pairingSessionId")) "" else d.optString("pairingSessionId",""),if(d.isNull("expiresAt")) "" else d.optString("expiresAt",""),displayName=d.optString("displayName"))
 }
 fun discover(origin: String, expectedCity: String?=null, done: (Result<PairDescriptor>)->Unit) { submit { ticket -> val result=runCatching { descriptor(endpoint(origin)).also { check(expectedCity==null || expectedCity==it.cityId) { "City identity conflict" }; log.event("discovery") } }; main.post { if(fence.accepts(ticket)) done(result) } } }
 fun pair(d: PairDescriptor,mode: String,code: String,done: (Result<Pair<String,String>>)->Unit) { submit { ticket -> log.event("action"); log.event("pairingSubmitted"); val result=runCatching {
  val active=exchangeDescriptor(d,descriptor(d.endpoint),mode)
  val body=JSONObject().put("cityId",d.cityId).put("sessionId",active.session).put("method",mode); if(mode=="qr") body.put("secret",d.secret) else body.put("shortCode",code)
  val reply=request(d.endpoint,"exchange",body); check(reply.getString("cityId")==d.cityId) { "City identity conflict" }; val e=reply.getJSONObject("endpoint"); check(endpoint("${e.getString("scheme")}://${e.getString("host")}:${e.getInt("port")}")==d.endpoint) { "Endpoint identity conflict" }; log.event("authenticated"); d.endpoint to reply.getString("credential")
 }; if(result.isFailure) log.event("pairingError"); main.post { if(fence.accepts(ticket)) done(result) } } }
 fun close() { fence.close(); main.removeCallbacksAndMessages(null); executor.shutdownNow(); http.dispatcher.cancelAll() }
}
