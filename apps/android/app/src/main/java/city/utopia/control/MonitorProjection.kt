package city.utopia.control

import org.json.JSONArray
import org.json.JSONObject

/** Bounded wire reader only: task/risk/route truth belongs to the Gateway projection. */
fun monitorObjects(array:JSONArray?):List<JSONObject> = if(array==null) emptyList() else (0 until array.length()).map{array.getJSONObject(it)}
private fun strings(array:JSONArray):List<String> = (0 until array.length()).map{array.getString(it)}
private fun bounded(data:JSONObject,key:String,limit:Int):JSONArray {
 val array=data.optJSONArray(key) ?: throw IllegalArgumentException("Missing $key")
 require(array.length()<=limit){"Oversized $key"};return array
}
class MonitorGraphView(val raw:JSONObject) {
 val cityId:String get()=raw.getJSONObject("projectionOf").getString("cityId")
 val health:String get()=raw.getJSONObject("projectionOf").optString("health","UNKNOWN").takeIf{it in setOf("COMPLETE","PARTIAL","STALE","UNAVAILABLE","DISCONNECTED")} ?: "UNKNOWN"
 val nodes:List<JSONObject> get()=monitorObjects(raw.getJSONArray("nodes"))
 val edges:List<JSONObject> get()=monitorObjects(raw.getJSONArray("edges"))
 val clusters:List<JSONObject> get()=monitorObjects(raw.getJSONArray("clusters"))
 fun visibleNodes(expanded:Set<String> = emptySet()):List<JSONObject> {
  val byId=nodes.associateBy{it.getString("id")}
  val ids=strings(raw.getJSONArray("visibleNodeIds"))+clusters.filter{it.optString("id") in expanded}.flatMap{strings(it.getJSONArray("nodeIds"))}.sorted()
  return ids.distinct().mapNotNull{byId[it]}
 }
 fun evidence(ref:String):JSONObject {
  val event=monitorObjects(raw.getJSONArray("events")).find{it.optString("canonicalEventId")==ref||it.optString("evidenceRef")==ref}
  val pointer=monitorObjects(raw.getJSONArray("evidence")).find{it.optString("canonicalEventId")==ref}
  val node=nodes.find{it.optString("id")==ref}
  return JSONObject().put("ref",ref).put("cityId",cityId).put("state",if(event!=null||pointer!=null||node!=null||ref.startsWith("observation:")) "OBSERVED_PROJECTION" else "NOT_OBSERVABLE")
   .put("event",event ?: JSONObject.NULL).put("pointer",pointer ?: JSONObject.NULL).put("node",node ?: JSONObject.NULL)
   .put("observation",if(ref.startsWith("observation:"))JSONObject().put("projectionOf",raw.getJSONObject("projectionOf")).put("summary",raw.getJSONObject("summary")) else JSONObject.NULL)
 }
}
fun parseMonitorGraph(response:JSONObject,expectedCity:String):MonitorGraphView {
 try {
  val g=response.getJSONObject("graph")
  require(expectedCity.isNotBlank()&&g.getJSONObject("projectionOf").optString("cityId")==expectedCity){"City identity mismatch"}
  require(g.getInt("schemaVersion")==1&&g.has("authoritative")&&!g.getBoolean("authoritative")){"Non-authoritative schema1 required"}
  val nodes=monitorObjects(bounded(g,"nodes",513));val ids=nodes.map{it.getString("id")};require(ids.all{it.isNotBlank()}&&ids.distinct().size==ids.size){"Invalid node identity"}
  val visible=strings(bounded(g,"visibleNodeIds",513));require(visible.distinct().size==visible.size&&visible.all{it in ids}){"Invalid visible membership"}
  nodes.forEach{node->val risks=monitorObjects(bounded(node,"riskReasons",32));require(!risks.any{it.optString("level") in setOf("ACTIVE","WATCH")}||node.getString("id") in visible){"Risk hidden by collapse"}}
  val clusters=monitorObjects(bounded(g,"clusters",256));val members=mutableSetOf<String>()
  clusters.forEach{c->val rows=strings(bounded(c,"nodeIds",512));require(rows.all{it in ids&&it !in visible&&members.add(it)}){"Invalid cluster membership"};require(c.getInt("count")==rows.size){"Invalid cluster count"}}
  bounded(g,"edges",256);bounded(g,"events",256);bounded(g,"evidence",256);g.getJSONObject("summary")
  return MonitorGraphView(g)
 }catch(e:Exception){throw IllegalArgumentException("Monitor projection unavailable: "+(e.message ?: "invalid input"),e)}
}
fun parseMonitorDecisions(response:JSONObject,expectedCity:String):JSONObject {
 try {
  require(expectedCity.isNotBlank()&&response.optString("cityId")==expectedCity){"Decision City identity mismatch"}
  val window=response.getJSONObject("window");require(window.getInt("schemaVersion")==1&&window.has("authoritative")&&!window.getBoolean("authoritative")){"Decision observation schema required"}
  val rows=monitorObjects(bounded(window,"decisions",200));val ids=rows.map{it.getString("decisionId")};require(ids.distinct().size==ids.size){"Duplicate receipt"}
  rows.forEach{require(it.has("ownerRequired")&&it.get("ownerRequired") is Boolean){"Owner state missing"};require(it.has("appliedBy")&&it.isNull("appliedBy")&&it.optString("application")=="RECORDED_ONLY"){"Receipt application truth conflict"}}
  response.getJSONObject("metrics");return response
 }catch(e:Exception){throw IllegalArgumentException("Decision receipts unavailable: "+(e.message ?: "invalid input"),e)}
}
