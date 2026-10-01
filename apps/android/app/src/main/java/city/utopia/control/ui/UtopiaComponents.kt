package city.utopia.control.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
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
    Text(state.uppercase(), style = MaterialTheme.typography.labelSmall, color = fg)
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
