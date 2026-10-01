package city.utopia.control.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import city.utopia.control.theme.Space
import city.utopia.control.theme.UtopiaColors

/**
 * UI-102 · semantic component layer.
 *
 * The workbook's step 3 asks to stop treating every surface as one generic `Panel`
 * and to build a small set of semantic components. Before this file the module had
 * exactly one container (`Panel`) plus ad-hoc `Card`s, and each screen re-invented
 * its own label/row/status chrome with literal colours.
 *
 * These components are deliberately few and named by MEANING, not by shape:
 * a status chip, a hero, a tool row, an activity row, a device surface, and — the
 * one that matters most for the hard rules — a collapsible technical-details
 * container so internal identifiers leave the default reading path without being
 * deleted.
 */

/** Wide-tracked uppercase micro-label: the HUD register's connective tissue. */
@Composable
fun UtLabel(text: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.tertiary) {
  Text(
    text = text.uppercase(),
    modifier = modifier,
    color = color,
    style = MaterialTheme.typography.labelSmall,
  )
}

/** A surface with the direction's cut corners, replacing ad-hoc rounded Cards. */
@Composable
fun UtPanel(
  modifier: Modifier = Modifier,
  accent: Boolean = false,
  content: @Composable () -> Unit,
) {
  Box(
    modifier
      .fillMaxWidth()
      .clip(MaterialTheme.shapes.large)
      .background(MaterialTheme.colorScheme.surface)
      .padding(Space.lg),
  ) {
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
      content()
    }
    if (accent) {
      Box(
        Modifier
          .align(Alignment.TopEnd)
          .width(14.dp)
          .height(2.dp)
          .background(MaterialTheme.colorScheme.primary),
      )
    }
  }
}

