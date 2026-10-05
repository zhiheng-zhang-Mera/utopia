package city.utopia.control

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.security.SecureRandom

/**
 * JOIN-590 · cross-network joining over the relay pipe.
 *
 * THE PROBLEM THIS SOLVES. The device opens an outbound socket to a reachable City and keeps it.
 * A private City behind unreachable NAT still needs a public forwarding endpoint. Everything the join needs then travels
 * inside that pipe using the City's OWN routes — no second protocol and no second trust decision.
 *
 * WHY APPROVAL AND NOT A SHORT CODE. The City's relay carries a NAMED list of routes and it does not include the
 * `pairing` route family, which is where a typed short code is consumed (`pairing/exchange`). That is the City's
 * admission decision, not a client's, so the relay path joins the way the whitelisted routes are designed to:
 *
 *   1. `join/request`  — this device asks to join, holding the ONLY copy of a claim secret it generated here.
 *   2. `join/status`   — poll until the owner decides. The claim proves this poll belongs to the requester, and the
 *                        City deliberately answers a DECIDED request even to a caller that cannot prove the claim.
 *   3. `join/exchange` — only after approval, with the claim in the body as the proof.
 *
 * A typed short code stays the fastest path when the City IS reachable (DIRECT mode on the pairing screen). The
 * relay path's user action is "ask, then wait for the owner's approval on the City", which needs no credential on
 * this device at all — exactly the product flow the Connection Onboarding programme defined.
 *
 * WHAT IT DOES NOT DO: it never invents a credential, never relaxes the claim's single-holder rule, never polls
 * forever (a bounded wait with a typed timeout), and it closes the pipe as soon as the join settles.
 */
object RelayPairing {

  data class Outcome(val cityId: String, val credential: String, val peerRef: String?, val role: String, val enrollment: NativeEnrollment)

  const val APPROVAL_POLL_MS = 2000L
  const val APPROVAL_WAIT_MS = 180_000L

  private val random = SecureRandom()

  /**
   * Read a text field from an answer object, treating BOTH "absent" and a JSON `null` as absent.
   *
   * WHY THIS EXISTS (a defect this task shipped and then measured): `JSONObject.optString("cityId")` on a value
   * that is JSON `null` returns the four-character string `"null"`, not "". The first version of this file used
   * `optString(...).takeIf { it.isNotEmpty() }`, so a City that reported `cityId: null` (which the join record does,
   * because the City is authoritative for its own id rather than repeating it in that row) was accepted as the
   * identity `"null"` and stored. The device then refused its own City with `City identity conflict`, which is the
   * check working correctly against a value this client had corrupted.
   */
  private fun textOrNull(source: JSONObject?, key: String): String? {
    if (source == null || source.isNull(key)) return null
    return source.optString(key).takeIf { it.isNotEmpty() }
  }

  /**
   * The SAME rule as [textOrNull], exposed so a regression guard can assert it without a live City.
   *
   * The defect this guards against is not exotic: `JSONObject.optString` turns a JSON `null` into the four-character
   * text `"null"`, and an identity stored as that text is a corrupted identity that the app then refuses to
   * reconcile with its own City.
   */
  fun declaredText(source: JSONObject?, key: String): String? = textOrNull(source, key)

  /** The claim this device keeps as its own proof of authorship. Sent only to the City being asked. */
  fun newClaim(): String {
    val bytes = ByteArray(18).also { random.nextBytes(it) }
    val out = StringBuilder(36)
    for (byte in bytes) out.append(String.format("%02x", byte))
    return out.toString()
  }

