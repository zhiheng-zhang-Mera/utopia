import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
export class Store {
  constructor(dir) {
    mkdirSync(dir,{recursive:true});
    this.db = new DatabaseSync(join(dir,'city.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta(version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,json TEXT NOT NULL);');
    const meta=this.db.prepare('SELECT version FROM meta').get();
    if(meta && meta.version!==0) throw new Error('Unsupported stored schema version');
    if(!meta) this.db.prepare('INSERT INTO meta VALUES(0)').run();
  }
  list(table) { return this.db.prepare(`SELECT json FROM ${table} ORDER BY rowid`).all().map(r=>JSON.parse(r.json)); }
  get(table,id) { const r=this.db.prepare(`SELECT json FROM ${table} WHERE id=?`).get(id); return r?JSON.parse(r.json):null; }
  put(table,value) { this.db.prepare(`INSERT INTO ${table}(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`).run(value.id,JSON.stringify(value)); return value; }
  event(type,taskId=null,payload={},actor='gateway') {
    const event={id:randomUUID(),timestamp:new Date().toISOString(),type,actor,taskId,payload};
    const r=this.db.prepare('INSERT INTO events(json) VALUES(?)').run(JSON.stringify(event));
    return {...event,seq:Number(r.lastInsertRowid)};
  }
  events(after=0) { return this.db.prepare('SELECT seq,json FROM events WHERE seq>? ORDER BY seq').all(after).map(r=>({...JSON.parse(r.json),seq:r.seq})); }
  atomic(fn) { this.db.exec('BEGIN IMMEDIATE'); try {const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;} }
  close(){this.db.close();}
}