/** The headline fact of a screen: what is true right now, in one sentence. */
@Composable
fun HeroBlock(title: String, subtitle: String? = null, modifier: Modifier = Modifier) {
  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
    Text(title, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
    if (subtitle != null) {
      Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

/**
 * Status chip. States are mapped to theme ROLES rather than literal colours, so the
 * whole app changes with the theme and the mapping is stated once.
 *
 * The label never wraps and never breaks mid-word: a status is one token ("RECONNECTING"),
 * and a wrapped state name reads as a different state. At a width that cannot hold it the
 * tail is clipped, deliberately, rather than stacked one character per line.
 */
@Composable
fun StatusChip(state: String, modifier: Modifier = Modifier) {
  val (bg, fg) = when (state.uppercase()) {
    "ONLINE", "READY", "COMPLETED", "SUCCESS" -> MaterialTheme.colorScheme.primary to MaterialTheme.colorScheme.onPrimary
    "RUNNING", "RECONNECTING", "PENDING", "AWAITING_CONFIRMATION" -> MaterialTheme.colorScheme.secondaryContainer to MaterialTheme.colorScheme.onSecondaryContainer
    "FAILED", "ERROR", "CANCELLED" -> MaterialTheme.colorScheme.error to MaterialTheme.colorScheme.onError
    else -> MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
  }
  Box(
    modifier
      .clip(MaterialTheme.shapes.small)
      .background(bg)
      .padding(horizontal = Space.sm, vertical = 2.dp),
  ) {
    Text(
      state.uppercase(),
      style = MaterialTheme.typography.labelSmall,
      color = fg,
      maxLines = 1,
      softWrap = false,
      overflow = TextOverflow.Clip,
    )
  }
}

/** A row in a list of things you can act on. */
@Composable
fun ToolRow(
  title: String,
  detail: String?,
  trailing: (@Composable () -> Unit)? = null,
  modifier: Modifier = Modifier,
  onClick: (() -> Unit)? = null,
) {
  Row(
    modifier
      .fillMaxWidth()
      .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)
      .padding(vertical = Space.sm),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(Modifier.weight(1f)) {
      Text(title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
      if (!detail.isNullOrBlank()) {
        Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
    if (trailing != null) trailing()
  }
}

/** A row in the city's activity ledger. */
@Composable
fun ActivityRow(time: String, text: String, modifier: Modifier = Modifier) {
  Row(modifier.fillMaxWidth().padding(vertical = Space.xs), verticalAlignment = Alignment.CenterVertically) {
    Text(
      time,
      style = MaterialTheme.typography.bodySmall,
      fontFamily = FontFamily.Monospace,
      color = MaterialTheme.colorScheme.secondary,
      modifier = Modifier.width(52.dp),
    )
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
  }
}

/** A machine in the user's city. */
@Composable
fun DeviceSurface(
  name: String,
  stateLabel: String,
  lines: List<Pair<String, String>>,
  modifier: Modifier = Modifier,
  onClick: (() -> Unit)? = null,
) {
  UtPanel(modifier.then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Text(name, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
      Spacer(Modifier.weight(1f))
      StatusChip(stateLabel)
    }
    lines.forEach { (k, v) ->
      Row(Modifier.fillMaxWidth()) {
        Text(k, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.weight(1f))
        Text(v, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurface)
      }
    }
  }
}

/**
 * Collapsible technical detail — the mechanism that keeps internal identifiers
 * (task ids, routes, backendRef/resultRef, provenance, digests, api/schema versions)
 * off the default reading path while keeping them reachable.
 *
 * Collapsed by default on purpose. The rows are still rendered when expanded, so a
 * value that is genuinely needed is never deleted to make a screen look clean.
 */
@Composable
fun TechnicalDetails(
  rows: List<Pair<String, String>>,
  modifier: Modifier = Modifier,
  title: String = "运行详情",
) {
  val present = rows.filter { it.second.isNotBlank() }
  if (present.isEmpty()) return
  var open by remember { mutableStateOf(false) }
  Column(
    modifier
      .fillMaxWidth()
      .clip(MaterialTheme.shapes.small)
      .background(MaterialTheme.colorScheme.surfaceVariant)
      .clickable { open = !open }
      .padding(horizontal = Space.md, vertical = Space.sm),
    verticalArrangement = Arrangement.spacedBy(Space.xs),
  ) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      UtLabel(title, color = MaterialTheme.colorScheme.onSurfaceVariant)
      Spacer(Modifier.weight(1f))
      Text(if (open) "收起" else "展开", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (open) {
      HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
      present.forEach { (k, v) ->
        Column(Modifier.fillMaxWidth()) {
          Text(k, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          Text(
            v,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurface,
          )
        }
      }
    }
  }
}

/** A named empty/unavailable state, so screens stop inventing their own. */
@Composable
fun UtEmptyState(title: String, detail: String? = null, modifier: Modifier = Modifier) {
  Column(
    modifier
      .fillMaxWidth()
      .clip(MaterialTheme.shapes.large)
      .background(MaterialTheme.colorScheme.surface)
      .padding(Space.xl),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(Space.xs),
  ) {
    Text(title, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (detail != null) {
      Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

/** Inline feedback line with semantic colour, replacing per-screen error colours. */
@Composable
fun UtFeedback(text: String, kind: String = "ok", modifier: Modifier = Modifier) {
  if (text.isBlank()) return
  val color = when (kind) {
    "error" -> MaterialTheme.colorScheme.error
    "warn" -> UtopiaColors.Warn
    else -> MaterialTheme.colorScheme.primary
  }
  Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
    Box(Modifier.size(6.dp).background(color))
    Spacer(Modifier.width(Space.sm))
    Text(text, style = MaterialTheme.typography.bodySmall, color = color)
  }
}

/* ---------------------------------------------------------------------------------------
 * UI-102 · narrow-width / large-font fitting.
 *
 * Measured on a real emulator at `wm size 320x640` / `wm density 320` with
 * `font_scale = 1.5`: the five bar labels rendered as `Ho`, `As`, `Ro`, `De`, `Ac`, and the
 * header connection word wrapped one character per line down the screen as
 * `O`/`N`/`L`/`I`/`N`/`E`. Both were width starvation plus `Text`'s default
 * `softWrap = true` / `TextOverflow.Clip`, which silently eats the overflow: a truncated
 * label is still "present" for accessibility, so no `contentDescription` can rescue it.
 *
 * The mechanical fix in both places is the same sentence — **measure the text against the
 * width it actually has, then pick a size that fits, or degrade deliberately** — and it goes
 * through one helper so the two surfaces cannot drift apart again. See [chooseNavLabel] and
 * [largestLabelFitPx] in UiSizing.kt for the (pure, unit-tested) decision itself.
 * ------------------------------------------------------------------------------------- */

/** The bar's label size ladder, largest first: 11sp is this theme's `labelMedium`. */
private val NavLabelSpans = listOf(11, 10, 9)

/**
 * The largest size in [NavLabelSpans] at which [content] still fits [availablePx] on ONE
 * line, or `null` when even the smallest overflows.
 *
 * A single unbreakable line is the load-bearing part: the `Ho`/`As`/`Ro` defect was a
 * wrap that happened to be clipped, and a truncated label cannot be recovered by
 * `contentDescription` because the clipped text is not what a text matcher sees. So the
 * measurement is taken with `softWrap = false`, and the caller renders the size this
 * function returns — measured and rendered through the same `TextStyle` and the same
 * `TextMeasurer`, which is what makes the measurement an answer rather than an estimate.
 *
 * The FONT SCALE IS LOCKED at 1.0 for durations longer than an activity recreation while
 * the process is alive: `rememberTextMeasurer()` caches one `FontFamily.Resolver` and the
 * framework `fontScale` is read when it is created. A live `font_scale` change therefore
 * keeps the ladder's arithmetic correct while the resolver stays stale until the process is
 * recreated. This is a Compose Foundation 1.8 limitation, not a choice; see the UI-102
 * report. It cannot reintroduce the reported defect: the size ladder, the measurement and
 * the render all read `sp` values, so the only thing at stake is the exact step chosen, and
 * `softWrap = false` means a wrong step cannot wrap or clip a label mid-word.
 *
 * @return a size in `sp`, ready to hand to `Text(fontSize = ...)`.
 */
@Composable
private fun fittingLabelSizeSp(content: String, availablePx: Int): Int? {
  if (availablePx <= 0 || content.isEmpty()) return null
  val measurer = rememberTextMeasurer()
  val style: TextStyle = MaterialTheme.typography.labelMedium
  /* letterSpacing is zeroed: a wide-tracked label spends a narrow slot on tracking.
     fontSize is set explicitly in `sp` because this theme's `labelMedium` is 11sp and the
     ladder is expressed in sp; the ambient fontScale is applied by the measurer and must not
     be multiplied in again here. */
  val candidates = NavLabelSpans.map { span -> style.copy(fontSize = span.sp, letterSpacing = 0.sp) }
  val measured = remember(content, style, candidates, availablePx) {
    val constraint = Constraints(maxWidth = availablePx)
    candidates.map { candidate ->
      measurer.measure(content, candidate, maxLines = 1, softWrap = false, constraints = constraint).size.width
    }
  }
  return largestLabelFitPx(measured, availablePx)?.let { NavLabelSpans[it] }
}

/**
 * The five bottom-bar entries.
 *
 * Deliberately not `NavigationBar`. `NavigationBarItem` measures its label slot in a
 * duplicated pass and then clips the label to the layout's width, so a label that does not
 * fit comes back as `Ho` — the reported defect — and a width-aware workaround inside that
 * slot is defeated by the duplication. Owning the measure loop makes the label slot the
 * real, bounded width, which is what lets the step-down see the truth. One measure pass per
 * label, memoised per item width.
 *
 * Selection state, `Role.Tab`, a 48dp touch target and the selected indicator are all
 * reproduced, so the surface keeps its semantics; the `contentDescription` of an entry is
 * one string — the surface name — whether or not the label is drawn.
 */
@Composable
fun UtopiaNavigationBar(
  entries: List<Pair<String, ImageVector>>,
  selected: String,
  onSelect: (String) -> Unit,
  modifier: Modifier = Modifier,
) {
  Layout(
    modifier = modifier
      .fillMaxWidth()
      .background(MaterialTheme.colorScheme.surface)
      .padding(top = Space.sm, bottom = Space.md),
    content = {
      entries.forEach { (name, icon) ->
        val isSelected = name == selected
        Column(
          modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = isSelected, role = Role.Tab, onClick = { onSelect(name) })
            .padding(horizontal = Space.xs),
          horizontalAlignment = Alignment.CenterHorizontally,
        ) {
          val tint = if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
          val indicator = MaterialTheme.colorScheme.secondaryContainer
          Box(contentAlignment = Alignment.Center) {
            if (isSelected) {
              Canvas(Modifier.size(width = 64.dp, height = 32.dp)) {
                drawRoundRect(color = indicator, cornerRadius = CornerRadius(size.height / 2f))
              }
            }
            Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(24.dp), tint = tint)
          }
          Box(Modifier.padding(top = Space.xs)) {
            BoxWithConstraints {
              val available = constraints.maxWidth
              val sizeSp = if (available == Constraints.Infinity || available <= 0) null
              else fittingLabelSizeSp(name, available)
              if (sizeSp == null) {
                /* No size in the ladder fits, and (also) no bounded slot to measure against.
                   Keep the icon, and carry the full surface name as the accessibility name
                   rather than a `Ho` fragment: the label is not deleted, it moves to the
                   entry's name and returns the moment the slot is wide enough. */
                Box(Modifier.size(1.dp).clearAndSetSemantics { contentDescription = name })
              } else {
                Text(
                  text = name,
                  style = MaterialTheme.typography.labelMedium,
                  fontSize = sizeSp.sp,
                  letterSpacing = 0.sp,
                  maxLines = 1,
                  softWrap = false,
                  overflow = TextOverflow.Clip,
                  color = tint,
                )
              }
            }
          }
        }
      }
    },
  ) { measurables, constraints ->
    val count = measurables.size.coerceAtLeast(1)
    val slotWidth = (constraints.maxWidth / count).coerceAtLeast(1)
    val itemConstraints = constraints.copy(minWidth = slotWidth, maxWidth = slotWidth)
    val placeables = measurables.map { it.measure(itemConstraints) }
    val height = placeables.maxOfOrNull { it.height } ?: 0
    layout(constraints.maxWidth, height) {
      placeables.forEachIndexed { index, placeable -> placeable.placeRelative(index * slotWidth, 0) }
    }
  }
}

/**
 * The header's connection status.
 *
 * The status is preference-ordered ahead of the wordmark: an unreadable status means the
 * screen is lying about connectivity, a wordmark that has receded does not. So the status
 * gets the width it needs, the wordmark yields, and the overflow button keeps its own seat,
 * because `MainActivity` lays the header out as a horizontally scrollable row: at a width
 * where the three cannot coexist the row scrolls instead of squeezing one of them to a
 * single character of width. Nothing is dropped, and nothing is clipped mid-word.
 *
 * The chip itself is the shared [StatusChip], so the header reads in the same visual
 * language as the task and activity surfaces. It used to be an inline `Text` with
 * `fontSize = 12.sp` and no `maxLines`, which is what let it wrap per character; the chip
 * also carries the semantic state colour instead of the local lime/warn pair.
 */
@Composable
fun MeasuredStatusChip(status: String, modifier: Modifier = Modifier) {
  BoxWithConstraints(modifier) {
    /* Not a measurement game: the chip is simply told the width it really has, and its text
       never wraps. Clipping the tail of a status is recoverable; one glyph per line is not. */
    StatusChip(status, modifier.widthIn(max = with(LocalDensity.current) { constraints.maxWidth.toDp() }))
  }
}
