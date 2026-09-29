import { statfs } from 'node:fs/promises';
// Independent volume adapter; Node delegates to the native filesystem API.
export async function readDisk(path=process.cwd()) {
 const s=await statfs(path);const totalBytes=s.blocks*s.bsize,freeBytes=s.bfree*s.bsize;
 return {usedBytes:totalBytes-freeBytes,freeBytes,totalBytes};
}
