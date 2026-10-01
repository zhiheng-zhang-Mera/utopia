package city.utopia.control.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * UI-102 · Utopia icon language.
 *
 * The Android shell previously used Unicode geometry characters as its icon set
 * (MainActivity.kt:51 drew "◈ ❯ ▦ ≣ ◇ ◉ ▤ ≋ ⚙" as Text). UI-000's hard rules
 * forbid that, and it is also why the labels had to fight the glyphs for space in a
 * nine-item bar.
 *
 * These are real `ImageVector`s: 24×24 grid, stroked with `SolidColor(Color.Black)`
 * so `Icon()` tints them with `LocalContentColor`, and they scale to the type
 * instead of being fixed-size text.
 */
private fun icon(name: String, block: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit): ImageVector =
  ImageVector.Builder(
    name = name,
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
  ).path(
    stroke = SolidColor(Color.Black),
    strokeLineWidth = 1.7f,
    strokeLineCap = StrokeCap.Round,
    strokeLineJoin = StrokeJoin.Round,
    fill = null,
    pathBuilder = block,
  ).build()

object UtopiaIcons {
  /** Home — a roof over a floor line. */
  val Home: ImageVector = icon("Utopia.Home") {
    moveTo(3.5f, 10.5f); lineTo(12f, 3.8f); lineTo(20.5f, 10.5f)
    moveTo(5.5f, 9.6f); verticalLineTo(20f); horizontalLineTo(18.5f); verticalLineTo(9.6f)
    moveTo(10f, 20f); verticalLineTo(14.5f); horizontalLineTo(14f); verticalLineTo(20f)
  }

  /** Ask / Do — a speech surface with the intent marker. */
  val Ask: ImageVector = icon("Utopia.Ask") {
    moveTo(20.5f, 12.5f)
    curveTo(20.5f, 16.4f, 16.7f, 19.5f, 12f, 19.5f)
    curveTo(10.7f, 19.5f, 9.4f, 19.2f, 8.3f, 18.7f)
    lineTo(4f, 20.3f); lineTo(5.4f, 16.4f)
    curveTo(4.5f, 15.3f, 3.5f, 14f, 3.5f, 12.5f)
    curveTo(3.5f, 8.6f, 7.3f, 5.5f, 12f, 5.5f)
    curveTo(16.7f, 5.5f, 20.5f, 8.6f, 20.5f, 12.5f)
    close()
    moveTo(8.6f, 12.4f); lineTo(8.61f, 12.4f)
    moveTo(12f, 12.4f); lineTo(12.01f, 12.4f)
    moveTo(15.4f, 12.4f); lineTo(15.41f, 12.4f)
  }

  /** Tools / Rooms — two slider rows, the "local capability" idea. */
  val Tools: ImageVector = icon("Utopia.Tools") {
    moveTo(3.5f, 8f); lineTo(20.5f, 8f)
    moveTo(3.5f, 16f); lineTo(20.5f, 16f)
    moveTo(9f, 8f); moveTo(9f, 5.6f); lineTo(9f, 10.4f)
    moveTo(15f, 16f); moveTo(15f, 13.6f); lineTo(15f, 18.4f)
  }

  /** Devices — a screen plus a handheld. */
  val Devices: ImageVector = icon("Utopia.Devices") {
    moveTo(3.5f, 6.5f); lineTo(14.5f, 6.5f); lineTo(14.5f, 15f); lineTo(3.5f, 15f); close()
    moveTo(7f, 18.5f); lineTo(11f, 18.5f)
    moveTo(9f, 15f); lineTo(9f, 18.5f)
    moveTo(17.5f, 9.5f); lineTo(20.5f, 9.5f); lineTo(20.5f, 19f); lineTo(17.5f, 19f); close()
  }

  /** Activity — a signal trace. */
  val Activity: ImageVector = icon("Utopia.Activity") {
    moveTo(3f, 12.5f); lineTo(7f, 12.5f); lineTo(9.5f, 6.5f)
    lineTo(13.5f, 18f); lineTo(16f, 12.5f); lineTo(21f, 12.5f)
  }

  /** Services — a capability node. */
  val Services: ImageVector = icon("Utopia.Services") {
    moveTo(12f, 3.8f); lineTo(20f, 8.2f); lineTo(20f, 15.8f); lineTo(12f, 20.2f); lineTo(4f, 15.8f); lineTo(4f, 8.2f); close()
    moveTo(12f, 12f); lineTo(12f, 20.2f)
    moveTo(4f, 8.2f); lineTo(12f, 12f); lineTo(20f, 8.2f)
  }

  /** Tasks — a checklist. */
  val Tasks: ImageVector = icon("Utopia.Tasks") {
    moveTo(4f, 6.5f); lineTo(6f, 8.5f); lineTo(9.5f, 5f)
    moveTo(4f, 17.5f); lineTo(6f, 19.5f); lineTo(9.5f, 16f)
    moveTo(12.5f, 7f); lineTo(20f, 7f)
    moveTo(12.5f, 18f); lineTo(20f, 18f)
  }

  /** Actions — a routed request. */
  val Actions: ImageVector = icon("Utopia.Actions") {
    moveTo(5f, 5f); verticalLineTo(14f)
    curveTo(5f, 16.2f, 6.8f, 18f, 9f, 18f); lineTo(19f, 18f)
    moveTo(15.5f, 14.5f); lineTo(19f, 18f); lineTo(15.5f, 21.5f)
    moveTo(5f, 5f); moveTo(5f, 3.2f); lineTo(5f, 6.8f)
  }

  /** Settings — a control dial. */
  val Settings: ImageVector = icon("Utopia.Settings") {
    moveTo(12f, 9f)
    curveTo(13.7f, 9f, 15f, 10.3f, 15f, 12f)
    curveTo(15f, 13.7f, 13.7f, 15f, 12f, 15f)
    curveTo(10.3f, 15f, 9f, 13.7f, 9f, 12f)
    curveTo(9f, 10.3f, 10.3f, 9f, 12f, 9f)
    close()
    moveTo(12f, 3.5f); lineTo(12f, 6f)
    moveTo(12f, 18f); lineTo(12f, 20.5f)
    moveTo(4.6f, 7.6f); lineTo(6.7f, 8.8f)
    moveTo(17.3f, 15.2f); lineTo(19.4f, 16.4f)
    moveTo(4.6f, 16.4f); lineTo(6.7f, 15.2f)
    moveTo(17.3f, 8.8f); lineTo(19.4f, 7.6f)
  }

  /** More — the advanced surfaces live behind this, not in the bar. */
  val More: ImageVector = icon("Utopia.More") {
    moveTo(6f, 12f); lineTo(6.01f, 12f)
    moveTo(12f, 12f); lineTo(12.01f, 12f)
    moveTo(18f, 12f); lineTo(18.01f, 12f)
  }
}
