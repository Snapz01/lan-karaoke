import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, vttToLrc, isSyncedLrc, formatTs } from '../public/lrc.js';

test('standard-LRC, flera tidsstämplar, BOM och offset', () => {
  const p = parseLrc('﻿[ar:Gyllene Tider]\n[offset:+500]\n[00:12.50][01:30.00]Sommartider hej hej\n[00:18.00]\n');
  assert.equal(p.meta.ar, 'Gyllene Tider');
  assert.deepEqual(p.lines.map((l) => [l.t, l.text]), [[12, 'Sommartider hej hej'], [17.5, ''], [89.5, 'Sommartider hej hej']]);
});

test('Enhanced LRC ger ordtider och bevarar å/ä/ö', () => {
  const p = parseLrc('[00:15.20]<00:15.20>Å <00:15.80>vad <00:16.10>skönt');
  assert.equal(p.hasWordTimes, true);
  assert.deepEqual(p.lines[0].words.map((w) => w.text.trim()), ['Å', 'vad', 'skönt']);
  assert.equal(p.lines[0].text, 'Å vad skönt');
});

test('duett-röster gäller tills de byts', () => {
  const p = parseLrc('[00:01.00]M: Han\n[00:02.00]Han igen\n[00:03.00]F: Hon\n[00:04.00]Båda: Alla');
  assert.deepEqual(p.lines.map((l) => l.voice), [1, 1, 2, 'all']);
  assert.equal(p.lines[0].text, 'Han');
});

test('vanlig text med kolon tolkas inte som röst', () => {
  const p = parseLrc('[00:01.00]Klockan: tolv');
  assert.equal(p.lines[0].voice, null);
  assert.equal(p.hasVoices, false);
});

test('VTT (auto-captions) dedupliceras och [Musik] blir paus', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000 align:start position:0%\n \nhej<00:00:01.500><c> där</c>\n\n00:00:03.000 --> 00:00:03.010\nhej där\n\n00:00:03.010 --> 00:00:05.000\nhej där\nnu<00:00:03.500><c> kör</c>\n\n00:00:05.000 --> 00:00:07.000\n[Musik]';
  assert.equal(vttToLrc(vtt), '[00:01.00]hej där\n[00:03.01]nu kör\n[00:05.00]');
});

test('VTT (manuell) slår ihop rader och avkodar entiteter', () => {
  assert.equal(vttToLrc('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nFörsta\nandra &amp; tredje'), '[00:01.00]Första andra & tredje');
});

test('isSyncedLrc och formatTs', () => {
  assert.equal(isSyncedLrc('[00:01.00]a\n[00:02.00]b\n[00:03.00]c'), true);
  assert.equal(isSyncedLrc('bara text'), false);
  assert.equal(formatTs(75.5), '01:15.50');
});
