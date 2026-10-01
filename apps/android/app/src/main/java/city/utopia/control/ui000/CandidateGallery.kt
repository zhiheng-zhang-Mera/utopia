package city.utopia.control.ui000

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * UI-000 · Android representative screens for the three visual directions.
 *
 * This Activity is a TEMPORARY candidate surface for the UI-000 Owner gate. It is
 * additive: MainActivity is untouched, no existing screen changes, and the
 * Activity is not exported and has no intent-filter, so nothing in the shipping
 * product can reach it.
 *
 * It exists because the current Android surface has the same problems as Web:
 * nine first-level NavigationBar items, Unicode geometry characters used as icons
 * (◈ ❯ ▦ ≣ ◇ ◉ ▤ ≋ ⚙ at MainActivity.kt:51), no theme file, no dark theme, and
 * three of ~30 M3 colour roles defined. Each candidate below therefore shows a
 * representative HOME screen with its own navigation model, icon set (drawn with
 * Canvas — never a glyph) and typography.
 *
 * Launch:
 *   adb shell am start -n city.utopia.control/.ui000.CandidateGalleryActivity \
 *     --es candidate a
 *
 * Delete together with apps/web/candidates/ when the direction is chosen.
 */
class CandidateGalleryActivity : ComponentActivity() {
  /* A re-launch (adb `am start`, rotation, task reuse) must switch direction
     rather than silently keep the first one rendered. */
  private val candidateId = mutableStateOf("a")

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    candidateId.value = intent?.getStringExtra("candidate") ?: "a"
    setContent {
      when (candidateId.value) {
        "b" -> AtlasTheme { AtlasHome() }
        "c" -> PrismTheme { PrismHome() }
        else -> HaloTheme { HaloHome() }
      }
    }
  }

  override fun onNewIntent(intent: android.content.Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    candidateId.value = intent.getStringExtra("candidate") ?: "a"
  }
}

/* ------------------------------------------------------------------ demo fact model
 * Mirrors apps/web/candidates/shared/facts.js DEMO so the three directions render
 * the same functional facts on Android as they do on Web.
 */
private object Demo {
  const val DEVICE = "Alien-PC"
  const val ONLINE = true
  const val CPU = "12.4%"
  const val MEMORY = "12.0 GB / 32.0 GB"
  const val DISK = "384.0 GB / 954.0 GB"
  const val UPTIME = "53 h"
  const val ROOMS = 10
  const val RUNNING = 1
  const val SYNC = "20:24"
  val EVENTS = listOf(
    "20:19" to "一件事完成了",
    "20:23" to "一件事正在推进",
    "20:23" to "设备心跳",
  )
  val ROOM_NAMES = listOf(
    "Knowledge Room" to "本地知识室",
    "Checklist Room" to "清单室",
    "Focus Room" to "专注室",
  )
}

/* ------------------------------------------------------------------ icon system
 * Real vector icons drawn with Canvas. The product currently uses Unicode
 * geometry characters as icons; UI-000 forbids that, so candidates draw shapes.
 */
private enum class Ui000Icon { Home, Ask, Tools, Devices, Activity, Check, Room }

