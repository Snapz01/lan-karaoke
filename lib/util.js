// Rena hjälpfunktioner + atomisk JSON-lagring. Inga npm-beroenden (testbara med node:test).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const nfc = (s) => (typeof s === 'string' ? s.normalize('NFC').trim() : '');
export const newId = () => crypto.randomBytes(6).toString('base64url');
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const num = (v, d = 0) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

// Multer/busboy avkodar filnamn som latin1. Rätta till UTF-8 utan att förstöra redan korrekta namn.
export function fixUploadName(name) {
  if (!name) return '';
  if (/[^\u0000-ÿ]/.test(name)) return nfc(name);
  const conv = Buffer.from(name, 'latin1').toString('utf8');
  return nfc(conv.includes('�') ? name : conv);
}

// LRC-filer från Windows är ofta CP1252 eller UTF-16. Prova UTF-8 strikt först.
export function decodeTextSmart(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2)).normalize('NFC');
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2)).normalize('NFC');
  const b = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b).normalize('NFC'); }
  catch { return new TextDecoder('windows-1252').decode(b).normalize('NFC'); }
}

export function foldDiacritics(s) {
  const map = { æ: 'ae', Æ: 'Ae', ø: 'o', Ø: 'O', ß: 'ss' };
  return nfc(s).replace(/[æÆøØß]/g, (c) => map[c])
    .normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

export function cleanTitle(s) {
  return nfc(s)
    .replace(/\s*[([{][^)\]}]*(remaster|live|version|edit|mix|lyrics?|text|official|video|audio|karaoke|instrumental|hd|hq|4k|feat\.?|ft\.?)[^)\]}]*[)\]}]/gi, '')
    .replace(/\s+-\s+(\d{4}\s+)?remaster(ed)?.*$/i, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .replace(/\s*[|•].*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const stripSpecial = (s) => foldDiacritics(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
export const normKey = (s) => stripSpecial(s).toLowerCase();

export function similarity(a, b) {
  const ta = new Set(normKey(a).split(' ').filter(Boolean));
  const tb = new Set(normKey(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function parseFilenameMeta(filename) {
  let base = nfc(path.parse(filename).name).replace(/_/g, ' ').replace(/\s{2,}/g, ' ');
  base = base.replace(/^\d{1,3}\s*[-.)]\s*/, ''); // spårnummer
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: cleanTitle(parts.slice(1).join(' - ')) };
  return { artist: '', title: cleanTitle(base) };
}

export function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function fileExists(p) { try { await fsp.access(p); return true; } catch { return false; } }

export async function moveFile(src, dst) {
  try { await fsp.rename(src, dst); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dst);
    await fsp.unlink(src);
  }
}

export async function dirSize(dir) {
  let total = 0;
  for (const ent of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += await dirSize(p);
    else total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export async function freeBytes(dir) {
  try { const st = await fsp.statfs(dir); return { total: st.blocks * st.bsize, free: st.bavail * st.bsize }; }
  catch { return null; }
}

// Atomisk JSON-lagring: skriv tmp → rename. Debounce så att många ändringar blir en skrivning.
export class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.data = structuredClone(defaults);
    this.timer = null;
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[store] Kunde inte läsa ${file}:`, e.message);
    }
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this.timer);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

// Enkel token bucket per nyckel (IP/klient-id)
export class RateLimiter {
  constructor({ capacity, refillPerSec }) {
    this.capacity = capacity;
    this.refill = refillPerSec;
    this.buckets = new Map();
  }
  take(key, cost = 1) {
    const now = Date.now();
    const b = this.buckets.get(key) || { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refill);
    b.at = now;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    this.buckets.set(key, b);
    if (this.buckets.size > 2000) this.buckets.delete(this.buckets.keys().next().value);
    return ok;
  }
}
