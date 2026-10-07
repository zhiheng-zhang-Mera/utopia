package city.utopia.control
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

// REX-807, Android: the run observation panel. Observation only - the phone never authorises, starts, stops or injects;
// full authoring stays on the Web where the owner is. What it shows is the current run, the coverage the City itself
// reports (including a bounded receipt window) and every critical attention item, with the raw payload folded away.
@Composable fun ResearchRunPanel(state:CityState,client:CityClient?) {
 val online=state.connection=="ONLINE"
 val fence=remember(client){CallbackFence()}
 DisposableEffect(fence){onDispose{fence.close()}}
 var busy by remember(client){mutableStateOf(false)}
 var failure by remember(client){mutableStateOf<String?>(null)}
 var view by remember(client){mutableStateOf<ResearchRunView?>(null)}
 var technical by remember(client){mutableStateOf(false)}
 fun load(){if(client==null||!online||busy)return;fence.invalidate();val ticket=fence.ticket()?:return;busy=true;failure=null
  client.researchCampaigns { response->
   if(!fence.accepts(ticket))return@researchCampaigns
   busy=false
   val parsed=runCatching{parseResearchRun(response)}.getOrNull()
   if(parsed==null){view=null;failure="研究记录格式不可用，测量状态未知。"}else{view=parsed;failure=null}
  }
 }
 LaunchedEffect(client,online){if(online&&view==null&&failure==null)load()}
 Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(12.dp)){
  Text("研究运行",style=MaterialTheme.typography.titleLarge)
  Text("只读观察：本页不创建、不启动、不停止实验，也不做故障注入。")
  Button(onClick={load()},enabled=online&&client!=null&&!busy){Text(if(busy)"读取中…" else "刷新运行状态")}
  if(!online)Text("重新连接后查看当前运行状态；离线缓存不是实时记录。")
  if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  failure?.let{Text(it,color=MaterialTheme.colorScheme.error)}
  view?.let{observed->
   if(observed.ownerRequired){
    Text(observed.coverage)
   }else{
    Text(observed.coverage,style=MaterialTheme.typography.titleMedium)
    if(observed.attention.isEmpty())Text("没有需要注意的事项。")
    for(item in observed.attention)Text("⚠ ${item.summary}")
    TextButton(onClick={technical=!technical}){Text(if(technical)"收起技术细节" else "展开技术细节")}
    if(technical)Text(observed.technical,style=MaterialTheme.typography.bodySmall)
   }
  }
 }
}
