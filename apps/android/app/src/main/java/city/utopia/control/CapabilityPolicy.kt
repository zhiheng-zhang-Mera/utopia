package city.utopia.control
fun canInvokeCapability(connection: String, bridgeState: String, busy: Boolean): Boolean = connection == "ONLINE" && bridgeState == "AVAILABLE" && !busy
