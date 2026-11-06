// Omslag via iTunes Search API (öppet, ingen nyckel). Strypt till ~15 anrop/min och cachat på disk.
import fsp from 'node:fs/promises';
import { COVER_CACHE_FILE, COVERS_ONLINE } from './config.js';
import { JsonStore, normKey, similarity, nfc } from './util.js';

const store = new JsonStore(COVER_CACHE_FILE, { entries: {} });
const pending = new Map();
const MIN_GAP_MS = 4000;
const TTL_MISS = 7 * 24 * 3600 * 1000;
let lastCall = 0;
let chain = Promise.resolve();

const key = (artist, title) => `${normKey(artist)}|${normKey(title)}`;

export function cachedCover(artist, title) {
  const e = store.data.entries[key(artist, title)];
  if (!e) return undefined;
  if (!e.url && Date.now() - e.at > TTL_MISS) return undefined;
  return e.url || null;
}

async function itunesLookup(artist, title) {
  const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('term', nfc(`${artist} ${title}`));
  url.searchParams.set('entity', 'song');
  url.searchParams.set('limit', '5');
  url.searchParams.set('country', 'se');
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`iTunes ${res.status}`);
  const j = await res.json();
  const best = (j.results || [])
    .map((r) => ({ r, s: similarity(`${artist} ${title}`, `${r.artistName} ${r.trackName}`) + similarity(artist, r.artistName) }))
    .sort((a, b) => b.s - a.s)[0];
  if (!best || best.s < 0.5 || !best.r.artworkUrl100) return null;
  return best.r.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.');
}

export function lookupCover(artist, title) {
  if (!COVERS_ONLINE || !nfc(title)) return Promise.resolve(null);
  const k = key(artist, title);
  const c = cachedCover(artist, title);
  if (c !== undefined) return Promise.resolve(c);
  if (pending.has(k)) return pending.get(k);
  const p = (chain = chain.then(() => itunesLookup(artist, title)).catch(() => null))
    .then((u) => {
      store.data.entries[k] = { url: u, at: Date.now() };
      store.save();
      return u;
    })
    .finally(() => pending.delete(k));
  pending.set(k, p);
  return p;
}

export const pendingLookups = () => pending.size;

export async function downloadCover(url, destPath) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`omslag ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error('omslaget är tomt');
  await fsp.writeFile(destPath, buf);
}

export const flushCoverCache = () => store.flush();
