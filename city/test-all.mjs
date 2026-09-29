/**
 * UTOPIA · City — module test entry point.
 *
 * Discovers every `*.test.mjs` under `city/` and runs them with the Node test
 * runner. Plain Node only: no new test framework, and no dependency on shell
 * glob expansion (which differs between Windows and POSIX shells).
 *
 * Usage:
 *   node city/test-all.mjs            # every city module test
 *   node city/test-all.mjs knowledge  # only files whose path contains "knowledge"
 */

import { spawn } from 'node:child_process';
import { relative } from 'node:path';
import { CITY_ROOT, discoverTests } from './manifest.mjs';

const filter = process.argv[2] ?? '';
const tests = (await discoverTests()).filter((file) => (filter ? file.includes(filter) : true));

if (tests.length === 0) {
  process.stdout.write(filter ? `city: no test file matches "${filter}"\n` : 'city: no module tests yet\n');
  process.exit(filter ? 1 : 0);
}

process.stdout.write(`city: running ${tests.length} test file(s)\n`);
for (const file of tests) process.stdout.write(`  ${relative(CITY_ROOT, file).replace(/\\/g, '/')}\n`);

const child = spawn(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
