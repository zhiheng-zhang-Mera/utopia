import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

// Windows reference adapter. Core task semantics depend only on this interface.
export class FilesystemAdapter {
 constructor(root){this.root=resolve(root);}
 path(id){if(!/^Q-[a-f0-9-]+$/.test(id))throw new Error('Invalid task workspace');const p=resolve(this.root,id);const rel=relative(this.root,p);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('Unsafe workspace');return p;}
 async create(id){const p=this.path(id);await mkdir(p,{recursive:true});const data='Utopia real task artifact\n'+id+'\n';await writeFile(resolve(p,'artifact.txt'),data);return Buffer.byteLength(data);}
 async hash(id){return createHash('sha256').update(await readFile(resolve(this.path(id),'artifact.txt'))).digest('hex');}
 async checkpoint(id,value){await writeFile(resolve(this.path(id),'checkpoint.json'),JSON.stringify(value));}
 async cleanup(id){await rm(this.path(id),{recursive:true,force:true});}
}
