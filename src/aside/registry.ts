import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ExecutionUncertainError } from '../types.js';

interface Entry { sessionId: string; marker: string; mac: string }
interface Data { schema: 1; entries: Entry[] }
const ID = /^[A-Za-z0-9_-]{6,128}$/;
const MARKER = /^[a-f0-9]{48}$/;
const HASH = /^[a-f0-9]{64}$/;
function blocked(): never { throw new ExecutionUncertainError('registry_integrity_unknown'); }

/** An authenticated local capability registry, independent of caller-provided session IDs. */
export class SessionRegistry {
  constructor(readonly path: string, readonly keyPath: string) {
    if (!isAbsolute(path) || !isAbsolute(keyPath) || path === keyPath) throw new TypeError('absolute distinct registry paths required');
  }
  private async key(create: boolean): Promise<Buffer> {
    if (create) {
      try {
        const file = await open(this.keyPath, 'wx', 0o600);
        try { await file.writeFile(randomBytes(32)); await file.sync(); }
        finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') blocked();
      }
    }
    try {
      const key = await readFile(this.keyPath);
      if (key.length !== 32) blocked();
      return key;
    } catch { blocked(); }
  }
  private mac(key: Buffer, sessionId: string, marker: string): string {
    return createHmac('sha256', key).update(`aside-session-v1\0${sessionId}\0${marker}`).digest('hex');
  }
  private async read(key: Buffer): Promise<Entry[]> {
    let source: Buffer;
    try { source = await readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      blocked();
    }
    if (source.length > 1024 * 1024) blocked();
    let parsed: unknown;
    try { parsed = JSON.parse(source.toString('utf8')); } catch { blocked(); }
    if (!parsed || typeof parsed !== 'object' || (parsed as Data).schema !== 1 || !Array.isArray((parsed as Data).entries)) blocked();
    const entries = (parsed as Data).entries;
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry || !ID.test(entry.sessionId) || !MARKER.test(entry.marker) || !HASH.test(entry.mac) || seen.has(entry.sessionId)) blocked();
      seen.add(entry.sessionId);
      const expected = Buffer.from(this.mac(key, entry.sessionId, entry.marker), 'hex');
      if (!timingSafeEqual(expected, Buffer.from(entry.mac, 'hex'))) blocked();
    }
    return entries;
  }
  async find(sessionId: string): Promise<string | undefined> {
    if (!ID.test(sessionId)) return undefined;
    const key = await this.key(false);
    return (await this.read(key)).find(x => x.sessionId === sessionId)?.marker;
  }
  async add(sessionId: string, marker: string): Promise<void> {
    if (!ID.test(sessionId) || !MARKER.test(marker)) blocked();
    const key = await this.key(true);
    const entries = await this.read(key);
    if (entries.some(e => e.sessionId === sessionId || e.marker === marker)) blocked();
    entries.push({ sessionId, marker, mac: this.mac(key, sessionId, marker) });
    const tmp = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const file = await open(tmp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ schema: 1, entries } satisfies Data)); await file.sync(); }
      finally { await file.close(); }
      await rename(tmp, this.path);
    } catch { await unlink(tmp).catch(() => {}); blocked(); }
  }
}
