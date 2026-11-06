import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATA_DIR = `/tmp/kar-stats-${process.pid}`;
(await import('node:fs')).mkdirSync(process.env.DATA_DIR, { recursive: true });
const { logPlay, topSongs, topSingers, eveningStart, recentPlays } = await import('../lib/stats.js');

test('ikväll börjar 06:00, även efter midnatt', () => {
  assert.equal(new Date(eveningStart(new Date('2026-11-07T02:30:00'))).toString(), new Date('2026-11-06T06:00:00').toString());
  assert.equal(new Date(eveningStart(new Date('2026-11-06T21:00:00'))).toString(), new Date('2026-11-06T06:00:00').toString());
});

test('topplistor räknar låtar och sångare', () => {
  const t = Date.now();
  logPlay({ at: t - 1000, songId: 'a', title: 'Sommartider', artist: 'Gyllene Tider', singer: 'Anna', applause: 5 });
  logPlay({ at: t - 500, songId: 'a', title: 'Sommartider', artist: 'Gyllene Tider', singer: 'Erik', applause: 2 });
  logPlay({ at: t, songId: 'b', title: 'Africa', artist: 'Toto', singer: 'anna', applause: 1 });
  logPlay({ at: 1000, songId: 'c', title: 'Gammal', artist: 'X', singer: 'Bo' });
  assert.deepEqual(topSongs(eveningStart()).map((e) => [e.songId, e.count]), [['a', 2], ['b', 1]]);
  assert.equal(topSongs(0).length, 3);
  assert.deepEqual(topSingers(eveningStart()).map((s) => [s.singer, s.count, s.applause]), [['Anna', 2, 6], ['Erik', 1, 2]]);
  assert.equal(recentPlays(1)[0].songId, 'b');
});
