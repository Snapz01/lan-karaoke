import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixUploadName, decodeTextSmart, foldDiacritics, cleanTitle, parseFilenameMeta, similarity, RateLimiter, num } from '../lib/util.js';

test('fixUploadName reparerar latin1-avkodad UTF-8 men rör inte korrekta namn', () => {
  const mangled = Buffer.from('Björn – Sång.mp3', 'utf8').toString('latin1');
  assert.equal(fixUploadName(mangled), 'Björn – Sång.mp3');
  assert.equal(fixUploadName('Björn.mp3'), 'Björn.mp3');
  assert.equal(fixUploadName('🎤 Låt.mp3'), '🎤 Låt.mp3');
  assert.equal(fixUploadName('ånge.mp3'), 'ånge.mp3'); // NFD → NFC
});

test('decodeTextSmart: UTF-8, CP1252, UTF-16LE med BOM', () => {
  assert.equal(decodeTextSmart(Buffer.from('[00:01.00]Får jag', 'utf8')), '[00:01.00]Får jag');
  assert.equal(decodeTextSmart(Buffer.from([0x46, 0xe5, 0x72])), 'Får');
  assert.equal(decodeTextSmart(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Öl', 'utf16le')])), 'Öl');
});

test('foldDiacritics och cleanTitle', () => {
  assert.equal(foldDiacritics('Håkan Hellström Ørn'), 'Hakan Hellstrom Orn');
  assert.equal(cleanTitle('Sommartider (Remastered 2011)'), 'Sommartider');
  assert.equal(cleanTitle('Främling - 2004 Remaster'), 'Främling');
  assert.equal(cleanTitle('Song feat. Someone'), 'Song');
});

test('parseFilenameMeta', () => {
  assert.deepEqual(parseFilenameMeta('03 - Gyllene_Tider - Sommartider.mp3'), { artist: 'Gyllene Tider', title: 'Sommartider' });
  assert.deepEqual(parseFilenameMeta('Bara titel.flac'), { artist: '', title: 'Bara titel' });
});

test('similarity ignorerar diakritik och skiftläge', () => {
  assert.equal(similarity('Håkan Hellström', 'hakan hellstrom'), 1);
  assert.ok(similarity('ABBA Dancing Queen', 'Queen Bohemian') < 0.3);
});

test('RateLimiter', () => {
  const rl = new RateLimiter({ capacity: 2, refillPerSec: 0 });
  assert.equal(rl.take('a'), true); assert.equal(rl.take('a'), true); assert.equal(rl.take('a'), false); assert.equal(rl.take('b'), true);
});

test('num', () => { assert.equal(num('3'), 3); assert.equal(num('x', 7), 7); assert.equal(num(null, 1), 1); });
