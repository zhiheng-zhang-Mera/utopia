// Platform LABELS: the pure part of "what machine is this", shared by the server, the node agent and the Web surface.
//
// This module exists so the label is written ONCE. The device surface used to print Node's internal platform token
// (`win32`) and nothing else, which cannot tell Windows 11 from Windows 10 or a 64-bit machine from a 32-bit one; the
// complaint that produced this file was exactly "the UI only shows win32". The vocabulary lives here, in a module with
// no imports and no I/O, so it can be tested on its own and reused by the browser bundle.
//
// NOTHING HERE IS INVENTED: an unrecognised release degrades to a broader true statement ("Windows") rather than a
// guess, and a missing architecture is simply absent from the summary.
const text = value => (typeof value === 'string' && value.trim().length ? value.trim() : null);

/** Windows desktop and Server share kernel builds; the measured product name identifies the edition. */
const windowsName = (release, productVersion) => {
  // Desktop and Server share NT builds. Only a measured product name identifies the edition.
  const product = text(productVersion);
  if (product && /^Windows\b/i.test(product)) return product;
  return text(release) ? `Windows (kernel ${text(release)})` : 'Windows';
};

const macName = release => {
  const major = Number.parseInt(String(release ?? '').split('.')[0], 10);
  // The known Darwin 20..24 mapping ends at macOS 15. Newer numbering must not be guessed.
  return Number.isFinite(major) && major >= 20 && major <= 24 ? `macOS ${major - 9}` : text(release) ? `macOS (Darwin ${text(release)})` : 'macOS';
};

/** e.g. "Windows 11" / "macOS 15" / "Linux (kernel 6.8.0-31-generic)" / "Unknown operating system". */
export const operatingSystemName = ({platform, release, productVersion} = {}) => {
  const token = text(platform);
  const rel = text(release);
  if (!token) return 'Unknown operating system';
  if (token === 'win32') return windowsName(rel, productVersion);
  if (token === 'darwin') return macName(rel);
  // A Linux kernel version is not a distribution version, so the name stays generic and the kernel is shown as its
  // own fact instead of being presented as "Ubuntu 24.04".
  if (token === 'linux') return rel ? `Linux (kernel ${rel})` : 'Linux';
  return rel ? `${token} (${rel})` : token;
};

/** Architecture in the words a spec sheet uses, so "x64" reads as 64-bit. */
export const archLabel = arch => {
  const token = text(arch);
  if (!token) return null;
  return {x64: '64-bit (x64)', arm64: '64-bit (ARM64)', ia32: '32-bit (x86)', arm: '32-bit (ARM)'}[token] ?? token;
};

/**
 * One readable line: "Windows 11 · 64-bit (x64) · Node v24.14.0". Unknown parts are dropped rather than printed, and
 * a machine whose OS cannot be named still shows its raw platform token so the field is never empty.
 */
export const platformSummary = facts => {
  if (!facts || typeof facts !== 'object') return 'unknown platform';
  const parts = [text(facts.osName) ?? text(facts.platform) ?? 'unknown platform'];
  const arch = archLabel(facts.arch) ?? text(facts.archName);
  if (arch) parts.push(arch);
  if (text(facts.runtimeVersion)) parts.push(`Node ${facts.runtimeVersion}`);
  return parts.join(' · ');
};