@Composable
private fun DrawnIcon(icon: Ui000Icon, color: Color, size: Int = 20) {
  Canvas(Modifier.size(size.dp)) {
    val w = this.size.width
    val h = this.size.height
    val s = Stroke(width = w * 0.09f, cap = StrokeCap.Round)
    when (icon) {
      Ui000Icon.Home -> {
        val roof = Path().apply {
          moveTo(w * 0.16f, h * 0.46f); lineTo(w * 0.5f, h * 0.18f); lineTo(w * 0.84f, h * 0.46f)
        }
        drawPath(roof, color, style = s)
        val body = Path().apply {
          moveTo(w * 0.26f, h * 0.42f); lineTo(w * 0.26f, h * 0.84f); lineTo(w * 0.74f, h * 0.84f); lineTo(w * 0.74f, h * 0.42f)
        }
        drawPath(body, color, style = s)
      }
      Ui000Icon.Ask -> {
        val bubble = Path().apply {
          moveTo(w * 0.18f, h * 0.24f); lineTo(w * 0.82f, h * 0.24f); lineTo(w * 0.82f, h * 0.66f)
          lineTo(w * 0.44f, h * 0.66f); lineTo(w * 0.28f, h * 0.84f); lineTo(w * 0.28f, h * 0.66f); lineTo(w * 0.18f, h * 0.66f)
          close()
        }
        drawPath(bubble, color, style = s)
      }
      Ui000Icon.Tools -> {
        drawLine(color, Offset(w * 0.18f, h * 0.34f), Offset(w * 0.82f, h * 0.34f), strokeWidth = w * 0.09f, cap = StrokeCap.Round)
        drawCircle(color, radius = w * 0.13f, center = Offset(w * 0.38f, h * 0.34f))
        drawLine(color, Offset(w * 0.18f, h * 0.68f), Offset(w * 0.82f, h * 0.68f), strokeWidth = w * 0.09f, cap = StrokeCap.Round)
        drawCircle(color, radius = w * 0.13f, center = Offset(w * 0.64f, h * 0.68f))
      }
      Ui000Icon.Devices -> {
        val screen = Path().apply {
          moveTo(w * 0.14f, h * 0.26f); lineTo(w * 0.68f, h * 0.26f); lineTo(w * 0.68f, h * 0.66f); lineTo(w * 0.14f, h * 0.66f); close()
        }
        drawPath(screen, color, style = s)
        val phone = Path().apply {
          moveTo(w * 0.74f, h * 0.42f); lineTo(w * 0.9f, h * 0.42f); lineTo(w * 0.9f, h * 0.88f); lineTo(w * 0.74f, h * 0.88f); close()
        }
        drawPath(phone, color, style = s)
      }
      Ui000Icon.Activity -> {
        val pulse = Path().apply {
          moveTo(w * 0.1f, h * 0.55f); lineTo(w * 0.32f, h * 0.55f); lineTo(w * 0.42f, h * 0.24f)
          lineTo(w * 0.56f, h * 0.82f); lineTo(w * 0.66f, h * 0.5f); lineTo(w * 0.9f, h * 0.5f)
        }
        drawPath(pulse, color, style = s)
      }
      Ui000Icon.Check -> {
        val tick = Path().apply {
          moveTo(w * 0.2f, h * 0.54f); lineTo(w * 0.42f, h * 0.76f); lineTo(w * 0.8f, h * 0.26f)
        }
        drawPath(tick, color, style = s)
      }
      Ui000Icon.Room -> {
        val door = Path().apply {
          moveTo(w * 0.26f, h * 0.88f); lineTo(w * 0.26f, h * 0.14f); lineTo(w * 0.74f, h * 0.14f); lineTo(w * 0.74f, h * 0.88f)
        }
        drawPath(door, color, style = s)
        drawCircle(color, radius = w * 0.06f, center = Offset(w * 0.62f, h * 0.52f))
      }
    }
  }
}

/* ------------------------------------------------------------------ Candidate A — Halo */

private val HaloPaper = Color(0xFFFBF8F3)
private val HaloInk = Color(0xFF241F1A)
private val HaloInk2 = Color(0xFF5C5347)
private val HaloInk3 = Color(0xFF8B8073)
private val HaloRule = Color(0xFFE3DACB)
private val HaloAccent = Color(0xFFB4502A)

@Composable
private fun HaloTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = lightColorScheme(
      primary = HaloAccent, onPrimary = Color.White,
      secondary = HaloInk2, onSecondary = Color.White,
      background = HaloPaper, onBackground = HaloInk,
      surface = HaloPaper, onSurface = HaloInk,
      outline = HaloRule, outlineVariant = HaloRule,
      error = Color(0xFFB4372F), onError = Color.White,
    ),
  ) { Surface(Modifier.fillMaxSize(), color = HaloPaper) { content() } }
}

