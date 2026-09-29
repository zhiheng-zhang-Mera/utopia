package city.utopia.control

/** Bounded search, not QR-position tracking. Return to wide view to recover cropped codes. */
internal fun scanZoomIndex(ratios:List<Int>?, maxIndex:Int, step:Int):Int? {
 val target=intArrayOf(100,150,200)[Math.floorMod(step,3)]
 return ratios?.indices?.filter { it<=maxIndex && ratios[it] in 100..target }
  ?.maxByOrNull { ratios[it] }
}
