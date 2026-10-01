// Root harness so `pnpm test` (node --test tests/*.test.mjs) covers this contract.
// The suites themselves live beside their modules; CI discovers them through these thin
// importers, which is why adding a contract without one leaves it outside the gate.
import '../contracts/rs-cross-device-return-v1/tests/return-bridge.test.mjs';
import '../contracts/rs-cross-device-return-v1/tests/step2-scenarios.test.mjs';