@Composable
private fun HaloHome() {
  Column(Modifier.fillMaxSize()) {
    LazyColumn(
      Modifier.weight(1f).fillMaxWidth(),
      contentPadding = PaddingValues(horizontal = 24.dp, vertical = 28.dp),
      verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
      item {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Text("Utopia", fontSize = 20.sp, color = HaloInk, fontWeight = FontWeight.SemiBold)
          Spacer(Modifier.weight(1f))
          Text("${Demo.SYNC} · 刚刚同步", fontSize = 12.sp, color = HaloInk3)
        }
        Spacer(Modifier.height(22.dp))
        Text(
          "现在有 ${Demo.RUNNING} 件事在做，1 台设备在线。",
          fontSize = 28.sp, lineHeight = 36.sp, color = HaloInk, fontWeight = FontWeight.Medium,
        )
        Spacer(Modifier.height(10.dp))
        Text("这里是你的城市。下面是你现在真正需要知道的三件事。", fontSize = 14.sp, color = HaloInk2)
        Spacer(Modifier.height(26.dp))
      }
      item { HaloFact("设备", "${Demo.DEVICE} · 在线") }
      item { HaloFact("算力", "CPU ${Demo.CPU} · 内存 ${Demo.MEMORY}") }
      item { HaloFact("工具", "${Demo.ROOMS} 个本地房间已就绪") }
      item { HaloFact("进行中", "CHECKPOINT_DEMO") }
      item {
        Spacer(Modifier.height(26.dp))
        Text("最近发生", fontSize = 18.sp, color = HaloInk, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(10.dp))
      }
      items(Demo.EVENTS.size) { index ->
        val (time, text) = Demo.EVENTS[index]
        Row(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(time, fontSize = 12.sp, color = HaloInk3, modifier = Modifier.width(46.dp))
          Text(text, fontSize = 15.sp, color = HaloInk)
        }
        HorizontalDivider(color = HaloRule)
      }
    }
    HaloOmnibox()
    HaloNav()
  }
}

@Composable
private fun HaloFact(label: String, value: String) {
  Row(Modifier.fillMaxWidth().padding(vertical = 13.dp)) {
    Text(label, fontSize = 13.sp, color = HaloInk3, modifier = Modifier.width(64.dp))
    Text(value, fontSize = 15.sp, color = HaloInk)
  }
  HorizontalDivider(color = HaloRule)
}

@Composable
private fun HaloOmnibox() {
  Surface(
    Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 10.dp),
    color = Color.White,
    shape = RoundedCornerShape(14.dp),
    border = androidx.compose.foundation.BorderStroke(1.dp, HaloRule),
  ) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("说你想做什么…", fontSize = 15.sp, color = HaloInk3, modifier = Modifier.weight(1f))
        Surface(color = HaloAccent, shape = RoundedCornerShape(8.dp)) {
          Text("去做", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 18.dp, vertical = 8.dp))
        }
      }
      Spacer(Modifier.height(6.dp))
      Text("本地工具、City 能力或 City 任务，由 Gateway 决定去向。", fontSize = 11.sp, color = HaloInk3)
    }
  }
}

@Composable
private fun HaloNav() {
  val items = listOf(Ui000Icon.Home to "首页", Ui000Icon.Ask to "对话", Ui000Icon.Tools to "工具", Ui000Icon.Devices to "设备", Ui000Icon.Activity to "动态")
  Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
    items.forEachIndexed { index, (icon, label) ->
      val on = index == 0
      Column(horizontalAlignment = Alignment.CenterHorizontally) {
        DrawnIcon(icon, if (on) HaloAccent else HaloInk3, 20)
        Spacer(Modifier.height(3.dp))
        Text(label, fontSize = 11.sp, color = if (on) HaloAccent else HaloInk3)
      }
    }
  }
}

/* ------------------------------------------------------------------ Candidate B — Atlas */

private val AtlasBg = Color(0xFFF6F7F6)
private val AtlasSurface = Color.White
private val AtlasSurface2 = Color(0xFFEEF0EE)
private val AtlasInk = Color(0xFF0F1513)
private val AtlasInk2 = Color(0xFF4A534F)
private val AtlasInk3 = Color(0xFF7E8884)
private val AtlasLine = Color(0xFFDDE1DD)
private val AtlasAccent = Color(0xFF1F4ED8)
private val AtlasOk = Color(0xFF17703C)

