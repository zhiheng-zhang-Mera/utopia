package city.utopia.control

/** Fail-closed seam for observed activity lifecycle; no caller visibility setter. */
class PcfForegroundState {
 private val resumed=java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Any,Boolean>())
 @Synchronized fun resumed(activity:Any) { resumed.add(activity) }
 @Synchronized fun paused(activity:Any) { resumed.remove(activity) }
 @Synchronized fun destroyed(activity:Any) { resumed.remove(activity) }
 @Synchronized fun clear() { resumed.clear() }
 @Synchronized fun visible()=resumed.isNotEmpty()
}
