// Platform facts: WHAT this machine is, in words a person can check against the box in front of them.
//
// The device surface used to show `win32` and nothing else - Node's internal platform token rather than an operating
// system a reader can recognise - so a Windows 11 x64 machine and a Windows Server 2016 x86 looked identical. The
// complaint that produced this module was exactly that, so the fact set now carries a NAME, a RELEASE, an
// ARCHITECTURE, the hostname and the runtime, and every intermediate value is kept beside the label so a wrong label
// can be diagnosed instead of argued about.
//
// The labelling vocabulary itself lives in apps/web/platform-label.mjs, because the browser must show the same words
// without importing server code. This module only reads the host and assembles the fact set.
import {operatingSystemName, archLabel, platformSummary} from '../../apps/web/platform-label.mjs';

export {operatingSystemName, archLabel, platformSummary};

/** The full platform fact set carried on node metadata and shown on the device surface. */
export const platformFacts = ({os, platform, release, arch, hostname, version} = {}) => {
  const value = typeof os?.platform === 'function' ? {
    platform: os.platform(),
    release: typeof os.release === 'function' ? os.release() : undefined,
    arch: typeof os.arch === 'function' ? os.arch() : undefined,
    hostname: typeof os.hostname === 'function' ? os.hostname() : undefined,
  } : {platform, release, arch, hostname};
  const text = input => (typeof input === 'string' && input.trim().length ? input.trim() : null);
  const osToken = text(value.platform);
  const releaseToken = text(value.release);
  const archToken = text(value.arch);
  return {
    platform: osToken ?? 'unknown',
    osName: operatingSystemName({platform: osToken, release: releaseToken}),
    osRelease: releaseToken,
    arch: archToken ?? 'unknown',
    archName: archLabel(archToken),
    runtimeVersion: text(version) ?? (typeof process !== 'undefined' && text(process.version)) ?? null,
    hostname: text(value.hostname),
  };
};