@Composable
private fun AtlasTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = lightColorScheme(
      primary = AtlasAccent, onPrimary = Color.White,
      secondary = AtlasInk2, onSecondary = Color.White,
      background = AtlasBg, onBackground = AtlasInk,
      surface = AtlasSurface, onSurface = AtlasInk,
      surfaceVariant = AtlasSurface2, onSurfaceVariant = AtlasInk2,
      outline = AtlasLine, outlineVariant = AtlasLine,
      error = Color(0xFFA52020), onError = Color.White,
    ),
  ) { Surface(Modifier.fillMaxSize(), color = AtlasBg) { content() } }
}

@Composable
private fun AtlasHome() {
  Column(Modifier.fillMaxSize()) {
    AtlasSegmentBar()
    LazyColumn(
      Modifier.weight(1f).fillMaxWidth(),
      contentPadding = PaddingValues(horizontal = 18.dp, vertical = 16.dp),
      verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
      item {
        Text("现在", fontSize = 20.sp, color = AtlasInk, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(3.dp))
        Text("${Demo.SYNC} 快照 · 1 台机器在线 · ${Demo.ROOMS} 个工具就绪", fontSize = 12.sp, color = AtlasInk3, fontFamily = FontFamily.Monospace)
        Spacer(Modifier.height(12.dp))
        HorizontalDivider(color = AtlasLine)
      }
      item { AtlasSectionLabel("机器") }
      item {
        AtlasRow("名称", Demo.DEVICE, trailing = { AtlasTag("RUNNING", AtlasAccent) })
        AtlasRow("负载", "CPU ${Demo.CPU}", trailing = { AtlasBar(0.124f) })
        AtlasRow("内存", Demo.MEMORY, trailing = { AtlasBar(0.375f) })
        AtlasRow("磁盘", Demo.DISK, trailing = { AtlasBar(0.4f) })
        AtlasRow("开机", Demo.UPTIME, trailing = {})
      }
      item { Spacer(Modifier.height(14.dp)); AtlasSectionLabel("进行中") }
      item {
        AtlasRow("CHECKPOINT_DEMO", "45%", trailing = { AtlasBar(0.45f) })
        Spacer(Modifier.height(14.dp))
        AtlasSectionLabel("可以做的事")
        Spacer(Modifier.height(8.dp))
        Text("用一句话交代一件事", fontSize = 14.sp, color = AtlasAccent)
        Spacer(Modifier.height(6.dp))
        Text("打开 ${Demo.ROOMS} 个工具", fontSize = 14.sp, color = AtlasAccent)
        Spacer(Modifier.height(14.dp))
        AtlasSectionLabel("最近记录")
      }
      items(Demo.EVENTS.size) { index ->
        val (time, text) = Demo.EVENTS[index]
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(time, fontSize = 12.sp, color = AtlasInk3, fontFamily = FontFamily.Monospace, modifier = Modifier.width(52.dp))
          Text(text, fontSize = 13.sp, color = AtlasInk, modifier = Modifier.weight(1f))
          Text("检查器", fontSize = 12.sp, color = AtlasAccent)
        }
        HorizontalDivider(color = AtlasLine)
      }
      item {
        Spacer(Modifier.height(12.dp))
        Text("协议与端点信息在「设置 · 检查器」中。", fontSize = 12.sp, color = AtlasInk3)
      }
    }
  }
}

