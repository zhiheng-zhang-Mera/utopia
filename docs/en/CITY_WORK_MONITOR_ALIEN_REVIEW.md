# MON-902 independent review repairs

Alien reviewed Mech's exact MON-902 head `3a88e23f91924576178973ef46c620b20ffa2aaf`; MON-901 accepted head remains an ancestor. The original 33 tests passed. Six independently added probes failed before repair: completed tasks held offline devices busy; historical waiting/retries appeared current; absent coverage metadata appeared calm; the UI ignored actual collapsed membership; paths lost event provenance; and a delayed response crossed an offline boundary.

The graph now uses canonical terminal states, requires valid coverage for absence claims, preserves unknown counts as null, sorts structurally, keeps active/watch risks visible and carries exact related event references. Related events are not asserted to be assignment causes. Unavailable timestamps, durations, model routes and review handoffs remain explicitly unobserved.

The Web page renders actual visible membership, supports expand/collapse and path filtering, and opens canonical evidence. Its lifecycle rejects responses across credential, City, navigation and connectivity boundaries and follows a snapshot that arrives during a request. Heartbeat-only refreshes preserve visible row DOM and refresh open evidence in place. Actual browser navigation from task overview through a path to its canonical event uses three interactions; the projection's design budget is not a measured worst-case statistic.

Reproduction: `node --test tests/mon901-observation.test.mjs tests/mon902-monitor-graph.test.mjs tests/mon902-monitor-panel.test.mjs tests/mon902-alien-review.test.mjs`. Eleven independent probes supplement the original 33. Baseline failures and later measurement corrections are retained in the review receipt; no physical performance claim follows from these tests.

Supported surface strategy: desktop Web is directly tested with a real Gateway and Chromium/Edge. Android native monitor parity and physical cross-device acceptance remain deferred to the combined MON-903/MON-990 closeout, as documented in the author handoff. This review does not turn an Android build into native UI acceptance, fabricate provider/model observations, or authorize a main merge.
