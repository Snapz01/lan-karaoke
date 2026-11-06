import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnalysis, gainFor, suggestOffsetMs } from '../lib/analysis.js';
import { detectLang, autoTags } from '../lib/tags.js';
import { searchStrategies } from '../lib/lrclib.js';
import { friendlyYtError, pickBestAudioMatch } from '../lib/ytdlp.js';
import { parseBlocks } from '../lib/system-audio.js';

test('ffmpeg-analys: loudness och inledande tystnad', () => {
  const stderr = '[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 2.35 | silence_duration: 2.35\n[Parsed_loudnorm_1 @ 0x2] \n{\n\t"input_i" : "-9.80",\n\t"input_tp" : "-0.30",\n\t"input_lra" : "6.1"\n}\n';
  const a = parseAnalysis(stderr);
  assert.deepEqual(a, { lufs: -9.8, truePeak: -0.3, leadSilence: 2.35 });
  assert.equal(gainFor(a), -6.2);
  assert.equal(gainFor({ lufs: -25, truePeak: -6 }), 5.5); // begränsas av true peak
  assert.equal(gainFor({ lufs: -80, truePeak: -80 }), 0);
});

test('synkförslag bara när YouTube-versionen är längre och börjar tyst', () => {
  assert.equal(suggestOffsetMs({ mediaDuration: 208, lyricsDuration: 205, leadSilence: 2.4 }), -2400);
  assert.equal(suggestOffsetMs({ mediaDuration: 205.5, lyricsDuration: 205, leadSilence: 3 }), 0);
  assert.equal(suggestOffsetMs({ mediaDuration: 215, lyricsDuration: 205, leadSilence: 0.2 }), 0);
});

test('språkdetektering och taggar', () => {
  assert.equal(detectLang('jag och du det är inte så att vi har med mig och dig'), 'sv');
  assert.equal(detectLang('i love you and the night is my love to you in the dark'), 'en');
  assert.deepEqual(autoTags({ artist: 'Lasse Stefanz', title: 'De sista ljuva åren' }).sort(), ['dansband', 'sv']);
  assert.ok(autoTags({ artist: 'Queen', title: 'Bohemian Rhapsody' }).includes('en'));
});

test('LRCLIB-strategier: split, städning, diakritik', () => {
  const s = searchStrategies('Håkan Hellström - Känn ingen sorg (Live)');
  assert.deepEqual(s[0], { q: 'Håkan Hellström - Känn ingen sorg (Live)' });
  assert.ok(s.some((x) => x.artist_name === 'Håkan Hellström'));
  assert.ok(s.some((x) => x.q === 'Hakan Hellstrom - Kann ingen sorg'));
});

test('yt-dlp: felöversättning och ljudval efter längd', () => {
  assert.match(friendlyYtError("Sign in to confirm you're not a bot"), /cookies\.txt/);
  const best = pickBestAudioMatch([
    { title: 'X (Karaoke)', duration: 205, channel: '' },
    { title: 'X', duration: 204, channel: 'X - Topic' },
    { title: 'X live', duration: 260, channel: '' },
  ], 205, false);
  assert.equal(best.r.channel, 'X - Topic');
});

test('pactl long-format parsas', () => {
  const txt = 'Sink #52\n\tState: RUNNING\n\tName: alsa_output.pci-0000_00_0e.0.hdmi-stereo\n\tDescription: Built-in Audio Digital Stereo (HDMI)\n\nSink #53\n\tState: SUSPENDED\n\tName: alsa_output.analog\n\tDescription: Hörlurar\n';
  const b = parseBlocks(txt, 'Sink #');
  assert.equal(b.length, 2);
  assert.equal(b[0].name, 'alsa_output.pci-0000_00_0e.0.hdmi-stereo');
  assert.equal(b[1].description, 'Hörlurar');
});
