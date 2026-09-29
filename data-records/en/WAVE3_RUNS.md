# Wave3 run ledger

PAIR_STATUS: SYNCHRONIZED
STATUS: SERIES=PASS
CODE-SHA: c31035f9fd7e40a63033dcd1d63fde1629a8f31b

Generated/public fixtures only. Historical hardening runs remain in their own series. D9 Room runs bind `28673e1`; City promotion and Alien runs have later, separate SHAs. No raw private SQLite database, pairing material, credentials, device identifier or local absolute path is published.

Local final regression: root 56, Room 67, City 129 and Android unit 21 PASS; assembleDebug PASS; ten promotion records PASS. Windows existing-capability regression: 26 PASS; native retry: 7 PASS. D9 Windows/Android each three PASS, with three complete cross-client digest matches. Live Gateway: three typed refusals PASS; six successful packages and result details survive restart. A native initial attempt ended before any invocation because Services was not visible while the launcher was foreground; that failure is retained rather than counted as product success.

The [raw manifest](../../evidence/raw/wave3/manifest.json) includes existing Room/activation/freeze artifacts, Windows build/regression records, all native attempts with a saved report, the live restart/refusal record, regression totals and four new inspected screenshots. Result PNG bytes are represented by their SHA-256 in sanitized JSON; screenshot files show actual previews. Product implementation stayed at the recorded SHA during pilots; evidence documentation and the explicit-launch driver correction were prepared separately. The initial old-APK control probe failed before implementation, as expected, and is not product acceptance.

Reproduction: `node --test tests/*.test.mjs`; `node --test apps/rooms/tests/*.test.mjs`; `node city/test-all.mjs`; `node scripts/verify-promotion-history.mjs`; `pnpm check:docs`; Android `gradlew testDebugUnitTest assembleDebug`. Local paired-device pilots use `scripts/d9-windows-pilot.mjs` then `scripts/d9-android-pilot.mjs`, with private runtime configuration supplied locally. They do not create cloud credentials or substitute API-only calls for native UI acceptance.
