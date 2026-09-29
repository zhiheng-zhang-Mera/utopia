package city.utopia.control

import java.io.IOException

class CapabilityRequestException(val code: String, val status: Int, message: String): Exception(message)
data class CapabilityFailure(val code: String, val status: Int?, val message: String)

fun acceptInvocationSummary(currentStatus: String, summaryStatus: String): Boolean =
 !(currentStatus in setOf("COMPLETED","FAILED","INTERRUPTED") && summaryStatus=="RUNNING")

fun capabilityFailure(error: Exception, online: Boolean): CapabilityFailure = when(error) {
 is CapabilityRequestException -> CapabilityFailure(error.code,error.status,error.message ?: error.code)
 is IOException -> CapabilityFailure("OFFLINE",null,error.message ?: "Gateway unavailable")
 else -> CapabilityFailure(if(online) "INVOCATION_UNAVAILABLE" else "OFFLINE",null,error.message ?: "Request unavailable")
}
