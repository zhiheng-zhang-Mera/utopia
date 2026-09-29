# Architecture

The Gateway serves versioned HTTP snapshots and an authenticated WebSocket event stream. SQLite stores tasks, events, nodes and schema version. The separate City Node Reference Agent advertises explicit capabilities, polls for work and executes through a filesystem adapter. Android Compose and browser clients use the same public API. Platform metadata never grants capabilities.

The Gateway is a development reference, not City Core, Boss or Hns. Utopia is implementation truth. Digital-City remains reference-only and is not modified. No implementation or acceptance depends on writing that repository.

The runner accepts only WAIT, CREATE_TEMP_ARTIFACT, HASH_TEMP_ARTIFACT, DELETE_TEMP_ARTIFACT and CHECKPOINT_DEMO. Each file task has a generated, bounded workspace and cleans it on normal completion/cancellation; HASH and DELETE create their own fixture first. No shell or user path is accepted. Abrupt process termination can leave bounded workspace files; interrupted tasks become FAILED on gateway restart and are not automatically replayed.

Each surface holds a private control token. The node uses a separate token. HTTP and WebSocket are LAN development transports; this is not Internet-ready security. The node is a single trusted local reference agent, not a multi-tenant runtime.

FACT: apiVersion=0; schemaVersion=0; runtimeNodes=1
PAIR_STATUS: SYNCHRONIZED
