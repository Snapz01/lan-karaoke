// Spelhistorik: append-only JSONL (en rad per låt som sjungits klart) + topplistor.
import fs from 'node:fs';
import { PLAYS_FILE } from './config.js';
import { singerKey } from './fair-queue.js';

let plays = [];
try {
  plays = fs.readFileSync(PLAYS_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
} catch { /* ingen historik än */ }

export function logPlay(entry) {
  plays.push(entry);
  fs.appendFile(PLAYS_FILE, `${JSON.stringify(entry)}\n`, 'utf8', (e) => e && console.error('[stats]', e.message));
}

// "Ikväll" börjar 06:00 – en fest som går över midnatt räknas som samma kväll
export function eveningStart(now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  d.setHours(6, 0, 0, 0);
  return d.getTime();
}

export function topSongs(from = 0, limit = 30) {
  const map = new Map();
  for (const p of plays) {
    if (p.at < from) continue;
    const e = map.get(p.songId) || { songId: p.songId, title: p.title, artist: p.artist, count: 0, lastAt: 0, singers: new Set() };
    e.count++;
    e.lastAt = Math.max(e.lastAt, p.at);
    if (p.singer) e.singers.add(p.singer);
    map.set(p.songId, e);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, limit)
    .map((e) => ({ ...e, singers: [...e.singers].slice(0, 4) }));
}

export function topSingers(from = 0, limit = 10) {
  const map = new Map();
  for (const p of plays) {
    if (p.at < from || !singerKey(p.singer)) continue;
    const k = singerKey(p.singer);
    const e = map.get(k) || { singer: p.singer, count: 0, applause: 0 };
    e.count++;
    e.applause += p.applause || 0;
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.applause - a.applause).slice(0, limit);
}

export const recentPlays = (limit = 50) => [...plays].sort((a, b) => b.at - a.at).slice(0, limit);
export const totalPlays = (from = 0) => plays.filter((p) => p.at >= from).length;