  fun joinViaApproval(
    address: String,
    installationId: String,
    displayName: String,
    installation: JSONObject,
    progressCallback: (stage: String, detail: String) -> Unit,
    successCallback: (Outcome) -> Unit,
    failureCallback: (RelayDialError) -> Unit,
  ): java.io.Closeable {
    val main = Handler(Looper.getMainLooper())
    val active = java.util.concurrent.atomic.AtomicBoolean(true)
    var held: RelayConnection? = null
    val handle = java.io.Closeable { active.set(false); main.removeCallbacksAndMessages(null); held?.close() }
    val onProgress: (String,String)->Unit = { stage,detail -> main.post { if(active.get())progressCallback(stage,detail) } }
    val onSuccess: (Outcome)->Unit = { value -> main.post { if(active.compareAndSet(true,false)) { main.removeCallbacksAndMessages(null); successCallback(value) } } }
    val onFailure: (RelayDialError)->Unit = { error -> main.post { if(active.compareAndSet(true,false)) { held?.close();main.removeCallbacksAndMessages(null);failureCallback(error) } } }
    val target = RelayDial.target(address)
    if (target == null) { onFailure(RelayDialError("RELAY_NO_TARGET", "enter the City address to ask", fallback = false)); return handle }
    val host = target.host
    val port = target.port
    val claim = newClaim()

    RelayDial.dial(
      host = host, port = port, secure = target.secure, label = displayName, installationId = installationId,
      onReady = { connection ->
        held=connection
        if(!active.get()) { connection.close();return@dial }
        onProgress("ASKING", "Asking the City to let this device join…")
        // FIRST ask the City who it is. The identity the app must remember afterwards is the one the CITY declared
        // over this very pipe, so the join never adopts an identity from a row that legitimately omits it.
        connection.forward("/api/v0/join/info", JSONObject()) { info ->
          if(!active.get())return@forward
          if (info.isFailure) {
            abandon(connection, info, "the City did not describe itself over the relay", onFailure)
          } else {
            val dialedCityId = textOrNull(info.getOrNull()?.optJSONObject("payload"), "cityId")
            if (dialedCityId == null) {
              connection.close()
              onFailure(RelayDialError("RELAY_JOIN_INFO_REFUSED", "the City did not declare its identity over the relay"))
            } else {
              requestJoin(connection, dialedCityId, claim, installationId, displayName, installation, main, active, onProgress, onSuccess, onFailure)
            }
          }
        }
      },
      onFailure = onFailure,
    )
    return handle
  }

  private fun requestJoin(
    connection: RelayConnection,
    dialedCityId: String,
    claim: String,
    installationId: String,
    displayName: String,
    installation: JSONObject,
    main: Handler,
    active: java.util.concurrent.atomic.AtomicBoolean,
    onProgress: (String, String) -> Unit,
    onSuccess: (Outcome) -> Unit,
    onFailure: (RelayDialError) -> Unit,
  ) {
    val ask = JSONObject()
      .put("displayName", displayName)
      .put("platform", "android")
      .put("installationHint", installationId)
      .put("claim", claim)
    connection.forward("/api/v0/join/request", ask) { asked ->
      if(!active.get())return@forward
      if (asked.isFailure) {
        abandon(connection, asked, "the City did not accept the join request", onFailure)
      } else {
        val answer = asked.getOrNull()
        val payload = answer?.optJSONObject("payload")
        val requestId = textOrNull(payload, "requestId") ?: textOrNull(payload, "id")
        if (answer?.optBoolean("ok") != true || requestId == null) {
          val detail = textOrNull(payload, "error") ?: "the City did not open a join request"
          connection.close()
          onFailure(RelayDialError("RELAY_JOIN_REQUEST_REFUSED", detail, status = answer?.optInt("status")))
        } else {
          val shortRef = textOrNull(payload, "shortRef") ?: requestId
          onProgress("WAITING", "Waiting for the owner to approve on the City ($shortRef)…")
          pollForDecision(main, connection, requestId, claim, dialedCityId, installation, active, System.currentTimeMillis(), onProgress, onSuccess, onFailure)
        }
      }
    }
  }

