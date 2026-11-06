import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fairInsertIndex, countForSinger } from '../lib/fair-queue.js';

const insert = (q, singer, now) => { const i = fairInsertIndex(q, singer, now); q.splice(i, 0, { singer }); return q.map((e) => e.singer); };

test('andra låten hamnar efter allas första', () => {
  const q = [];
  insert(q, 'Anna'); insert(q, 'Anna'); insert(q, 'Erik'); insert(q, 'Åsa');
  assert.deepEqual(q.map((e) => e.singer), ['Anna', 'Erik', 'Åsa', 'Anna']);
});

test('den som sjunger nu räknas som ett varv', () => {
  const q = [{ singer: 'Erik' }];
  assert.deepEqual(insert(q, 'Anna', 'Anna'), ['Erik', 'Anna']);
  assert.deepEqual(insert(q, 'Bo', 'Anna'), ['Erik', 'Bo', 'Anna']);
});

test('namn jämförs utan skiftläge/diakritik, anonyma läggs sist', () => {
  const q = [{ singer: 'åsa' }, { singer: 'Erik' }];
  assert.equal(fairInsertIndex(q, 'Åsa'), 2);
  assert.equal(fairInsertIndex(q, ''), 2);
  assert.equal(countForSinger(q, 'ASA'), 1);
});
