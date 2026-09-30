package city.utopia.control
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class RoomsTest {
 // The real GET /api/v0/rooms payload: the flat envelope carries a "rooms" object, whose own
 // "rooms" array holds the catalog. hubUrl is present on the wire and deliberately never modelled.
 private val available = JSONObject(
  """{"apiVersion":0,"schemaVersion":0,"rooms":{"available":true,"hubUrl":"http://127.0.0.1:4320/","reason":null,
   "checkedAt":"2026-09-30T10:00:00Z","count":10,"rooms":[
    {"id":"checklist","number":"03","label":"Checklist Room","zh":"清单室","summary":"Lists you can tick off.","persistent":true,"tags":["lists"],"lifecycle":"LOCAL_PRODUCT"},
    {"id":"hash","number":"06","label":"Hash Room","zh":"哈希室","summary":"SHA-256 of a local file.","persistent":false,"tags":["files"],"lifecycle":"LOCAL_PRODUCT"}]}}"""
 )
 @Test fun availableHubReportsItsCatalog() {
  val hub=parseRoomAvailability(payload(available,"rooms"))
  assertTrue(hub.available)
  assertEquals("AVAILABLE",hub.stateLabel)
  assertEquals("2026-09-30T10:00:00Z",hub.checkedAt)
  assertEquals(10,hub.count)
  assertEquals(2,hub.rooms.size)
  assertEquals("03",hub.rooms.first().number)
  assertEquals("Checklist Room",hub.rooms.first().label)
  assertEquals("清单室",hub.rooms.first().zh)
  assertEquals("Lists you can tick off.",hub.rooms.first().summary)
  assertTrue(hub.rooms.first().persistent)
  assertFalse(hub.rooms[1].persistent)
 }
 @Test fun unavailableHubIsATruthfulStateNotAnError() {
  val hub=parseRoomAvailability(payload(JSONObject("""{"apiVersion":0,"schemaVersion":0,"rooms":{"available":false,"hubUrl":null,
   "reason":"Room Hub did not answer on loopback","checkedAt":"2026-09-30T10:00:05Z","count":10,"rooms":[]}}"""),"rooms"))
  assertFalse(hub.available)
  assertEquals("UNAVAILABLE",hub.stateLabel)
  assertEquals("The Room Hub is not reachable from the Utopia host right now: Room Hub did not answer on loopback",hub.stateDetail)
  assertEquals("2026-09-30T10:00:05Z",hub.checkedAt)
  assertEquals(10,hub.count)
  assertTrue(hub.rooms.isEmpty())
 }
 @Test fun unavailableWithoutReasonStaysPlain() {
  val hub=parseRoomAvailability(payload(JSONObject("""{"rooms":{"available":false,"reason":null,"checkedAt":"","count":0,"rooms":[]}}"""),"rooms"))
  assertNull(hub.reason)
  assertEquals("The Room Hub is not reachable from the Utopia host right now.",hub.stateDetail)
  assertEquals("The ten Rooms cannot run until the hub is back",hub.catalogLabel)
 }
 @Test fun missingOptionalRoomFieldsDoNotInventValues() {
  val hub=parseRoomAvailability(payload(JSONObject("""{"rooms":{"available":true,"count":1,"rooms":[{"id":"focus"}]}}"""),"rooms"))
  val room=hub.rooms.single()
  assertEquals("focus",room.id)
  assertEquals("",room.number);assertEquals("",room.label);assertEquals("",room.zh);assertEquals("",room.summary)
  assertFalse(room.persistent)
  assertEquals("",hub.checkedAt)
  assertEquals(1,hub.count)
 }
 @Test fun roomAvailabilityIsOnlyFreshWhileOnline() {
  assertTrue(canLoadRooms("ONLINE",false))
  assertFalse(canLoadRooms("ONLINE",true))
  assertFalse(canLoadRooms("RECONNECTING",false))
  assertFalse(canLoadRooms("OFFLINE",false))
 }
}

class FlatEnvelopeTest {
 @Test fun payloadIsASiblingOfTheVersionFieldsAndHasNoDataWrapper() {
  val envelope=JSONObject("""{"apiVersion":0,"schemaVersion":0,"rooms":{"available":true,"count":0,"rooms":[]}}""")
  assertTrue(compatible(envelope.optInt("apiVersion",-1),envelope.optInt("schemaVersion",-1)))
  assertNotNull(payload(envelope,"rooms"))
  assertFalse(envelope.has("data"))
 }
 @Test fun aMissingPayloadIsRejectedInsteadOfTreatedAsEmptySuccess() {
  assertThrows(IllegalStateException::class.java) { payload(JSONObject("""{"apiVersion":0,"schemaVersion":0}"""),"rooms") }
  assertThrows(IllegalStateException::class.java) { payload(JSONObject("""{"apiVersion":0,"schemaVersion":0,"rooms":null}"""),"rooms") }
  assertThrows(IllegalStateException::class.java) { payload(JSONObject("""{"apiVersion":0,"schemaVersion":0}"""),"ask") }
  assertThrows(IllegalStateException::class.java) { payload(JSONObject("""{"apiVersion":0,"schemaVersion":0}"""),"actions") }
 }
 @Test fun anErrorEnvelopeIsNotMistakenForAPayload() {
  val envelope=JSONObject("""{"apiVersion":0,"schemaVersion":0,"error":"Rooms are unavailable","errorCode":"ROOMS_UNAVAILABLE"}""")
  assertEquals("ROOMS_UNAVAILABLE",envelope.optString("errorCode"))
  assertThrows(IllegalStateException::class.java) { payload(envelope,"rooms") }
 }
}
