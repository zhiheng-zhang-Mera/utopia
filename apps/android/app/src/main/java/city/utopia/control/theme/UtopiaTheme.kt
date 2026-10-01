package city.utopia.control.theme

import androidx.compose.foundation.shape.CutCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * UI-102 · Utopia design system for Android.
 *
 * Before this file the app had NO theme file at all: a single inline
 * `lightColorScheme(primary = Ink, secondary = Moss, background = ...)` at
 * MainActivity.kt:27 set three of roughly thirty M3 colour roles, so every other
 * role (tertiary, error, surface, containers) silently rendered the Material
 * baseline purple, typography and shapes were pure M3 defaults, and there was no
 * dark theme.
 *
 * This is the Android expression of the direction the Owner adopted in UI-000
 * ("C2"): a deep violet-stage HUD with lime signal, hologram cyan secondary and
 * clipped (cut) corners. Android stays Compose Material 3 — the register is carried
 * by colour, type and shape, exactly as the Rooms port (UI-103) does.
 */
object UtopiaColors {
  val Void = Color(0xFF08070F)
  val Stage = Color(0xFF0F0D1A)
  val Layer1 = Color(0xFF14121F)
  val Layer2 = Color(0xFF1B1830)
  val Layer3 = Color(0xFF241F3D)
  val Line = Color(0x428B5CF6)      // violet @ 26%
  val LineStrong = Color(0x808B5CF6) // violet @ 50%
  val Ink = Color(0xFFF2EEFF)
  val Ink2 = Color(0xFFA99FC6)
  /** Tertiary text. Was #6F6788, which failed WCAG AA on every panel it was used
   *  on (3.26:1) — the same defect Mech repaired in the UI-000 Web revision. This
   *  value is the AA-safe one already verified there. */
  val Ink3 = Color(0xFF8B82A8)
  val Violet = Color(0xFF8B5CF6)
  val VioletDim = Color(0xFF3D2580)
  val Lime = Color(0xFFC6F24E)
  val Cyan = Color(0xFF5EE7FF)
  val Warn = Color(0xFFFFB454)
  val Danger = Color(0xFFFF6B8A)
}

private val UtopiaScheme = darkColorScheme(
  primary = UtopiaColors.Lime,
  onPrimary = UtopiaColors.Void,
  primaryContainer = UtopiaColors.VioletDim,
  onPrimaryContainer = UtopiaColors.Ink,
  secondary = UtopiaColors.Violet,
  onSecondary = Color.White,
  secondaryContainer = UtopiaColors.Layer3,
  onSecondaryContainer = UtopiaColors.Ink,
  tertiary = UtopiaColors.Cyan,
  onTertiary = UtopiaColors.Void,
  background = UtopiaColors.Void,
  onBackground = UtopiaColors.Ink,
  surface = UtopiaColors.Layer1,
  onSurface = UtopiaColors.Ink,
  surfaceVariant = UtopiaColors.Layer2,
  onSurfaceVariant = UtopiaColors.Ink2,
  surfaceContainer = UtopiaColors.Layer2,
  surfaceContainerHigh = UtopiaColors.Layer3,
  outline = UtopiaColors.LineStrong,
  outlineVariant = UtopiaColors.Line,
  error = UtopiaColors.Danger,
  onError = UtopiaColors.Void,
  scrim = Color(0xCC08070F),
)

/** The HUD gesture: cut corners, never rounded card stacks (UI-000 hard rule). */
private val UtopiaShapes = Shapes(
  extraSmall = CutCornerShape(4.dp),
  small = CutCornerShape(7.dp),
  medium = CutCornerShape(10.dp),
  large = CutCornerShape(14.dp),
  extraLarge = CutCornerShape(18.dp),
)

private val UtopiaTypography = Typography(
  displaySmall = TextStyle(fontSize = 34.sp, lineHeight = 38.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.5).sp),
  headlineMedium = TextStyle(fontSize = 26.sp, lineHeight = 30.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp),
  titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 24.sp, fontWeight = FontWeight.Bold),
  titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
  bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 21.sp),
  bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 19.sp),
  bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 17.sp),
  labelLarge = TextStyle(fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold),
  labelMedium = TextStyle(fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = 0.8.sp, fontWeight = FontWeight.SemiBold),
  /* HUD micro-labels: small, wide-tracked, uppercase by convention of the caller */
  labelSmall = TextStyle(fontSize = 10.sp, lineHeight = 13.sp, letterSpacing = 1.6.sp, fontWeight = FontWeight.Bold),
)

/** Spacing scale, so screens stop hard-coding arbitrary dp values. */
object Space {
  val xs = 4.dp
  val sm = 8.dp
  val md = 12.dp
  val lg = 16.dp
  val xl = 24.dp
  val xxl = 32.dp
}

@Composable
fun UtopiaTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = UtopiaScheme,
    shapes = UtopiaShapes,
    typography = UtopiaTypography,
    content = content,
  )
}

/** Layout direction is irrelevant here but keeps the import honest for callers. */
internal val HeroLayoutDirection: LayoutDirection = LayoutDirection.Ltr
