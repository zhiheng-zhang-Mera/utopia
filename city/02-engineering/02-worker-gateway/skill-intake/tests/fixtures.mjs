/**
 * Shared tar builders for the skill intake tests.
 * Mirrors the helper functions of the donor test suite so the vectors stay
 * comparable: DS-Hns tests/unit/skills-service.test.js @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b
 */

export const BLOCK_SIZE = 512;

/** Build a single tar header block. */
export function tarHeader(name, size, type) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) sum += block[index];
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/** Pad a payload to the next 512-byte boundary. */
export function tarPad(buffer) {
  const remainder = buffer.length % BLOCK_SIZE;
  return remainder ? Buffer.concat([buffer, Buffer.alloc(BLOCK_SIZE - remainder)]) : buffer;
}

/** Build a tar archive from { path, data?, type? } entries. */
export function buildTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    blocks.push(tarHeader(entry.path, entry.data ? entry.data.length : 0, entry.type || '0'));
    if (entry.data) blocks.push(tarPad(entry.data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Build a valid SKILL.md document. */
export function skillDoc(name, description, extra = '') {
  return `---\nname: ${name}\ndescription: ${description}\n${extra ? `${extra}\n` : ''}---\n\n# ${name}\n\nBody text.\n`;
}
