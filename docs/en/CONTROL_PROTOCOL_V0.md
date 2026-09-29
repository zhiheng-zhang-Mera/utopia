# Control protocol

All JSON replies carry apiVersion and schemaVersion. API clients send X-City-Api-Version and X-City-Schema-Version headers, both zero, plus Authorization: Bearer with their token. A mismatch returns 409 with a readable error; bad authentication returns 401. Health is unauthenticated and reveals only version and status.

Public endpoints: GET /api/v0/health, /city, /nodes, /tasks, /tasks/{id}, /events; POST /api/v0/tasks with only a supported type; POST /api/v0/tasks/{id}/cancel. All abbreviated paths share /api/v0. WS /api/v0/events/stream requires version query parameters and authentication. Browser authentication uses a base64url token subprotocol, never a URL token; Android uses Authorization.

Node-only endpoints: POST /api/v0/node/register, /heartbeat, /claim, /report (same node prefix). A separate node token is required. Registration declares identity, metadata and capabilities; heartbeat refreshes liveness. Claim atomically assigns queued work to a capable idle node. Reports advance ASSIGNED → RUNNING → COMPLETED/FAILED, with checkpoints while RUNNING. User cancellation is terminal. Other terminal states cannot be overwritten.

Events have monotonic seq and stable UUID id. Both clients re-read the canonical snapshot on stream updates and reconnect, which avoids duplicate client-side event append and recovers missed events. Last cached node status is not current health while disconnected.

Machine definitions: contracts/city-control-v0/schema.json and protocol.mjs. DevicePrincipal is represented by the reference node's stable devicePrincipalId; control tokens carry control.observe/control.command authority. Full identity enrollment is POST_V0.

FACT: apiVersion=0; schemaVersion=0; mismatch=409; unauthorized=401
PAIR_STATUS: SYNCHRONIZED
