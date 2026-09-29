package city.utopia.control

import android.graphics.BitmapFactory
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

private fun JSONArray?.values(): List<JSONObject> = if(this==null) emptyList() else (0 until length()).map { getJSONObject(it) }

@Composable fun ServicesPanel(state: CityState, client: CityClient?) {
 val context=LocalContext.current
 val scope=rememberCoroutineScope()
 val resultFence=remember(client) { CallbackFence() }
 DisposableEffect(resultFence) { onDispose { resultFence.close() } }
 val descriptors=state.snapshot?.optJSONArray("capabilities").values()
 val history=state.snapshot?.optJSONArray("invocations").values()
 val latestHistory by rememberUpdatedState(history)
 var selected by remember { mutableStateOf("planning.document.intake") }
 var menu by remember { mutableStateOf(false) }
 var operationMenu by remember { mutableStateOf(false) }
 var busy by remember { mutableStateOf(false) }
 var result by remember { mutableStateOf<JSONObject?>(null) }
 var document by remember { mutableStateOf<JSONObject?>(null) }
 var useDocument by remember { mutableStateOf(false) }
 var fileName by remember { mutableStateOf("") }
 var fileBytes by remember { mutableStateOf<ByteArray?>(null) }
 var query by remember { mutableStateOf("Utopia") }
 var budget by remember { mutableStateOf("8000") }
 var trust by remember { mutableStateOf("UNVERIFIED") }
 var entries by remember { mutableStateOf("[{\"id\":\"note\",\"title\":\"Utopia\",\"content\":\"Utopia shared knowledge\",\"domain\":\"document\",\"shelf\":\"temporary\",\"tags\":[\"document\"],\"trust\":\"UNVERIFIED\",\"updatedAt\":\"2026-01-01\"}]") }
 var skillOperation by remember { mutableStateOf("inspect") }
 var reference by remember { mutableStateOf("owner/repo@main") }
 var subpath by remember { mutableStateOf("") }
 var skillText by remember { mutableStateOf("---\nname: demo-skill\ndescription: Generated public inspection sample\n---\nRead the sample.") }
 var evidenceInput by remember { mutableStateOf("{\"sample\":true}") }
 var seed by remember { mutableStateOf("utopia") }
 var style by remember { mutableStateOf("research") }
 var accent by remember { mutableStateOf("#4d93f8") }
 var themeOperation by remember { mutableStateOf("generate") }
 var themeOperationMenu by remember { mutableStateOf(false) }
 var themePrompt by remember { mutableStateOf("blue research compact no persona") }
 var themeObservation by remember { mutableStateOf("none") }
 var themeObservationMenu by remember { mutableStateOf(false) }
 var themeFailure by remember { mutableStateOf(false) }
 var showDetails by remember { mutableStateOf(false) }
 var detailLoading by remember { mutableStateOf(false) }
 val descriptor=descriptors.find { it.optString("capabilityId")==selected }
 val enabled=canInvokeCapability(state.connection,descriptor?.optString("bridgeState")?:"BRIDGE_PENDING",busy)
 fun failure(code: String) { result=JSONObject().put("status","FAILED").put("errorCode",code) }
 val picker=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
  if(uri!=null) scope.launch {
   busy=true
   try {
    val picked=withContext(Dispatchers.IO) {
     val name=context.contentResolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null)?.use { if(it.moveToFirst()) it.getString(0) else "document.txt" }?:"document.txt"
     val bytes=context.contentResolver.openInputStream(uri)?.use { stream -> val out=ByteArrayOutputStream();val buffer=ByteArray(8192);while(true){val count=stream.read(buffer);if(count<0)break;if(out.size()+count>1024*1024)throw IllegalArgumentException("INPUT_TOO_LARGE");out.write(buffer,0,count)};out.toByteArray() }?:throw IllegalArgumentException("FILE_UNAVAILABLE")
     name to bytes
    }
    fileName=picked.first;fileBytes=picked.second;result=null
    if(selected=="engineering.skill.inspect"&&skillOperation=="validate")skillText=picked.second.toString(Charsets.UTF_8)
   } catch(e: Exception){fileBytes=null;fileName="";failure(if(e.message=="INPUT_TOO_LARGE")"INPUT_TOO_LARGE" else "FILE_UNAVAILABLE")}
   finally{busy=false}
  }
 }
 fun invoke(tamper: Boolean=false) {
  if(!enabled||client==null)return
  try {
   var operation=""
   val input=when(descriptor?.optString("inputKind")) {
    "document" -> {operation="read";val bytes=fileBytes?:throw IllegalArgumentException("CHOOSE_FILE");JSONObject().put("fileName",fileName).put("base64",Base64.encodeToString(bytes,Base64.NO_WRAP))}
    "knowledge" -> {operation=if(useDocument)"fromDocument" else "query";JSONObject().put("query",query).put("budget",budget.toInt()).put("trustFloor",trust).apply {if(useDocument)put("document",document?:throw IllegalArgumentException("DOCUMENT_REQUIRED")) else put("entries",JSONArray(entries))}}
    "skill" -> {operation=skillOperation;if(operation=="archive")JSONObject().put("base64",Base64.encodeToString(fileBytes?:throw IllegalArgumentException("CHOOSE_FILE"),Base64.NO_WRAP)) else JSONObject().put("ref",reference).put("subpath",subpath).put("text",skillText).put("query",reference)}
    "evidence" -> {operation=if(tamper)"tamper" else "review";JSONObject(evidenceInput)}
    "theme" -> {operation=themeOperation;if(operation=="build")JSONObject().put("prompt",themePrompt).put("observationPreset",themeObservation).put("injectFailure",themeFailure) else JSONObject().put("seed",seed).put("style",style).put("palette",JSONObject().put("accent",accent))}
    else -> throw IllegalArgumentException("BRIDGE_PENDING")
   }
   resultFence.invalidate();val ticket=resultFence.ticket()?:return
   busy=true;result=null;detailLoading=false
   client.invokeCapability(selected,operation,input) { response -> busy=false;if(resultFence.accepts(ticket)){result=response;if(response.optString("capabilityId")=="planning.document.intake"&&response.optString("status")=="COMPLETED")document=response.optJSONObject("result")} }
  }catch(e: Exception){failure(if(e.message in listOf("CHOOSE_FILE","DOCUMENT_REQUIRED","BRIDGE_PENDING")) e.message!! else "INVALID_INPUT")}
 }
 LaunchedEffect(state.snapshot,result?.optString("invocationId")) { val id=result?.optString("invocationId");if(!id.isNullOrEmpty())history.find { it.optString("invocationId")==id }?.let { summary ->
  if(acceptInvocationSummary(result?.optString("status")?:"",summary.optString("status"))){val merged=JSONObject(result.toString());summary.keys().forEach { key -> merged.put(key,summary.get(key)) };if(!summary.optBoolean("resultAvailable"))merged.remove("result");result=merged}
 } }
 Column(verticalArrangement=Arrangement.spacedBy(12.dp),modifier=Modifier.fillMaxWidth()) {
  Box { OutlinedButton(onClick={menu=true},enabled=!busy) {Text(descriptor?.optString("name")?:"Choose service")};DropdownMenu(expanded=menu,onDismissRequest={menu=false}) {descriptors.forEach { d -> DropdownMenuItem(text={Text(d.optString("name"))},onClick={resultFence.invalidate();selected=d.optString("capabilityId");menu=false;result=null;showDetails=false;detailLoading=false}) }} }
  Text(if(state.connection=="ONLINE")"Live City authority" else "Cached · offline · invocation disabled",fontSize=12.sp)
  Text((descriptor?.optString("bridgeState")?:"BRIDGE_PENDING")+" · "+(descriptor?.optString("cityLifecycle")?:""),fontSize=12.sp)
  when(descriptor?.optString("inputKind")) {
   "document" -> {Text("Read a document on your City. File limit: 1 MiB.");OutlinedButton(onClick={resultFence.invalidate();detailLoading=false;picker.launch(arrayOf("*/*"))},enabled=!busy){Text("Choose document")};Text(fileName.ifEmpty {"No file selected"});Text("Original bytes are not retained after parsing. The latest 50 result details are retained; older summaries keep their digest.",fontSize=12.sp)}
   "knowledge" -> {
    OutlinedTextField(query,{query=it},label={Text("Query")},modifier=Modifier.fillMaxWidth())
    OutlinedTextField(budget,{budget=it},label={Text("Character budget")},modifier=Modifier.fillMaxWidth())
    OutlinedTextField(trust,{trust=it},label={Text("Trust floor")},modifier=Modifier.fillMaxWidth())
    Row {Checkbox(useDocument,{useDocument=it},enabled=document!=null);Text("Use last document result")}
    if(!useDocument)OutlinedTextField(entries,{entries=it},label={Text("Temporary entries JSON")},maxLines=5,modifier=Modifier.fillMaxWidth())
   }
   "skill" -> {
    Box {OutlinedButton(onClick={operationMenu=true}) {Text("Action: $skillOperation")};DropdownMenu(operationMenu,{operationMenu=false}) {listOf("inspect","validate","catalog","archive").forEach { op -> DropdownMenuItem(text={Text(op)},onClick={resultFence.invalidate();detailLoading=false;skillOperation=op;operationMenu=false;result=null}) }}}
    if(skillOperation=="inspect"||skillOperation=="catalog") {OutlinedTextField(reference,{reference=it},label={Text(if(skillOperation=="catalog")"Catalog query" else "GitHub reference")},modifier=Modifier.fillMaxWidth());if(skillOperation=="inspect")OutlinedTextField(subpath,{subpath=it},label={Text("Optional subpath")},modifier=Modifier.fillMaxWidth())}
    if(skillOperation=="validate"){OutlinedTextField(skillText,{skillText=it},label={Text("SKILL.md")},maxLines=6,modifier=Modifier.fillMaxWidth());OutlinedButton(onClick={resultFence.invalidate();detailLoading=false;picker.launch(arrayOf("*/*"))}){Text("Choose SKILL.md")}}
    if(skillOperation=="archive"){OutlinedButton(onClick={resultFence.invalidate();detailLoading=false;picker.launch(arrayOf("*/*"))}){Text("Choose archive")};Text(fileName.ifEmpty {"No file selected"})}
    Text("Inspection only. No installation or remote code execution.",fontSize=12.sp)
   }
   "evidence" -> {OutlinedButton(onClick={resultFence.invalidate();detailLoading=false;evidenceInput="{\"sample\":true}";result=null}){Text("Load public sample")};OutlinedTextField(evidenceInput,{evidenceInput=it},label={Text("Evidence JSON")},maxLines=6,modifier=Modifier.fillMaxWidth());Text("Integrity and references only; does not verify claims as true.",fontSize=12.sp);OutlinedButton(onClick={invoke(true)},enabled=enabled){Text("Tamper Test")}}
   "theme" -> {
    Box {OutlinedButton(onClick={themeOperationMenu=true},enabled=!busy){Text("Theme action: $themeOperation")};DropdownMenu(themeOperationMenu,{themeOperationMenu=false}){listOf("generate","build").forEach { op -> DropdownMenuItem(text={Text(op)},onClick={resultFence.invalidate();detailLoading=false;themeOperation=op;themeOperationMenu=false;result=null}) }}}
    if(themeOperation=="generate"){
     OutlinedTextField(seed,{seed=it},label={Text("Seed")},modifier=Modifier.fillMaxWidth());OutlinedTextField(style,{style=it},label={Text("Style")},modifier=Modifier.fillMaxWidth());OutlinedTextField(accent,{accent=it},label={Text("Accent color")},modifier=Modifier.fillMaxWidth())
    }else{
     OutlinedTextField(themePrompt,{themePrompt=it},label={Text("Theme prompt")},enabled=!busy,modifier=Modifier.fillMaxWidth())
     Box {OutlinedButton(onClick={themeObservationMenu=true},enabled=!busy){Text("Observation: $themeObservation")};DropdownMenu(themeObservationMenu,{themeObservationMenu=false}){listOf("none","desktop").forEach { preset -> DropdownMenuItem(text={Text(preset)},onClick={themeObservation=preset;themeObservationMenu=false}) }}}
     Row(Modifier.clickable(enabled=!busy){themeFailure=!themeFailure}){Checkbox(themeFailure,{themeFailure=it},enabled=!busy);Text("Test image failure")}
    }
    Text("Generate, preview and validate; no global apply.",fontSize=12.sp)
   }
  }
  Button(onClick={invoke()},enabled=enabled,modifier=Modifier.fillMaxWidth()){Text(if(busy)"Running…" else "Run service")}
  if(busy)LinearProgressIndicator(modifier=Modifier.fillMaxWidth())
  result?.let { row ->
   Text(row.optString("status"),fontWeight=FontWeight.Bold)
   if(!row.isNull("errorCode"))Text(row.optString("errorCode"))
   if(row.has("httpStatus")&&!row.isNull("httpStatus"))Text("HTTP "+row.optInt("httpStatus"))
   if(row.has("error"))Text(row.optString("error"))
   if(row.has("detailError"))Text(row.optString("detailError"))
   if(detailLoading)Text("Loading result details…")
   if(row.optString("status")=="COMPLETED"&&row.has("resultAvailable")&&!row.optBoolean("resultAvailable"))Text("Result detail expired / pruned. Digest retained.")
   Text(row.optString("invocationId"),fontSize=11.sp)
   if(!row.isNull("resultDigest"))Text(row.optString("resultDigest"),fontSize=11.sp)
   row.optJSONObject("result")?.let { payload ->
    if(payload.has("sections"))Text("Sections: "+payload.getJSONArray("sections").length()+" · "+payload.optString("format"))
    if(payload.has("warnings"))Text(payload.getJSONArray("warnings").toString())
    if(payload.has("matches"))payload.getJSONArray("matches").values().forEach {Text(it.optString("title")+": "+it.optString("content"))}
    payload.optJSONObject("bundle")?.let { b ->Text("Decision: "+b.optString("decision"));Text("Integrity root: "+b.optString("integrityRoot"),fontSize=11.sp);b.optJSONArray("claims").values().forEach {Text(it.optString("status")+": "+it.optString("text"))}}
    if(payload.has("previewPngBase64")){val bitmap=remember(payload.optString("previewPngBase64")){runCatching {val bytes=Base64.decode(payload.getString("previewPngBase64"),Base64.DEFAULT);BitmapFactory.decodeByteArray(bytes,0,bytes.size)}.getOrNull()};bitmap?.let {Image(it.asImageBitmap(),"Theme preview",Modifier.fillMaxWidth().height(180.dp))};Text("Validation: "+payload.optJSONObject("validation")?.optBoolean("ok"))}
    if(payload.has("packageDigest")){Text("Package: "+payload.optString("packageDigest"),fontSize=11.sp);Text((if(payload.optBoolean("observed"))"Observed layout" else "No observation · degraded layout")+" · Fallback: "+(payload.optJSONObject("fallback")?.optJSONArray("degraded_assets")?.length()?:0)+" · Disabled: "+(payload.optJSONObject("fallback")?.optJSONArray("disabled")?.length()?:0),fontSize=12.sp)}
    OutlinedButton(onClick={showDetails=!showDetails}){Text(if(showDetails)"Hide result details" else "Show result details")}
    if(showDetails){val readable=JSONObject(payload.toString());readable.remove("previewPngBase64");Text(readable.toString(2),fontSize=12.sp)}
    if(row.optString("capabilityId")=="planning.document.intake"&&row.optString("status")=="COMPLETED")OutlinedButton(onClick={resultFence.invalidate();document=payload;useDocument=true;selected="planning.knowledge.query";result=null;detailLoading=false}){Text("Query this document")}
   }
  }
  Text("Invocation history",fontWeight=FontWeight.Bold)
  history.takeLast(10).reversed().forEach { row -> OutlinedButton(enabled=!busy,onClick={
   resultFence.invalidate();val ticket=resultFence.ticket();selected=row.optString("capabilityId");result=JSONObject(row.toString());showDetails=false;detailLoading=false
   if(state.connection!="ONLINE"||client==null)result=JSONObject(row.toString()).put("detailError","OFFLINE · reconnect to load result details")
   else if(ticket!=null){detailLoading=true;client.invocationDetail(row.optString("invocationId")){ detail ->
    if(resultFence.accepts(ticket)){detailLoading=false;result=if(detail.has("invocationId")){
     latestHistory.find { it.optString("invocationId")==detail.optString("invocationId") }?.let { summary -> if(acceptInvocationSummary(detail.optString("status"),summary.optString("status"))){summary.keys().forEach { key -> detail.put(key,summary.get(key)) };if(!summary.optBoolean("resultAvailable"))detail.remove("result")} };detail
    } else JSONObject(row.toString()).put("detailError",detail.optString("errorCode")+" · "+detail.optString("error"))}
   }}
  },modifier=Modifier.fillMaxWidth()){Column {Text(row.optString("capabilityId"),fontSize=12.sp);Text(row.optString("status")+" · "+row.optString("invocationId"),fontSize=10.sp)}} }
 }
}
