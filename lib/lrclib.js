// LRCLIB-klient med smart dubbelsökning för svenska/engelska titlar.
// API: /api/get (track_name+artist_name krävs, album/duration valfria, ±2 s tolerans), /api/search (q eller track_name), /api/get/{id}.
import { USER_AGENT } from './config.js';
import { isSyncedLrc } from '../public/lrc.js';
import { nfc, num, cleanTitle, foldDiacritics, stripSpecial, similarity } from './util.js';

const LRCLIB = 'https://lrclib.net/api';
const cache = new Map(); // id -> record

function remember(rec) {
  if (!rec?.id) return;
  cache.set(rec.id, rec);
  if (cache.size > 800) cache.delete(cache.keys().next().value);
}

export async function lrclibRequest(endpoint, params = {}) {
  const url = new URL(`${LRCLIB}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, nfc(String(v)));
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Lrclib-Client': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  const json = await res.json();
  if (Array.isArray(json)) json.forEach(remember); else remember(json);
  return json;
}

export const toCandidate = (r) => ({
  id: r.id, artist: nfc(r.artistName || ''), title: nfc(r.trackName || r.name || ''), album: nfc(r.albumName || ''),
  duration: Math.round(num(r.duration)), synced: isSyncedLrc(r.syncedLyrics), instrumental: !!r.instrumental,
});

// Exakt → artist/titel-split → städad → diakritik-vikt → specialtecken strippade → bara titel.
export function searchStrategies(query, { artist, title } = {}) {
  const q = nfc(query);
  const out = [];
  if (artist && title) out.push({ artist_name: artist, track_name: title });
  if (q) out.push({ q });
  const split = q.split(/\s+[-–—]\s+/);
  if (split.length === 2) out.push({ artist_name: split[0], track_name: split[1] });
  const cleaned = cleanTitle(q);
  if (cleaned && cleaned !== q) out.push({ q: cleaned });
  const folded = foldDiacritics(cleaned || q);
  if (folded !== (cleaned || q)) out.push({ q: folded });
  const stripped = stripSpecial(cleaned || q);
  if (stripped && stripped !== folded) out.push({ q: stripped });
  if (title) out.push({ track_name: cleanTitle(title) });
  return out;
}

export async function searchLyricsCandidates(query, { artist, title } = {}) {
  const seen = new Map();
  for (const params of searchStrategies(query, { artist, title })) {
    let results = [];
    try { results = (await lrclibRequest('search', params)) || []; }
    catch (e) { console.warn('[lrclib] sökning misslyckades:', e.message); continue; }
    for (const r of results) if (!seen.has(r.id)) seen.set(r.id, r);
    if ([...seen.values()].filter((r) => isSyncedLrc(r.syncedLyrics)).length >= 6) break;
  }
  const ref = artist && title ? `${artist} ${title}` : nfc(query);
  return [...seen.values()]
    .map((r) => ({ ...toCandidate(r), score: similarity(ref, `${r.artistName} ${r.trackName}`) }))
    .sort((a, b) => (b.synced - a.synced) || (b.score - a.score))
    .slice(0, 25);
}

export async function lrclibById(id) {
  return cache.get(Number(id)) || cache.get(id) || (await lrclibRequest(`get/${encodeURIComponent(id)}`));
}

// Bästa synkade text för känd artist/titel/längd (uppladdning, omhämtning).
export async function findBestLyrics({ artist, title, album, duration }) {
  artist = nfc(artist); title = nfc(title);
  if (!title) return null;
  const tries = [];
  if (artist) {
    tries.push({ artist_name: artist, track_name: title, album_name: album, duration: duration ? Math.round(duration) : undefined });
    tries.push({ artist_name: artist, track_name: title });
    const ct = cleanTitle(title);
    if (ct !== title) tries.push({ artist_name: artist, track_name: ct });
  }
  for (const p of tries) {
    try {
      const r = await lrclibRequest('get', p);
      if (r && isSyncedLrc(r.syncedLyrics)) return { lrc: r.syncedLyrics, lrclibId: r.id, duration: num(r.duration) };
    } catch (e) { console.warn('[lrclib] get:', e.message); }
  }
  const cands = await searchLyricsCandidates(`${artist} ${title}`.trim(), { artist, title });
  const scored = cands.filter((c) => c.synced).map((c) => {
    const dd = duration && c.duration ? Math.abs(c.duration - duration) : 0;
    return { c, s: c.score * 10 - (dd > 15 ? 5 : dd / 3) };
  }).sort((a, b) => b.s - a.s);
  if (!scored.length || scored[0].c.score < 0.2) return null;
  const rec = await lrclibById(scored[0].c.id);
  return rec?.syncedLyrics ? { lrc: rec.syncedLyrics, lrclibId: rec.id, duration: num(rec.duration) } : null;
}
