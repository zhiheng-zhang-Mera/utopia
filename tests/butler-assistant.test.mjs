// Root runner entry for the Butler Assistant Zone contract (BA-001).
// The contract owns its conformance suite; this file only registers it with the
// repository-wide `pnpm test` run.
import '../contracts/butler-assistant-v1/tests/conformance.test.mjs';
