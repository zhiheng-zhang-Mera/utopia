/**
 * Shared test helper: isolated runtime-data directories for each test file.
 * Nothing here touches the real apps/knowledge-room/runtime-data directory.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a throwaway data directory inside the OS temp directory. */
export async function makeTempDataDir(prefix = 'knowledge-room-test-') {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Remove a throwaway data directory. */
export async function removeTempDataDir(dir) {
  await rm(dir, { recursive: true, force: true });
}

/** Sample entries used across tests. */
export function sampleEntries() {
  return [
    {
      title: 'Utopia knowledge architecture',
      body: 'Notes about how the Knowledge Room stores entries locally.',
      tags: ['utopia', 'architecture'],
    },
    {
      title: 'Client request handling',
      body: 'The client requests a deterministic search over TITLE and body text.',
      tags: ['engineering'],
    },
    {
      title: 'Release checklist',
      body: 'Steps for a local release.',
      tags: ['process', 'Utopia'],
    },
  ];
}
