package city.utopia.control
fun compatible(apiVersion: Int, schemaVersion: Int) = apiVersion == 0 && schemaVersion == 0
fun canCancel(state: String) = state in setOf("QUEUED", "ASSIGNED", "RUNNING")
