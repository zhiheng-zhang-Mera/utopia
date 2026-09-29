package city.utopia.control

/** Fences queued work across a stop/restart, and permanently after disposal. */
class CallbackFence {
 private var generation=0L
 private var closed=false
 @Synchronized fun ticket():Long? = if(closed) null else generation
 @Synchronized fun accepts(ticket:Long):Boolean = !closed && generation==ticket
 @Synchronized fun invalidate() { generation++ }
 @Synchronized fun close() { closed=true; generation++ }
}
