import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {hostname} from 'node:os';
export class Store {
  constructor(dir) {
    mkdirSync(dir,{recursive:true});
    this.db = new DatabaseSync(join(dir,'city.sqlite'));
    // `actions` is the product-level Action facade (T2 of the pre-assistant closeout). It
    // adapts the existing backends; it never replaces the tasks/nodes/invocations tables.
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta(version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, json TEXT NOT NULL);'
      // JOIN-503: the enrollment registry the City already has semantics for (see
      // city/00-foundation/02-city-node-network/device-identity). Three tables, one row per record,
      // same shape as every other table here: a logical DEVICE, a concrete INSTALLATION of it, and the
      // short-lived SESSIONS the browser may hold. The durable installation credential is never stored -
      // only its fingerprint - so there is nothing in here that could be replayed.
      + ' CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, json TEXT NOT NULL);'
      + ' CREATE TABLE IF NOT EXISTS installations(id TEXT PRIMARY KEY, json TEXT NOT NULL);'
      + ' CREATE TABLE IF NOT EXISTS device_sessions(id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS member_messages(id TEXT PRIMARY KEY, json TEXT NOT NULL);');
    const meta=this.db.prepare('SELECT version FROM meta').get();
    if(meta && meta.version!==0) throw new Error('Unsupported stored schema version');
    if(!meta) this.db.prepare('INSERT INTO meta VALUES(0)').run();
    this.db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run('cityId',randomUUID());
    this.cityId=this.db.prepare('SELECT value FROM settings WHERE key=?').get('cityId').value;
    this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run('cityName',`Utopia · ${hostname()}`);
    this.cityName=this.db.prepare('SELECT value FROM settings WHERE key=?').get('cityName').value;
  }
  renameCity(name) {
    if(typeof name!=='string'||!name.trim()||name.trim().length>64||/[\u0000-\u001f\u007f]/.test(name)) throw Object.assign(new Error('City name must contain 1–64 characters'),{status:400});
    this.cityName=name.trim();
    this.db.prepare('UPDATE settings SET value=? WHERE key=?').run(this.cityName,'cityName');
    return this.cityName;
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