@Composable
private fun AtlasSegmentBar() {
  val items = listOf("现在", "工具", "机器", "作业", "记录")
  Column {
    Row(Modifier.fillMaxWidth().background(AtlasSurface).padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
      Text("U", fontSize = 13.sp, color = Color.White, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold,
        modifier = Modifier.background(AtlasInk, RoundedCornerShape(2.dp)).padding(horizontal = 7.dp, vertical = 3.dp))
      Spacer(Modifier.width(12.dp))
      Text("UTOPIA", fontSize = 12.sp, color = AtlasInk, fontWeight = FontWeight.Bold)
      Spacer(Modifier.weight(1f))
      Text("已连接", fontSize = 11.sp, color = AtlasOk, fontFamily = FontFamily.Monospace)
    }
    HorizontalDivider(color = AtlasLine)
    Row(Modifier.fillMaxWidth().background(AtlasSurface).padding(horizontal = 10.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
      items.forEachIndexed { index, label ->
        val on = index == 0
        Text(
          label, fontSize = 12.sp,
          color = if (on) AtlasAccent else AtlasInk3,
          fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
          modifier = Modifier.background(if (on) Color(0xFFE3E9FD) else Color.Transparent, RoundedCornerShape(2.dp)).padding(horizontal = 10.dp, vertical = 5.dp),
        )
      }
    }
    HorizontalDivider(color = AtlasLine)
  }
}

@Composable
private fun AtlasSectionLabel(text: String) {
  Text(text, fontSize = 10.sp, color = AtlasInk3, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp, modifier = Modifier.padding(top = 12.dp, bottom = 6.dp))
}

@Composable
private fun AtlasRow(label: String, value: String, trailing: @Composable () -> Unit) {
  Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(label, fontSize = 10.sp, color = AtlasInk3, letterSpacing = 1.2.sp, modifier = Modifier.width(48.dp))
    Text(value, fontSize = 13.sp, color = AtlasInk, modifier = Modifier.weight(1f))
    trailing()
  }
  HorizontalDivider(color = AtlasLine)
}

@Composable
private fun AtlasTag(text: String, color: Color) {
  Text(text, fontSize = 10.sp, color = color, fontFamily = FontFamily.Monospace,
    modifier = Modifier.background(color.copy(alpha = 0.08f), RoundedCornerShape(2.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
}

@Composable
private fun AtlasBar(fraction: Float) {
  Canvas(Modifier.width(64.dp).height(6.dp)) {
    drawRect(AtlasSurface2)
    drawRect(AtlasAccent, size = androidx.compose.ui.geometry.Size(size.width * fraction, size.height))
  }
}

/* ------------------------------------------------------------------ Candidate C — Prism */

private val PrismVoid = Color(0xFF0A0912)
private val PrismLayer1 = Color(0xFF15131F)
private val PrismLayer2 = Color(0xFF1D1A2B)
private val PrismLayer3 = Color(0xFF2F2848)
private val PrismInk = Color(0xFFF4F0FF)
private val PrismInk2 = Color(0xFFB9B0D6)
private val PrismInk3 = Color(0xFF7D7499)
private val PrismViolet = Color(0xFF8B5CF6)
private val PrismLime = Color(0xFFC6F24E)

@Composable
private fun PrismTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = darkColorScheme(
      primary = PrismViolet, onPrimary = Color.White,
      secondary = PrismLime, onSecondary = PrismVoid,
      background = PrismVoid, onBackground = PrismInk,
      surface = PrismLayer1, onSurface = PrismInk,
      surfaceVariant = PrismLayer2, onSurfaceVariant = PrismInk2,
      outline = PrismLayer3, outlineVariant = PrismLayer3,
      error = Color(0xFFFF6B8A), onError = PrismVoid,
    ),
    typography = Typography(
      displaySmall = TextStyle(fontSize = 40.sp, lineHeight = 44.sp, fontWeight = FontWeight.Bold, letterSpacing = (-1).sp),
      titleLarge = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Bold),
    ),
  ) { Surface(Modifier.fillMaxSize(), color = PrismVoid) { content() } }
}

