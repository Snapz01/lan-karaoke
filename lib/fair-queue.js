// Rättvis kö (round-robin per sångare). Ren logik utan sidoeffekter – testas i test/fair-queue.test.js.
import { foldDiacritics } from './util.js';

export const singerKey = (s) => foldDiacritics(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Varje post får ett "varv" = antal tidigare poster av samma sångare (+1 om sångaren står på scenen nu).
// Ny post läggs före första posten med högre varv → ingen får sin andra låt innan alla fått sin första.
export function fairInsertIndex(queue, singer, nowSinger = '') {
  const key = singerKey(singer);
  if (!key) return queue.length; // anonym: sist
  const counts = new Map();
  const nowKey = singerKey(nowSinger);
  if (nowKey) counts.set(nowKey, 1);
  const rounds = queue.map((e) => {
    const k = singerKey(e.singer);
    if (!k) return 0;
    const r = counts.get(k) || 0;
    counts.set(k, r + 1);
    return r;
  });
  const myRound = counts.get(key) || 0;
  const idx = rounds.findIndex((r) => r > myRound);
  return idx < 0 ? queue.length : idx;
}

export function countForSinger(queue, singer) {
  const key = singerKey(singer);
  if (!key) return 0;
  return queue.filter((e) => singerKey(e.singer) === key).length;
}