  /** Step 2: poll until the owner decides, bounded by APPROVAL_WAIT_MS. */
  private fun pollForDecision(
    main: Handler,
    connection: RelayConnection,
    requestId: String,
    claim: String,
    dialedCityId: String,
    installation: JSONObject,
    active: java.util.concurrent.atomic.AtomicBoolean,
    started: Long,
    onProgress: (String, String) -> Unit,
    onSuccess: (Outcome) -> Unit,
    onFailure: (RelayDialError) -> Unit,
  ) {
    if(!active.get())return
    if (System.currentTimeMillis() - started > APPROVAL_WAIT_MS) {
      connection.close()
      onFailure(RelayDialError("RELAY_APPROVAL_TIMEOUT", "the owner did not decide within ${APPROVAL_WAIT_MS / 1000}s", status = 504))
      return
    }
    connection.forward("/api/v0/join/status", JSONObject().put("requestId", requestId).put("claim", claim)) { status ->
      if(!active.get())return@forward
      if (status.isFailure) {
        abandon(connection, status, "the City stopped answering while waiting for approval", onFailure)
      } else {
        val answer = status.getOrNull()
        val payload = answer?.optJSONObject("payload")
        if (answer?.optBoolean("ok") != true || payload == null) {
          connection.close()
          onFailure(RelayDialError("RELAY_JOIN_STATUS_REFUSED", "the City did not report the request state", status = answer?.optInt("status")))
        } else if (payload.optBoolean("approved", false)) {
          exchangeNow(connection, requestId, claim, dialedCityId, installation, onProgress, onSuccess, onFailure)
        } else if (payload.optBoolean("terminal", false)) {
          connection.close()
          onFailure(RelayDialError("RELAY_JOIN_REJECTED", "the City refused this join request", status = 403))
        } else {
          main.postDelayed({ pollForDecision(main, connection, requestId, claim, dialedCityId, installation, active, started, onProgress, onSuccess, onFailure) }, APPROVAL_POLL_MS)
        }
      }
    }
  }

  /** Step 3: the claim proves authorship, and only an approved request answers with a credential. */
  private fun exchangeNow(
    connection: RelayConnection,
    requestId: String,
    claim: String,
    dialedCityId: String,
    installation: JSONObject,
    onProgress: (String, String) -> Unit,
    onSuccess: (Outcome) -> Unit,
    onFailure: (RelayDialError) -> Unit,
  ) {
    onProgress("APPROVED", "Approved · collecting this device's credential…")
    connection.forward("/api/v0/join/exchange", JSONObject().put("requestId", requestId).put("claim", claim).put("installation", installation)) { exchanged ->
      if (exchanged.isFailure) {
        abandon(connection, exchanged, "the City did not answer the exchange", onFailure)
      } else {
        val answer = exchanged.getOrNull()
        val payload = answer?.optJSONObject("payload")
        val credential = textOrNull(payload, "credential")
        // The joining City is the one this device DIALED and that declared itself in step 1. A response that named
        // a DIFFERENT City would have to be refused rather than adopted; a response that names none is the normal
        // case, because the City is authoritative for its own id and does not repeat it in this row.
        val answeredCityId = textOrNull(payload, "cityId")
        val mismatch = answeredCityId != null && answeredCityId != dialedCityId
        if (answer?.optBoolean("ok") != true || credential == null || mismatch) {
          val detail = textOrNull(payload, "error") ?: if (mismatch) "the City answered for a different identity" else "the City accepted no credential for this join"
          connection.close()
          onFailure(RelayDialError("RELAY_JOIN_EXCHANGE_REFUSED", detail, status = answer?.optInt("status")))
        } else {
          connection.close()
          runCatching { parseNativeEnrollment(payload!!, dialedCityId, installation.getString("instanceId")) }.fold({ record ->
            onSuccess(Outcome(cityId = dialedCityId, credential = record.sessionCredential, peerRef = connection.peerRef, role = connection.role, enrollment = record))
          }, { onFailure(RelayDialError("RELAY_ENROLLMENT_REFUSED", it.message ?: "Member enrollment required")) })
        }
      }
    }
  }

  private fun abandon(connection: RelayConnection, result: Result<JSONObject>, context: String, onFailure: (RelayDialError) -> Unit) {
    connection.close()
    val error = result.exceptionOrNull()
    onFailure(error as? RelayDialError ?: RelayDialError("RELAY_REMOTE_ERROR", "$context: " + (error?.message ?: "unknown failure")))
  }
}