@Composable
private fun PrismHome() {
  Box(
    Modifier.fillMaxSize().background(
      Brush.radialGradient(listOf(PrismViolet.copy(alpha = 0.28f), PrismVoid), radius = 900f)
    )
  ) {
    Column(Modifier.fillMaxSize()) {
      LazyColumn(
        Modifier.weight(1f).fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 22.dp, vertical = 26.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        item {
          Text("NOW · ${Demo.SYNC}", fontSize = 10.sp, color = PrismViolet, fontWeight = FontWeight.Bold, letterSpacing = 3.sp)
          Spacer(Modifier.height(12.dp))
          Text("你的城市", fontSize = 40.sp, lineHeight = 44.sp, color = PrismInk, fontWeight = FontWeight.Bold)
          Text("现在是这样。", fontSize = 40.sp, lineHeight = 44.sp, color = PrismLime, fontWeight = FontWeight.Bold)
        }
        item {
          PrismPanel(hero = true) {
            Text("正在发生", fontSize = 10.sp, color = PrismInk3, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
            Spacer(Modifier.height(8.dp))
            Text("${Demo.RUNNING} 件事在做", fontSize = 30.sp, color = PrismInk, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(6.dp))
            Text("最近一次同步 ${Demo.SYNC}", fontSize = 13.sp, color = PrismInk2)
          }
        }
        item {
          Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            PrismPanel(Modifier.weight(1f)) {
              Text("设备", fontSize = 10.sp, color = PrismInk3, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
              Spacer(Modifier.height(6.dp))
              Text(Demo.DEVICE, fontSize = 20.sp, color = PrismInk, fontWeight = FontWeight.Bold)
              Spacer(Modifier.height(4.dp))
              Text("CPU ${Demo.CPU}", fontSize = 12.sp, color = PrismInk2)
            }
            PrismPanel(Modifier.weight(1f)) {
              Text("随时可用", fontSize = 10.sp, color = PrismInk3, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
              Spacer(Modifier.height(6.dp))
              Text("${Demo.ROOMS} 个工具", fontSize = 20.sp, color = PrismInk, fontWeight = FontWeight.Bold)
              Spacer(Modifier.height(4.dp))
              Text("本地房间", fontSize = 12.sp, color = PrismInk2)
            }
          }
        }
        item {
          PrismPanel {
            Text("最近动态", fontSize = 10.sp, color = PrismInk3, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
            Spacer(Modifier.height(10.dp))
            Demo.EVENTS.forEach { (time, text) ->
              Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(time, fontSize = 12.sp, color = PrismViolet, fontFamily = FontFamily.Monospace, modifier = Modifier.width(52.dp))
                Text(text, fontSize = 15.sp, color = PrismInk)
              }
            }
          }
        }
        item {
          Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Demo.ROOM_NAMES.forEach { (name, zh) ->
              PrismPoster(name, zh, Modifier.weight(1f))
            }
          }
        }
      }
      PrismSpotlight()
      PrismNav()
    }
  }
}

@Composable
private fun PrismPanel(modifier: Modifier = Modifier, hero: Boolean = false, content: @Composable () -> Unit) {
  Surface(
    modifier.fillMaxWidth(),
    color = if (hero) PrismLayer3 else PrismLayer1,
    shape = RoundedCornerShape(22.dp),
  ) { Column(Modifier.padding(20.dp)) { content() } }
}

@Composable
private fun PrismPoster(name: String, zh: String, modifier: Modifier) {
  Surface(modifier, color = PrismLayer2, shape = RoundedCornerShape(14.dp)) {
    Column(Modifier.padding(12.dp)) {
      DrawnIcon(Ui000Icon.Room, PrismLime, 18)
      Spacer(Modifier.height(6.dp))
      Text(name, fontSize = 12.sp, color = PrismInk, fontWeight = FontWeight.SemiBold)
      Text(zh, fontSize = 10.sp, color = PrismInk3)
    }
  }
}

@Composable
private fun PrismSpotlight() {
  Surface(
    Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 10.dp),
    color = PrismLayer2, shape = RoundedCornerShape(28.dp),
    border = androidx.compose.foundation.BorderStroke(1.dp, PrismLayer3),
  ) {
    Row(Modifier.padding(horizontal = 20.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
      DrawnIcon(Ui000Icon.Ask, PrismLime, 18)
      Spacer(Modifier.width(12.dp))
      Text("说你想做什么…", fontSize = 15.sp, color = PrismInk2, modifier = Modifier.weight(1f))
    }
  }
}

@Composable
private fun PrismNav() {
  NavigationBar(containerColor = PrismLayer1) {
    val items = listOf(Ui000Icon.Home to "现在", Ui000Icon.Tools to "工具", Ui000Icon.Devices to "设备", Ui000Icon.Activity to "动态")
    items.forEachIndexed { index, (icon, label) ->
      NavigationBarItem(
        selected = index == 0,
        onClick = {},
        icon = { DrawnIcon(icon, if (index == 0) PrismLime else PrismInk3, 20) },
        label = { Text(label, fontSize = 11.sp) },
      )
    }
  }
}
