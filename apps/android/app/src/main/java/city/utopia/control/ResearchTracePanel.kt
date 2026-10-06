package city.utopia.control
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable fun ResearchTracePanel(state:CityState,client:CityClient?) {
 val online=state.connection=="ONLINE"
 val fence=remember(client){CallbackFence()}
 DisposableEffect(fence){onDispose{fence.close()}}
 var busy by remember(client){mutableStateOf(false)}
 var failure by remember(client){mutableStateOf<String?>(null)}
 var trace by remember(client){mutableStateOf<ResearchTraceView?>(null)}
 var technical by remember(client){mutableStateOf(false)}
 fun load(){if(client==null||!online||busy)return;fence.invalidate();val ticket=fence.ticket()?:return;busy=true;failure=null
  client.researchTrace { response->
   if(!fence.accepts(ticket))return@researchTrace
   busy=false
   if(response.has("errorCode")){trace=null;failure=if(response.optInt("httpStatus")==403)"仅城市所有者可查看研究记录，请由所有者打开此页面。" else "研究记录暂不可用，请刷新或重新连接。"}
   else{trace=runCatching{parseResearchTrace(response)}.getOrNull();if(trace==null)failure="研究记录格式不可用，测量状态未知。"}
  }
 }
 LaunchedEffect(client,online){if(online&&trace==null&&failure==null)load()}
 Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(12.dp)){
  Text("研究记录",style=MaterialTheme.typography.titleLarge)
  Text("只读查看本城市的观察记录。记录不会创建或执行实验。")
  Button(onClick={load()},enabled=online&&client!=null&&!busy){Text(if(busy)"读取中…" else "刷新研究记录")}
  if(!online)Text("重新连接后查看当前研究记录。测量状态 NOT_OBSERVABLE；缓存不是实时记录。")
  if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  failure?.let{Text(it,color=MaterialTheme.colorScheme.error)}
  trace?.let { view->
   Text(when(view.recording){true->"正在记录";false->"记录已停止";null->"NOT_OBSERVABLE: 记录状态未知"}+" · "+view.storageState+" · "+view.completeness)
   Text("事件类型："+view.types.joinToString().ifBlank{"尚未观察到"})
   Text("实验运行："+view.experimentRun)
   Text("测量可用性",style=MaterialTheme.typography.titleMedium)
   if(view.metrics.isEmpty())Text("NOT_OBSERVABLE: 未提供测量可用性")
   view.metrics.forEach{Text(it.name+": "+if(it.available==true)"已测量" else it.reason)}
   Text("采集器故障："+view.failures.joinToString().ifBlank{"尚未观察到"})
   TextButton(onClick={technical=!technical}){Text(if(technical)"收起技术详情" else "技术详情")}
   if(technical){Text("软件身份为声明的引用，需要外部验证。缺失测量保持 NOT_OBSERVABLE。");Text(view.technical,style=MaterialTheme.typography.bodySmall)}
  }
 }
}
