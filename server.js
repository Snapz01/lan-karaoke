// LAN Karaoke – server
// Express + Socket.io. Serverar /tv (kiosk) och /remote (mobil). Logik som går att testa isolerat ligger i lib/.
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Server as SocketServer } from 'socket.io';
import multer from 'multer';
import QRCode from 'qrcode';
import { parseFile as parseMediaFile } from 'music-metadata';
import { parseLrc, isSyncedLrc } from './public/lrc.js';
import * as C from './lib/config.js';
import {
  nfc, newId, clamp, num, fixUploadName, decodeTextSmart, parseFilenameMeta, timingSafeEqualStr,
  fileExists, moveFile, dirSize, freeBytes, JsonStore, RateLimiter, normKey,
} from './lib/util.js';
import { autoTags, TAGS } from './lib/tags.js';
import { searchLyricsCandidates, findBestLyrics, lrclibById } from './lib/lrclib.js';
import {
  YT_ID_RE, ytSearch, ytDownload, ytLyricsFallback, ytdlpVersion, pickBestAudioMatch, hasCookies, saveCookies, deleteCookies,
} from './lib/ytdlp.js';
import { analyzeFile, gainFor, suggestOffsetMs, analysisQueueLength } from './lib/analysis.js';
import { lookupCover, cachedCover, pendingLookups, downloadCover, flushCoverCache } from './lib/covers.js';
import { listOutputs, selectOutput, restoreOutput } from './lib/system-audio.js';
import { fairInsertIndex, countForSinger, singerKey } from './lib/fair-queue.js';
import { currentVersion, checkUpdate, applyUpdate, rollback } from './lib/updater.js';
import { analyzeSync } from './lib/autosync.js';
import { logPlay, topSongs, topSingers, recentPlays, totalPlays, eveningStart } from './lib/stats.js';

C.ensureDirs();
const STARTED_AT = Date.now();
const SECRET = crypto.randomBytes(16);
const ownerTag = (clientId) => (clientId ? crypto.createHmac('sha256', SECRET).update(clientId).digest('base64url').slice(0, 12) : null);
// Värd = karaokedatorn själv (localhost) eller någon som angett PIN. Utan PIN kan bara datorn själv administrera.
const pinOk = (pin) => !!C.ADMIN_PIN && timingSafeEqualStr(pin || '', C.ADMIN_PIN);
const isLocalAddr = (a) => C.TRUST_LOCALHOST && /^(127\.|::1$|::ffff:127\.)/.test(a || '');
const relMedia = (p) => path.relative(C.MEDIA_DIR, p).split(path.sep).join('/');

// ───────────────────────────── Lagring ─────────────────────────────
const library = new JsonStore(C.LIBRARY_FILE, { version: 2, songs: {} });
const queueStore = new JsonStore(C.QUEUE_FILE, { queue: [], now: null, history: [] });

const DEFAULT_SETTINGS = {
  volume: 0.85, muted: false, textSize: 'normal', theme: 'neon',
  pitch: 0, speed: 1, mono: false, vocalReduce: 0, eqLow: 0, eqMid: 0, eqHigh: 0, normalize: true,
  qrVisible: true, reactionsEnabled: true, overscan: 0, autoPlay: true,
  introSeconds: 5, maxVideoHeight: 720, preferInstrumental: false,
  fairQueue: true, maxPerSinger: 3, hostMode: false, voteSkipPercent: 50, wifiQrVisible: true,
  autoSync: true, autoLatency: true, avLatencyMs: 0,
};
const settingsStore = new JsonStore(C.SETTINGS_FILE, DEFAULT_SETTINGS);
const settings = settingsStore.data;
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (settings[k] === undefined) settings[k] = v; // nya nycklar efter uppgradering

const SIMPLE_KEYS = new Set(['volume', 'muted', 'textSize', 'theme', 'vocalReduce']); // vocalReduce = "Artistens röst"
const SETTING_RULES = {
  volume: (v) => clamp(num(v, 0.85), 0, 1),
  muted: (v) => !!v,
  textSize: (v) => (['normal', 'large', 'xlarge'].includes(v) ? v : 'normal'),
  theme: (v) => (['neon', 'midnight', 'gold', 'video'].includes(v) ? v : 'neon'),
  pitch: (v) => clamp(Math.round(num(v)), -6, 6),
  speed: (v) => Math.round(clamp(num(v, 1), 0.8, 1.2) * 100) / 100,
  mono: (v) => !!v,
  vocalReduce: (v) => clamp(num(v), 0, 1),
  eqLow: (v) => clamp(num(v), -12, 12),
  eqMid: (v) => clamp(num(v), -12, 12),
  eqHigh: (v) => clamp(num(v), -12, 12),
  normalize: (v) => !!v,
  qrVisible: (v) => !!v,
  reactionsEnabled: (v) => !!v,
  overscan: (v) => clamp(num(v), 0, 5),
  autoPlay: (v) => !!v,
  introSeconds: (v) => clamp(Math.round(num(v, 5)), 0, 15),
  maxVideoHeight: (v) => ([480, 720, 1080].includes(Number(v)) ? Number(v) : 720),
  preferInstrumental: (v) => !!v,
  fairQueue: (v) => !!v,
  maxPerSinger: (v) => clamp(Math.round(num(v, 3)), 0, 10),
  hostMode: (v) => !!v,
  voteSkipPercent: (v) => clamp(Math.round(num(v, 50)), 25, 100),
  wifiQrVisible: (v) => !!v,
  autoSync: (v) => !!v,
  autoLatency: (v) => !!v,
  avLatencyMs: (v) => clamp(Math.round(num(v) / 10) * 10, -300, 800),
};

// ───────────────────────────── Bibliotek ─────────────────────────────
const songs = () => library.data.songs;
const getSong = (id) => (id ? songs()[id] || null : null);

function publicSong(s) {
  if (!s) return null;
  return {
    id: s.id, title: s.title, artist: s.artist, album: s.album || '', duration: s.duration || 0,
    type: s.type, url: `/media/${s.file}`, cover: s.cover ? `/media/${s.cover}` : null,
    hasLyrics: !!s.lrc, lyricsSource: s.lyricsSource || null, lyricsQuality: s.lyricsQuality || null,
    offsetMs: s.offsetMs || 0, suggestedOffsetMs: s.suggestedOffsetMs || 0, gainDb: s.gainDb || 0,
    sync: s.sync ? { scale: s.sync.scale, shiftSec: s.sync.shiftSec, confidence: s.sync.confidence, applied: !!s.sync.applied && !s.sync.disabled, disabled: !!s.sync.disabled } : null,
    tags: s.tags || [], source: s.source, cached: !!s.cached, addedAt: s.addedAt, plays: s.plays || 0,
  };
}

function addSong(data) {
  const song = {
    id: data.id || newId(), title: nfc(data.title) || 'Okänd titel', artist: nfc(data.artist) || 'Okänd artist',
    album: nfc(data.album || ''), duration: num(data.duration), type: data.type, file: data.file,
    cover: data.cover || null, lrc: data.lrc || null, lyricsSource: data.lyricsSource || null,
    lyricsQuality: data.lyricsQuality || (data.lrc ? 'synced' : null), offsetMs: num(data.offsetMs),
    tags: data.tags || [], source: data.source, cached: !!data.cached, ytId: data.ytId || null,
    lrclibId: data.lrclibId || null, lrclibDuration: num(data.lrclibDuration), addedAt: Date.now(), lastPlayedAt: 0, plays: 0,
    gainDb: 0, analyzed: false, suggestedOffsetMs: 0,
  };
  if (!song.tags.length) song.tags = autoTags(song, data.genres);
  songs()[song.id] = song;
  library.save();
  io.emit('library:changed');
  analyzeSong(song.id);
  if (!song.cover || data.preferOnlineCover) improveCover(song.id);
  return song;
}

async function deleteSong(id) {
  const s = getSong(id);
  if (!s) return false;
  await fsp.unlink(path.join(C.MEDIA_DIR, s.file)).catch(() => {});
  if (s.cover) await fsp.unlink(path.join(C.MEDIA_DIR, s.cover)).catch(() => {});
  delete songs()[id];
  library.save();
  const before = player.queue.length;
  player.queue = player.queue.filter((e) => e.songId !== id);
  if (player.queue.length !== before) { saveQueue(); broadcastState(); }
  io.emit('library:changed');
  return true;
}

async function verifyLibrary() {
  let removed = 0;
  for (const s of Object.values(songs())) {
    if (!(await fileExists(path.join(C.MEDIA_DIR, s.file)))) { delete songs()[s.id]; removed++; }
  }
  if (removed) { library.save(); console.log(`[library] Tog bort ${removed} poster utan mediefil`); }
}

// Ljudnormalisering + synkförslag (bakgrund, en åt gången, nice 15)
async function analyzeSong(id) {
  const s = getSong(id);
  if (!s || s.analyzed) return;
  try {
    const a = await analyzeFile(path.join(C.MEDIA_DIR, s.file));
    const cur = getSong(id);
    if (!cur) return;
    cur.gainDb = gainFor(a);
    cur.lufs = a.lufs;
    cur.leadSilence = a.leadSilence;
    cur.suggestedOffsetMs = cur.source === 'lrclib+yt' && !cur.offsetMs
      ? suggestOffsetMs({ mediaDuration: cur.duration, lyricsDuration: cur.lrclibDuration, leadSilence: a.leadSilence }) : 0;
    cur.analyzed = true;
    library.save();
    if (player.now?.songId === id) { io.to('tv').emit('tv:gain', { gainDb: cur.gainDb }); broadcastState(); }
  } catch (e) {
    console.warn(`[analys] ${s.title}:`, e.message);
    const cur = getSong(id);
    if (cur) { cur.analyzed = true; library.save(); } // försök inte igen varje start
  }
  syncSong(id);
}

// ── Automatisk synk (röstanalys). Hoppar över texter som redan är exakta (undertexter från samma video, manuell tap-synk).
const syncQueue = [];
let syncBusy = false;
function needsSync(s) {
  return s && s.lrc && !s.sync && !['youtube-subs', 'manual'].includes(s.lyricsSource) && !(s.type === 'video' && !s.lrc);
}
function syncSong(id, force = false) {
  const s = getSong(id);
  if (!settings.autoSync || !s || (!force && !needsSync(s))) return;
  if (!syncQueue.includes(id)) syncQueue.push(id);
  pumpSync();
}
async function pumpSync() {
  if (syncBusy || !syncQueue.length) return;
  syncBusy = true;
  const id = syncQueue.shift();
  try {
    const s = getSong(id);
    if (s?.lrc) {
      const r = await analyzeSync(path.join(C.MEDIA_DIR, s.file), s.lrc);
      const cur = getSong(id);
      if (cur && cur.lrc === s.lrc) {
        cur.sync = { ...r, disabled: false };
        // Medelsäker träff utan tempoändring → visas som förslag i stället för att tillämpas
        if (!r.applied && r.confidence === 'medium' && !r.nearIdentity && Math.abs(r.scale - 1) < 0.003 && !cur.offsetMs) {
          cur.suggestedOffsetMs = -Math.round(r.shiftSec * 1000 / 50) * 50;
        }
        if (r.applied) cur.suggestedOffsetMs = 0;
        library.save();
        console.log(r.shiftSec == null ? `[synk] ${cur.title}: ingen analys (${r.reason || r.confidence})` : `[synk] ${cur.title}: ${r.confidence} · förskjutning ${r.shiftSec}s · tempo ${r.scale} · träff ${Math.round((r.hitRate || 0) * 100)}%${r.applied ? ' → tillämpad' : ''}`);
        if (player.now?.songId === id) { io.to('tv').emit('tv:sync', { sync: publicSong(cur).sync }); broadcastState(); }
      }
    }
  } catch (e) { console.warn('[synk]', e.message); const cur = getSong(id); if (cur) { cur.sync = { confidence: 'low', applied: false, error: e.message }; library.save(); } }
  finally { syncBusy = false; pumpSync(); }
}
const syncStats = () => {
  const all = Object.values(songs()).filter((s) => s.lrc);
  return { withLyrics: all.length, analyzed: all.filter((s) => s.sync).length, applied: all.filter((s) => s.sync?.applied && !s.sync.disabled).length, pending: syncQueue.length + (syncBusy ? 1 : 0) };
};

// Riktigt albumomslag från iTunes istället för YouTube-miniatyr
async function improveCover(id) {
  const s = getSong(id);
  if (!s || s.source === 'youtube-karaoke') return;
  try {
    const url = await lookupCover(s.artist, s.title);
    if (!url) return;
    const rel = `covers/${s.id}-art.jpg`;
    await downloadCover(url, path.join(C.MEDIA_DIR, rel));
    const cur = getSong(id);
    if (!cur) return;
    if (cur.cover && cur.cover !== rel) await fsp.unlink(path.join(C.MEDIA_DIR, cur.cover)).catch(() => {});
    cur.cover = rel;
    library.save();
    io.emit('library:changed');
    if (player.now?.songId === id) broadcastState();
  } catch (e) { console.warn('[omslag]', e.message); }
}

// ───────────────────────────── Jobb (nedladdningar) ─────────────────────────────
const jobs = new Map();
let runningJobs = 0;
const jobQueue = [];
const JOB_KINDS = {};

const publicJob = (j) => ({ id: j.id, label: j.label, status: j.status, progress: j.progress, error: j.error || null, stage: j.stage || '' });

function startJob(kind, params, owner = null) {
  const job = { id: newId(), kind, params, owner, label: params.label || kind, status: 'queued', progress: 0, stage: 'I kö', createdAt: Date.now() };
  jobs.set(job.id, job);
  jobQueue.push(job);
  pumpJobs();
  broadcastState();
  return job;
}

function pumpJobs() {
  while (runningJobs < C.MAX_PARALLEL_JOBS && jobQueue.length) {
    const job = jobQueue.shift();
    runningJobs++;
    job.status = 'running';
    const update = (patch) => { Object.assign(job, patch); broadcastStateThrottled(); };
    JOB_KINDS[job.kind](job.params, update)
      .then((songId) => { job.status = 'done'; job.progress = 100; job.stage = 'Klar'; resolveQueueJob(job.id, songId); })
      .catch((e) => {
        console.error(`[job ${job.label}]`, e.message);
        job.status = 'error'; job.error = e.message; job.stage = 'Misslyckades';
        failQueueJob(job.id, e.message);
      })
      .finally(() => {
        runningJobs--;
        setTimeout(() => { jobs.delete(job.id); broadcastState(); }, job.status === 'error' ? 30000 : 4000);
        broadcastState();
        pumpJobs();
      });
  }
}

async function ensureDiskSpace() {
  let fb = await freeBytes(C.MEDIA_DIR);
  if (!fb || fb.free >= C.MIN_FREE_BYTES) return;
  await pruneCache({ all: true });
  fb = await freeBytes(C.MEDIA_DIR);
  if (fb && fb.free < C.MIN_FREE_BYTES) throw new Error('Disken är nästan full – ta bort låtar eller rensa cachen.');
}

JOB_KINDS.autotext = async (p, update) => {
  await ensureDiskSpace();
  const rec = await lrclibById(p.lrclibId);
  if (!rec || !isSyncedLrc(rec.syncedLyrics)) throw new Error('Synkad text saknas hos LRCLIB');
  const artist = nfc(rec.artistName); const title = nfc(rec.trackName); const duration = Math.round(num(rec.duration));
  update({ stage: 'Söker ljud på YouTube…', progress: 2 });
  let match = null;
  if (p.preferInstrumental) {
    const best = pickBestAudioMatch(await ytSearch(`${artist} - ${title} instrumental`, 6), duration, true);
    if (best && best.dd <= 3) match = best.r; // annars hamnar texten ur synk
  }
  if (!match) {
    const best = pickBestAudioMatch(await ytSearch(`${artist} - ${title}`, 6), duration, false);
    if (!best) throw new Error('Hittade inget ljud på YouTube');
    match = best.r;
  }
  const id = newId();
  const kind = p.withVideo ? 'video' : 'audio';
  update({ stage: kind === 'video' ? 'Laddar ner musikvideo…' : 'Laddar ner ljud…', progress: 5 });
  const dl = await ytDownload(match.ytId, {
    kind, maxHeight: settings.maxVideoHeight, destDir: C.SONGS_DIR, baseName: id, onProgress: (v) => update({ progress: Math.max(5, v) }),
  });
  return addSong({
    id, title, artist, album: rec.albumName, duration: match.duration || duration, type: kind, file: dl.file, cover: dl.cover,
    lrc: rec.syncedLyrics, lyricsSource: 'lrclib', lrclibId: rec.id, lrclibDuration: duration, source: 'lrclib+yt', ytId: match.ytId,
    preferOnlineCover: true,
  }).id;
};

JOB_KINDS.ytvideo = async (p, update) => {
  const existing = Object.values(songs()).find((s) => s.ytId === p.ytId && s.type === 'video');
  if (existing && (await fileExists(path.join(C.MEDIA_DIR, existing.file)))) return existing.id;
  await ensureDiskSpace();
  const id = newId();
  update({ stage: 'Laddar ner karaoke-video…', progress: 1 });
  const dl = await ytDownload(p.ytId, {
    kind: 'video', maxHeight: settings.maxVideoHeight, destDir: C.CACHE_DIR, baseName: id, onProgress: (v) => update({ progress: v }),
  });
  const meta = parseFilenameMeta(`${p.title}.mp4`);
  const song = addSong({
    id, title: meta.title || p.title, artist: meta.artist || p.channel, duration: p.duration, type: 'video',
    file: dl.file, cover: dl.cover, source: 'youtube-karaoke', cached: true, ytId: p.ytId,
  });
  pruneCache({ exclude: song.id }).catch((e) => console.warn('[cache]', e.message));
  return song.id;
};

JOB_KINDS.ytlyrics = async (p, update) => {
  await ensureDiskSpace();
  update({ stage: 'Letar text-video med undertexter…', progress: 2 });
  const fb = await ytLyricsFallback(p.query);
  if (!fb) throw new Error('Ingen video med användbara undertexter hittades');
  const id = newId();
  update({ stage: 'Laddar ner ljud…', progress: 10 });
  const dl = await ytDownload(fb.ytId, { kind: 'audio', destDir: C.SONGS_DIR, baseName: id, onProgress: (v) => update({ progress: Math.max(10, v) }) });
  const meta = parseFilenameMeta(`${fb.title}.x`);
  return addSong({
    id, title: meta.title || fb.title, artist: meta.artist || fb.artist, duration: fb.duration, type: 'audio',
    file: dl.file, cover: dl.cover, lrc: fb.lrc, lyricsSource: 'youtube-subs', lyricsQuality: fb.auto ? 'auto' : 'synced',
    source: 'youtube-subs', ytId: fb.ytId, preferOnlineCover: true,
  }).id;
};

async function pruneCache({ all = false, exclude = null } = {}) {
  const busy = new Set([exclude, player.now?.songId, ...player.queue.map((e) => e.songId)].filter(Boolean));
  const cached = Object.values(songs()).filter((s) => s.cached && !busy.has(s.id))
    .sort((a, b) => (a.lastPlayedAt || a.addedAt) - (b.lastPlayedAt || b.addedAt));
  let size = await dirSize(C.CACHE_DIR);
  let removed = 0;
  for (const s of cached) {
    if (!all && size <= C.CACHE_MAX_BYTES) break;
    const st = await fsp.stat(path.join(C.MEDIA_DIR, s.file)).catch(() => ({ size: 0 }));
    await deleteSong(s.id);
    size -= st.size;
    removed++;
  }
  if (all) for (const f of await fsp.readdir(C.TMP_DIR).catch(() => [])) await fsp.rm(path.join(C.TMP_DIR, f), { force: true, recursive: true });
  return { removed, size: await dirSize(C.CACHE_DIR) };
}

// ───────────────────────────── Spelare & kö ─────────────────────────────
const player = {
  queue: [], // { qid, songId|null, jobId|null, request, dedupe, singer, title, artist, addedBy, addedAt }
  now: null, // { qid, songId, singer, addedBy }
  phase: 'idle', // idle | intro | playing | paused | celebrate | waiting
  playback: { t: 0, d: 0, paused: true },
  liveOffsetMs: 0,
  votes: new Set(),
  celebrateTimer: null,
  history: [],
};
const tvSockets = new Set();
let lastTvBeat = 0;
const remoteClients = new Map(); // clientId -> antal sockets

function saveQueue() {
  queueStore.data.queue = player.queue.map(({ jobId, ...e }) => e); // jobb-id är bara giltiga i denna process
  queueStore.data.now = player.now;
  queueStore.data.history = player.history.slice(0, 20);
  queueStore.save();
}

function restoreQueue() {
  const d = queueStore.data;
  player.history = Array.isArray(d.history) ? d.history : [];
  const restored = [];
  if (d.now?.songId && getSong(d.now.songId)) restored.push({ ...d.now, qid: newId(), addedAt: Date.now() }); // pågående låt först
  for (const e of d.queue || []) {
    if (e.songId && getSong(e.songId)) restored.push(e);
    else if (e.request && JOB_KINDS[e.request.kind]) {
      const job = startJob(e.request.kind, e.request.params, e.addedBy);
      restored.push({ ...e, songId: null, jobId: job.id }); // starta om avbruten nedladdning
    }
  }
  player.queue = restored;
  if (restored.length) { player.phase = 'waiting'; console.log(`[kö] Återställde ${restored.length} poster`); }
}

const activeRemoteCount = () => remoteClients.size;
const voteThreshold = () => Math.max(2, Math.ceil((activeRemoteCount() * settings.voteSkipPercent) / 100));

// Kontrollerar gränser innan något köas eller laddas ner. Kastar med svenskt felmeddelande.
function checkEnqueue({ singer, dedupe, songId = null, admin }) {
  const dup = (e) => (dedupe && e.dedupe === dedupe) || (songId && e.songId === songId);
  if (player.queue.some(dup) || (player.now && dup(player.now))) {
    throw new Error('Låten finns redan i kön 🙂');
  }
  if (!admin && settings.maxPerSinger > 0 && singerKey(singer) && countForSinger(player.queue, singer) >= settings.maxPerSinger) {
    throw new Error(`${nfc(singer)} har redan ${settings.maxPerSinger} låtar i kön – vänta tills någon har sjungits.`);
  }
}

function enqueue({ songId = null, jobId = null, request = null, dedupe = null, singer = '', title = '', artist = '', next = false, clientId = null, admin = false }) {
  const entry = {
    qid: newId(), songId, jobId, request, dedupe, singer: nfc(singer).slice(0, 40), title: nfc(title), artist: nfc(artist),
    addedBy: clientId, addedAt: Date.now(),
  };
  const mayJump = next && (!settings.hostMode || admin);
  if (mayJump) player.queue.unshift(entry);
  else if (settings.fairQueue) player.queue.splice(fairInsertIndex(player.queue, entry.singer, player.now?.singer), 0, entry);
  else player.queue.push(entry);
  saveQueue();
  broadcastState();
  maybeAutoStart();
  return { entry, jumped: mayJump, ignoredNext: next && !mayJump };
}

function resolveQueueJob(jobId, songId) {
  const e = player.queue.find((x) => x.jobId === jobId);
  if (e) {
    const s = getSong(songId);
    e.songId = songId; e.jobId = null;
    if (s) { e.title = s.title; e.artist = s.artist; }
  }
  saveQueue();
  broadcastState();
  maybeAutoStart();
}

function failQueueJob(jobId, message) {
  const e = player.queue.find((x) => x.jobId === jobId);
  player.queue = player.queue.filter((x) => x.jobId !== jobId);
  saveQueue();
  io.emit('toast', { type: 'error', msg: `Kunde inte hämta "${e?.title || 'låten'}": ${message}` });
  broadcastState();
}

function maybeAutoStart() {
  if (!player.now && settings.autoPlay && ['idle', 'waiting'].includes(player.phase) && player.queue.some((e) => e.songId)) startNext();
}

function loadPayload(resumeAt = 0, intro = true) {
  const s = getSong(player.now.songId);
  if (!s) return null;
  return {
    song: { ...publicSong(s), lrc: s.lrc || '' }, singer: player.now.singer, qid: player.now.qid,
    offsetMs: player.liveOffsetMs, resumeAt, intro: intro && settings.introSeconds > 0, introSeconds: settings.introSeconds,
  };
}

// En låt räknas som "sjungen" om den spelats klart eller minst 60 % innan den hoppades över
let lastLoggedQid = null;
function maybeLogPlay(completed = false) {
  const n = player.now;
  if (!n || lastLoggedQid === n.qid) return;
  const pb = player.playback;
  if (!completed && !(pb.d > 0 && pb.t / pb.d >= 0.6)) return;
  const s = getSong(n.songId);
  if (!s) return;
  lastLoggedQid = n.qid;
  logPlay({ at: Date.now(), songId: s.id, title: s.title, artist: s.artist, singer: n.singer || '', applause: player.applause || 0 });
}

function startNext() {
  maybeLogPlay();
  player.vocalMono = false;
  clearTimeout(player.celebrateTimer);
  player.applause = 0;
  player.votes.clear();
  const idx = player.queue.findIndex((e) => e.songId && getSong(e.songId));
  if (idx < 0) {
    player.now = null;
    player.phase = player.queue.length ? 'waiting' : 'idle';
    io.to('tv').emit('tv:stop');
    saveQueue();
    broadcastState();
    return false;
  }
  const [entry] = player.queue.splice(idx, 1);
  const s = getSong(entry.songId);
  player.now = { qid: entry.qid, songId: entry.songId, singer: entry.singer, addedBy: entry.addedBy, dedupe: entry.dedupe || `song:${entry.songId}` };
  player.phase = 'intro';
  player.liveOffsetMs = s.offsetMs || 0;
  player.playback = { t: 0, d: s.duration || 0, paused: true };
  s.plays = (s.plays || 0) + 1; s.lastPlayedAt = Date.now(); library.save();
  player.history.unshift({ singer: entry.singer, title: s.title, artist: s.artist, at: Date.now() });
  player.history = player.history.slice(0, 20);
  io.to('tv').emit('tv:load', loadPayload(0, true));
  saveQueue();
  broadcastState();
  return true;
}

function stopPlayback() {
  maybeLogPlay();
  clearTimeout(player.celebrateTimer);
  player.now = null;
  player.votes.clear();
  player.phase = player.queue.length ? 'waiting' : 'idle';
  io.to('tv').emit('tv:stop');
  saveQueue();
  broadcastState();
}

function afterCelebration() {
  clearTimeout(player.celebrateTimer);
  if (player.phase !== 'celebrate') return;
  player.now = null;
  saveQueue();
  if (settings.autoPlay && player.queue.some((e) => e.songId)) startNext();
  else { player.phase = player.queue.length ? 'waiting' : 'idle'; io.to('tv').emit('tv:stop'); broadcastState(); }
}

// ───────────────────────────── Nätverk ─────────────────────────────
function detectLanIp() {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
  const best = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr|tun|tap|wg|zt|tailscale|vmnet|vboxnet)/i.test(name)) continue;
    for (const a of addrs || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      let score = /^(wl|wlan|wlp)/i.test(name) ? 3 : /^(en|eth)/i.test(name) ? 4 : 1;
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) score += 5;
      if (/^169\.254\./.test(a.address)) score -= 10;
      best.push({ ip: a.address, score });
    }
  }
  best.sort((a, b) => b.score - a.score);
  return best[0]?.ip || '127.0.0.1';
}
let lanIp = detectLanIp();
const remoteUrl = () => `http://${lanIp}${C.PORT === 80 ? '' : `:${C.PORT}`}/remote`;
setInterval(() => {
  const ip = detectLanIp();
  if (ip !== lanIp) { lanIp = ip; console.log(`[net] Ny LAN-IP: ${ip}`); broadcastState(); }
}, 30000).unref();

// ───────────────────────────── Express ─────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { maxHttpBufferSize: 1e6, pingInterval: 10000, pingTimeout: 8000 });
const requestLimiter = new RateLimiter({ capacity: 6, refillPerSec: 1 / 60 }); // 6 i rad, sedan 1/min

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const clientKey = (req) => {
  const cid = req.get('x-client-id');
  return /^[\w-]{8,64}$/.test(cid || '') ? cid : null;
};
const isAdminReq = (req) => isLocalAddr(req.socket.remoteAddress) || pinOk(req.get('x-karaoke-pin'));
// "Riktig" värd = PIN är konfigurerad och angiven. Utan PIN är alla admin för styrning, men inte för kögränser.
const isHostReq = isAdminReq;
const requireAdmin = (req, res, next) => (isAdminReq(req) ? next() : res.status(401).json({ error: 'Fel eller saknad PIN' }));
function limitRequests(req, res, next) {
  if (isHostReq(req)) return next();
  const key = clientKey(req) || req.socket.remoteAddress;
  const active = [...jobs.values()].filter((j) => j.owner === clientKey(req) && ['queued', 'running'].includes(j.status)).length;
  if (clientKey(req) && active >= 3) return res.status(429).json({ error: 'Du har redan 3 låtar som laddas ner – vänta lite ⏳' });
  if (!requestLimiter.take(key)) return res.status(429).json({ error: 'Lugn i stormen! Vänta en minut innan du lägger till fler låtar.' });
  next();
}

app.get('/', (req, res) => res.redirect('/remote'));
app.get('/tv', (req, res) => res.sendFile(path.join(C.PUBLIC_DIR, 'tv.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(C.PUBLIC_DIR, 'remote.html')));
app.get('/host', (req, res) => res.sendFile(path.join(C.PUBLIC_DIR, 'remote.html'))); // samma app i värdläge (body.host)
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(C.PUBLIC_DIR, 'manifest.webmanifest')));
app.use(express.static(C.PUBLIC_DIR, { index: false, maxAge: 0 }));
const mediaStatic = { maxAge: '7d', fallthrough: false, acceptRanges: true };
app.use('/media/songs', express.static(C.SONGS_DIR, mediaStatic));
app.use('/media/cache', express.static(C.CACHE_DIR, mediaStatic));
app.use('/media/covers', express.static(C.COVERS_DIR, mediaStatic));

app.get('/api/info', (req, res) => res.json({ remoteUrl: remoteUrl(), lanIp, port: C.PORT, pinRequired: !!C.ADMIN_PIN, reactions: C.REACTIONS }));
app.get('/api/health', (req, res) => res.json({
  ok: true, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), tvConnected: tvSockets.size > 0,
  tvBeatAgoMs: lastTvBeat ? Date.now() - lastTvBeat : null,
}));

// WIFI:-schema (ZXing): \ ; , : " måste escapas
const wifiEscape = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
app.get('/api/wifi.svg', async (req, res) => {
  if (!C.WIFI_SSID) return res.status(404).end();
  const payload = `WIFI:T:${C.WIFI_SECURITY === 'NOPASS' ? 'nopass' : C.WIFI_SECURITY};S:${wifiEscape(C.WIFI_SSID)};${C.WIFI_SECURITY === 'NOPASS' ? '' : `P:${wifiEscape(C.WIFI_PASSWORD)};`};`;
  const svg = await QRCode.toString(payload, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0620', light: '#ffffff' } });
  res.type('image/svg+xml; charset=utf-8').set('Cache-Control', 'no-store').send(svg);
});

app.get('/api/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(remoteUrl(), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0620', light: '#ffffff' } });
  res.type('image/svg+xml; charset=utf-8').set('Cache-Control', 'no-cache').send(svg);
});

// Omslag för sökträffar: 302 till iTunes-bilden (mobilen hämtar direkt från Apples CDN) eller 404 → initialer
app.get('/api/cover', async (req, res) => {
  const artist = nfc(req.query.artist || ''); const title = nfc(req.query.title || '');
  let url = cachedCover(artist, title);
  if (url === undefined && pendingLookups() < 12) {
    url = await Promise.race([lookupCover(artist, title), new Promise((r) => setTimeout(() => r(undefined), 9000))]);
  }
  if (!url) return res.status(404).set('Cache-Control', 'max-age=300').end();
  res.set('Cache-Control', 'public, max-age=86400').redirect(url);
});

// Topplistor: range = tonight | all | recent
app.get('/api/stats', (req, res) => {
  const range = String(req.query.range || 'tonight');
  const withSong = (e) => { const s = getSong(e.songId); return { ...e, song: s ? publicSong(s) : null }; };
  if (range === 'recent') return res.json({ range, items: recentPlays(60).map(withSong) });
  const from = range === 'all' ? 0 : eveningStart();
  res.json({ range, total: totalPlays(from), items: topSongs(from).map(withSong), singers: topSingers(from) });
});

app.get('/api/library', (req, res) => {
  const list = Object.values(songs()).map(publicSong).sort((a, b) => a.artist.localeCompare(b.artist, 'sv') || a.title.localeCompare(b.title, 'sv'));
  res.json(list);
});

app.get('/api/songs/:id', (req, res) => {
  const s = getSong(req.params.id);
  if (!s) return res.status(404).json({ error: 'Låten finns inte' });
  res.json({ ...publicSong(s), lrc: s.lrc || '' });
});

app.patch('/api/songs/:id', requireAdmin, (req, res) => {
  const s = getSong(req.params.id);
  if (!s) return res.status(404).json({ error: 'Låten finns inte' });
  const b = req.body || {};
  if (typeof b.title === 'string' && nfc(b.title)) s.title = nfc(b.title).slice(0, 200);
  if (typeof b.artist === 'string' && nfc(b.artist)) s.artist = nfc(b.artist).slice(0, 200);
  if (Array.isArray(b.tags)) s.tags = b.tags.filter((t) => TAGS.includes(t));
  if (typeof b.lrc === 'string') {
    const lrc = b.lrc.normalize('NFC');
    if (lrc.trim() && !parseLrc(lrc).lines.length) return res.status(400).json({ error: 'Texten innehåller inga giltiga LRC-tidsstämplar' });
    s.lrc = lrc.trim() ? lrc : null;
    s.lyricsSource = s.lrc ? (b.lyricsSource === 'lrclib' ? 'lrclib' : 'manual') : null;
    s.lyricsQuality = s.lrc ? 'synced' : null;
  }
  if (b.offsetMs !== undefined) { s.offsetMs = clamp(Math.round(num(b.offsetMs)), -5000, 5000); s.suggestedOffsetMs = 0; }
  library.save();
  io.emit('library:changed');
  if (typeof b.lrc === 'string') { delete s.sync; syncSong(s.id); } // ny text → ny analys
  if (typeof b.syncDisabled === 'boolean' && s.sync) s.sync.disabled = b.syncDisabled;
  if (player.now?.songId === s.id && typeof b.lrc === 'string') io.to('tv').emit('tv:lyrics', { lrc: s.lrc || '' });
  if (player.now?.songId === s.id && typeof b.syncDisabled === 'boolean') io.to('tv').emit('tv:sync', { sync: publicSong(s).sync });
  broadcastState();
  res.json({ ...publicSong(s), lrc: s.lrc || '' });
});

app.delete('/api/songs/:id', requireAdmin, async (req, res) => {
  if (player.now?.songId === req.params.id) return res.status(409).json({ error: 'Låten spelas just nu' });
  res.json({ ok: await deleteSong(req.params.id) });
});

app.post('/api/songs/:id/lyrics-candidates', requireAdmin, async (req, res) => {
  const s = getSong(req.params.id);
  if (!s) return res.status(404).json({ error: 'Låten finns inte' });
  const artist = nfc(req.body?.artist || s.artist); const title = nfc(req.body?.title || s.title);
  res.json(await searchLyricsCandidates(`${artist} ${title}`, { artist, title }));
});

app.post('/api/songs/:id/apply-lrclib', requireAdmin, async (req, res) => {
  const s = getSong(req.params.id);
  if (!s) return res.status(404).json({ error: 'Låten finns inte' });
  const rec = await lrclibById(req.body?.lrclibId);
  if (!rec?.syncedLyrics) return res.status(404).json({ error: 'Ingen synkad text för valt id' });
  Object.assign(s, { lrc: rec.syncedLyrics, lyricsSource: 'lrclib', lyricsQuality: 'synced', lrclibId: rec.id, lrclibDuration: num(rec.duration) });
  delete s.sync;
  syncSong(s.id);
  library.save();
  if (player.now?.songId === s.id) io.to('tv').emit('tv:lyrics', { lrc: s.lrc });
  io.emit('library:changed');
  res.json({ ...publicSong(s), lrc: s.lrc });
});

app.get('/api/search/lyrics', async (req, res) => {
  const q = nfc(req.query.q || '');
  if (q.length < 2) return res.json([]);
  res.json(await searchLyricsCandidates(q));
});

app.get('/api/search/youtube', async (req, res) => {
  const q = nfc(req.query.q || '');
  if (q.length < 2) return res.json([]);
  try { res.json(await ytSearch(`${q} karaoke`, 8)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Gemensam köläggning för nedladdningsförfrågningar
function requestSong(req, res, { kind, params, dedupe, title, artist }) {
  const b = req.body || {};
  const admin = isAdminReq(req);
  const clientId = clientKey(req);
  try { checkEnqueue({ singer: b.singer, dedupe, admin: isHostReq(req) }); }
  catch (e) { return res.status(409).json({ error: e.message }); }
  const job = startJob(kind, params, clientId);
  const r = enqueue({ jobId: job.id, request: { kind, params }, dedupe, singer: b.singer, title, artist, next: !!b.next, clientId, admin });
  res.json({ jobId: job.id, queued: r.entry.qid, ignoredNext: r.ignoredNext });
}

app.post('/api/request/autotext', limitRequests, async (req, res) => {
  const b = req.body || {};
  const rec = await lrclibById(b.lrclibId).catch(() => null);
  if (!rec) return res.status(404).json({ error: 'Okänt LRCLIB-id' });
  const withVideo = b.withVideo ?? settings.theme === 'video';
  const existing = Object.values(songs()).find((s) => s.lrclibId === rec.id && (!withVideo || s.type === 'video'));
  if (existing && (await fileExists(path.join(C.MEDIA_DIR, existing.file)))) {
    const admin = isAdminReq(req);
    try { checkEnqueue({ singer: b.singer, dedupe: `song:${existing.id}`, songId: existing.id, admin: isHostReq(req) }); }
    catch (e) { return res.status(409).json({ error: e.message }); }
    const r = enqueue({ songId: existing.id, dedupe: `song:${existing.id}`, singer: b.singer, title: existing.title, artist: existing.artist, next: !!b.next, clientId: clientKey(req), admin });
    return res.json({ queued: r.entry.qid, fromLibrary: true, ignoredNext: r.ignoredNext });
  }
  requestSong(req, res, {
    kind: 'autotext', dedupe: `lrclib:${rec.id}`, title: rec.trackName, artist: rec.artistName,
    params: { label: `${rec.artistName} – ${rec.trackName}`, lrclibId: rec.id, preferInstrumental: b.preferInstrumental ?? settings.preferInstrumental, withVideo },
  });
});

app.post('/api/request/ytvideo', limitRequests, (req, res) => {
  const b = req.body || {};
  if (!YT_ID_RE.test(b.ytId || '')) return res.status(400).json({ error: 'Ogiltigt YouTube-id' });
  const title = nfc(b.title || 'YouTube-video').slice(0, 200);
  requestSong(req, res, {
    kind: 'ytvideo', dedupe: `yt:${b.ytId}`, title, artist: nfc(b.channel || ''),
    params: { label: title, ytId: b.ytId, title, channel: nfc(b.channel || ''), duration: num(b.duration) },
  });
});

app.post('/api/request/ytlyrics', limitRequests, (req, res) => {
  const query = nfc(req.body?.query || '');
  if (query.length < 2) return res.status(400).json({ error: 'Sökfras saknas' });
  requestSong(req, res, { kind: 'ytlyrics', dedupe: `q:${normKey(query)}`, title: query, artist: 'YouTube-text', params: { label: `${query} (YouTube-text)`, query } });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: C.TMP_DIR,
    filename: (req, file, cb) => cb(null, `up-${newId()}${path.extname(fixUploadName(file.originalname)).toLowerCase()}`),
  }),
  limits: { fileSize: 2 * 1024 ** 3, files: 2, fields: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(fixUploadName(file.originalname)).toLowerCase();
    if (file.fieldname === 'media' && [...C.AUDIO_EXT, ...C.VIDEO_EXT].includes(ext)) return cb(null, true);
    if (file.fieldname === 'lrc' && ['.lrc', '.txt'].includes(ext)) return cb(null, true);
    cb(new Error(`Filtypen ${ext || '?'} stöds inte`));
  },
});

app.post('/api/upload', limitRequests, async (req, res, next) => {
  const fb = await freeBytes(C.MEDIA_DIR);
  const len = Number(req.get('content-length') || 0);
  if (fb && fb.free - len < C.MIN_FREE_BYTES) return res.status(507).json({ error: 'Disken är nästan full – filen får inte plats.' });
  upload.fields([{ name: 'media', maxCount: 1 }, { name: 'lrc', maxCount: 1 }])(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const media = req.files?.media?.[0];
  const lrcFile = req.files?.lrc?.[0];
  const cleanup = () => [media, lrcFile].filter(Boolean).forEach((f) => fsp.unlink(f.path).catch(() => {}));
  if (!media) { cleanup(); return res.status(400).json({ error: 'Ingen mediefil' }); }
  try {
    const originalName = fixUploadName(media.originalname);
    const ext = path.extname(originalName).toLowerCase();
    const type = C.VIDEO_EXT.includes(ext) ? 'video' : 'audio';
    const id = newId();
    let meta = {};
    try { meta = await parseMediaFile(media.path, { duration: true, skipCovers: false }); } catch { /* okänt format */ }
    const fromName = parseFilenameMeta(originalName);
    const artist = nfc(req.body.artist) || nfc(meta.common?.artist) || fromName.artist;
    const title = nfc(req.body.title) || nfc(meta.common?.title) || fromName.title;
    const album = nfc(meta.common?.album || '');
    const duration = Math.round(num(meta.format?.duration));
    let cover = null;
    const pic = meta.common?.picture?.[0];
    if (pic?.data?.length) {
      cover = `covers/${id}${/png/i.test(pic.format) ? '.png' : '.jpg'}`;
      await fsp.writeFile(path.join(C.MEDIA_DIR, cover), pic.data);
    }
    let lrc = null; let lyricsSource = null; let lrclibId = null; let lrclibDuration = 0;
    if (lrcFile) {
      const txt = decodeTextSmart(await fsp.readFile(lrcFile.path));
      if (parseLrc(txt).lines.length) { lrc = txt; lyricsSource = 'upload'; }
    }
    if (!lrc && title) {
      const found = await findBestLyrics({ artist, title, album, duration }).catch(() => null);
      if (found) { lrc = found.lrc; lyricsSource = 'lrclib'; lrclibId = found.lrclibId; lrclibDuration = found.duration; }
    }
    const file = `songs/${id}${ext}`;
    await moveFile(media.path, path.join(C.MEDIA_DIR, file));
    if (lrcFile) await fsp.unlink(lrcFile.path).catch(() => {});
    const song = addSong({ id, title, artist, album, duration, type, file, cover, lrc, lyricsSource, lrclibId, lrclibDuration, source: 'upload', genres: meta.common?.genre });
    let queued = null; let queueError = null;
    if (req.body.queue !== '0') {
      try {
        checkEnqueue({ singer: req.body.singer, dedupe: `song:${song.id}`, admin: isHostReq(req) });
        queued = enqueue({ songId: song.id, dedupe: `song:${song.id}`, singer: req.body.singer, title: song.title, artist: song.artist, next: req.body.next === '1', clientId: clientKey(req), admin: isAdminReq(req) }).entry.qid;
      } catch (e) { queueError = e.message; }
    }
    res.json({ song: publicSong(song), queued, queueError, lyricsFound: !!lrc });
  } catch (e) {
    cleanup();
    console.error('[upload]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/system', requireAdmin, async (req, res) => {
  res.json({
    disk: await freeBytes(C.MEDIA_DIR), cacheBytes: await dirSize(C.CACHE_DIR), songsBytes: await dirSize(C.SONGS_DIR), cacheMaxBytes: C.CACHE_MAX_BYTES,
    songCount: Object.keys(songs()).length, ytdlp: await ytdlpVersion(), app: currentVersion(), updateRepo: C.UPDATE_REPO || null, node: process.version, cookies: hasCookies(),
    analysisPending: analysisQueueLength(), uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), load: os.loadavg(),
    memFree: os.freemem(), memTotal: os.totalmem(), hostname: os.hostname(), remoteUrl: remoteUrl(), systemd: !!process.env.INVOCATION_ID,
    tvConnected: tvSockets.size > 0, remotes: activeRemoteCount(), sync: syncStats(),
  });
});
app.post('/api/system/clear-cache', requireAdmin, async (req, res) => res.json(await pruneCache({ all: true })));
// ── Uppdatering från GitHub ──
app.get('/api/system/update', requireAdmin, async (req, res) => {
  try { res.json(await checkUpdate()); } catch (e) { res.status(400).json({ error: e.message, current: currentVersion() }); }
});
app.post('/api/system/update', requireAdmin, async (req, res) => {
  try {
    const r = await applyUpdate((stage) => io.emit('update:stage', { stage }));
    res.json(r);
    if (r.updated) {
      io.emit('toast', { type: 'info', msg: '🔄 Ny version installerad – startar om…' });
      setTimeout(() => shutdown('update'), 800);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/system/rollback', requireAdmin, async (req, res) => {
  try {
    res.json(await rollback());
    io.emit('toast', { type: 'info', msg: '↩️ Föregående version återställd – startar om…' });
    setTimeout(() => shutdown('rollback'), 800);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/system/restart', requireAdmin, (req, res) => {
  res.json({ ok: true, systemd: !!process.env.INVOCATION_ID });
  io.emit('toast', { type: 'info', msg: 'Tjänsten startar om – kön sparas…' });
  setTimeout(() => shutdown('restart'), 400);
});
// Ljudutgång: valet sparas i data/audio-output.json och återställs av kiosk-skriptet vid start.
// Äldre kiosk-skript skickar { hdmi: true } – tolkas som "återställ sparat val" (HDMI om inget sparats).
const audioPref = new JsonStore(path.join(C.DATA_DIR, 'audio-output.json'), { pref: null });
app.get('/api/system/audio', requireAdmin, async (req, res) => {
  try { res.json({ ...(await listOutputs()), saved: audioPref.data.pref }); }
  catch (e) { res.status(503).json({ error: `Ljudservern nås inte: ${e.message}` }); }
});
app.post('/api/system/audio', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.output) {
      const r = await selectOutput(String(b.output));
      audioPref.data.pref = { kind: r.kind, sink: r.sink, port: r.port, mapping: r.mapping, description: r.description };
      audioPref.flush();
      return res.json({ ok: true, ...r });
    }
    if (b.restore || b.hdmi) {
      const r = await restoreOutput(audioPref.data.pref);
      return res.json({ ok: true, sink: r.sink || r.name, description: r.description });
    }
    res.status(400).json({ error: 'Ange output eller restore' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/system/audio/test', requireAdmin, (req, res) => {
  if (!tvSockets.size) return res.status(409).json({ error: 'TV-vyn är inte öppen – starta Karaoke TV först' });
  io.to('tv').emit('tv:testTone');
  res.json({ ok: true });
});
// Autostart av TV-vyn vid inloggning (flaggfil som kiosk-skriptet läser). Av som standard.
const AUTOSTART_FLAG = path.join(os.homedir(), '.config', 'karaoke-kiosk.autostart');
app.get('/api/system/autostart', requireAdmin, async (req, res) => res.json({ enabled: fs.existsSync(AUTOSTART_FLAG) }));
app.post('/api/system/autostart', requireAdmin, async (req, res) => {
  try {
    if (req.body?.enabled) { await fsp.mkdir(path.dirname(AUTOSTART_FLAG), { recursive: true }); await fsp.writeFile(AUTOSTART_FLAG, `${new Date().toISOString()}\n`); }
    else await fsp.rm(AUTOSTART_FLAG, { force: true });
    res.json({ enabled: fs.existsSync(AUTOSTART_FLAG) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/system/cookies', requireAdmin, async (req, res) => {
  try { await saveCookies(String(req.body?.text || '')); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/system/cookies', requireAdmin, async (req, res) => { await deleteCookies(); res.json({ ok: true }); });

app.use('/api', (req, res) => res.status(404).json({ error: 'Okänd endpoint' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.status === 404 || err.statusCode === 404) return res.status(404).end();
  console.error('[http]', err);
  res.status(500).json({ error: err.message || 'Serverfel' });
});

// ───────────────────────────── Socket.io ─────────────────────────────
function snapshot() {
  const enrich = (e) => {
    const s = getSong(e.songId);
    const job = e.jobId ? jobs.get(e.jobId) : null;
    return {
      qid: e.qid, songId: e.songId, singer: e.singer, title: s?.title || e.title, artist: s?.artist || e.artist,
      cover: s?.cover ? `/media/${s.cover}` : null, type: s?.type || null, duration: s?.duration || 0,
      ready: !!s, job: job ? publicJob(job) : null, owner: ownerTag(e.addedBy),
    };
  };
  const nowSong = player.now ? getSong(player.now.songId) : null;
  return {
    queue: player.queue.map(enrich),
    now: player.now && nowSong ? { ...publicSong(nowSong), qid: player.now.qid, singer: player.now.singer, owner: ownerTag(player.now.addedBy) } : null,
    phase: player.phase, playback: player.playback, liveOffsetMs: player.liveOffsetMs, settings,
    jobs: [...jobs.values()].map(publicJob), remoteUrl: remoteUrl(), tvConnected: tvSockets.size > 0, pinRequired: !!C.ADMIN_PIN,
    wifi: C.WIFI_SSID ? { ssid: C.WIFI_SSID, password: C.WIFI_SHOW_PASSWORD ? C.WIFI_PASSWORD : null } : null,
    history: player.history.slice(0, 6), vocalMono: !!player.vocalMono, votes: { count: player.votes.size, needed: voteThreshold() }, introSeconds: settings.introSeconds,
  };
}

let stateScheduled = false;
function broadcastState() {
  if (stateScheduled) return;
  stateScheduled = true;
  setImmediate(() => { stateScheduled = false; io.emit('state', snapshot()); });
}
let lastThrottled = 0; let throttleTimer = null;
function broadcastStateThrottled() {
  const wait = 700 - (Date.now() - lastThrottled);
  if (wait <= 0) { lastThrottled = Date.now(); broadcastState(); }
  else if (!throttleTimer) throttleTimer = setTimeout(() => { throttleTimer = null; lastThrottled = Date.now(); broadcastState(); }, wait);
}

io.on('connection', (socket) => {
  socket.data.admin = isLocalAddr(socket.handshake?.address); // karaokedatorn själv är alltid värd
  socket.data.role = 'remote';
  socket.data.clientId = null;
  socket.data.reactTokens = 6;
  socket.data.reactAt = Date.now();
  const ack = (cb, payload) => (typeof cb === 'function' ? cb(payload) : undefined);
  const needAdmin = (cb) => { if (socket.data.admin) return false; ack(cb, { error: 'PIN krävs' }); return true; };
  // I värdläge kräver styrning PIN; annars får alla styra (festläge)
  const hostBlocked = (cb) => { if (!settings.hostMode || socket.data.admin) return false; ack(cb, { error: 'Värdläge: bara värden kan göra det. Rösta istället 🗳️' }); return true; };

  socket.on('hello', ({ role, clientId } = {}) => {
    if (role === 'tv') {
      socket.data.role = 'tv';
      socket.join('tv');
      tvSockets.add(socket.id);
      lastTvBeat = Date.now();
      if (player.now && player.phase !== 'celebrate') {
        const p = loadPayload(player.phase === 'intro' ? 0 : player.playback.t, player.phase === 'intro');
        if (p) socket.emit('tv:load', p);
      }
      broadcastState();
    } else if (/^[\w-]{8,64}$/.test(clientId || '') && !socket.data.clientId) {
      socket.data.clientId = clientId;
      remoteClients.set(clientId, (remoteClients.get(clientId) || 0) + 1);
    }
    socket.emit('me', { owner: ownerTag(socket.data.clientId), admin: socket.data.admin });
    socket.emit('state', snapshot());
  });

  socket.on('auth', ({ pin } = {}, cb) => {
    const ok = pinOk(pin);
    if (ok) socket.data.admin = true;
    ack(cb, { ok });
  });

  socket.on('queue:add', ({ songId, singer, next } = {}, cb) => {
    const s = getSong(songId);
    if (!s) return ack(cb, { error: 'Låten finns inte' });
    try { checkEnqueue({ singer, dedupe: `song:${songId}`, songId, admin: socket.data.admin }); }
    catch (e) { return ack(cb, { error: e.message }); }
    const r = enqueue({ songId, dedupe: `song:${songId}`, singer, title: s.title, artist: s.artist, next: !!next, clientId: socket.data.clientId, admin: socket.data.admin });
    ack(cb, { ok: true, qid: r.entry.qid, ignoredNext: r.ignoredNext });
  });

  socket.on('queue:remove', ({ qid } = {}, cb) => {
    const e = player.queue.find((x) => x.qid === qid);
    if (!e) return ack(cb, { ok: true });
    if (settings.hostMode && !socket.data.admin && e.addedBy !== socket.data.clientId) return ack(cb, { error: 'Värdläge: du kan bara ta bort dina egna låtar.' });
    player.queue = player.queue.filter((x) => x.qid !== qid);
    saveQueue();
    broadcastState();
    ack(cb, { ok: true });
  });

  socket.on('queue:move', ({ qid, dir } = {}, cb) => {
    if (hostBlocked(cb)) return;
    const i = player.queue.findIndex((e) => e.qid === qid);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= player.queue.length) return ack(cb, { ok: true });
    [player.queue[i], player.queue[j]] = [player.queue[j], player.queue[i]];
    saveQueue();
    broadcastState();
    ack(cb, { ok: true });
  });

  socket.on('queue:playNow', ({ qid } = {}, cb) => {
    if (hostBlocked(cb)) return;
    const i = player.queue.findIndex((e) => e.qid === qid);
    if (i < 0 || !player.queue[i].songId) return ack(cb, { error: 'Låten är inte klar än' });
    const [e] = player.queue.splice(i, 1);
    player.queue.unshift(e);
    startNext();
    ack(cb, { ok: true });
  });

  socket.on('player:cmd', ({ cmd, value } = {}, cb) => {
    const ownSong = !!(player.now?.addedBy && player.now.addedBy === socket.data.clientId);
    const free = (cmd === 'skip' && ownSong) || (['startNext', 'toggle', 'play'].includes(cmd) && !player.now); // egen låt / starta när inget spelas
    if (!free && hostBlocked(cb)) return;
    switch (cmd) {
      case 'skip': case 'startNext': startNext(); break;
      case 'stop': stopPlayback(); break;
      case 'toggle': case 'play': case 'pause': case 'restart':
        if (player.now) io.to('tv').emit('tv:cmd', { cmd });
        else if (cmd !== 'pause' && player.queue.some((e) => e.songId)) startNext();
        break;
      case 'seek': if (player.now) io.to('tv').emit('tv:cmd', { cmd, value: clamp(num(value), 0, 24 * 3600) }); break;
      default: break;
    }
    ack(cb, { ok: true });
  });

  socket.on('player:voteSkip', (_ = {}, cb) => {
    if (!player.now) return ack(cb, { error: 'Ingen låt spelas' });
    const voter = socket.data.clientId || socket.id;
    player.votes.add(voter);
    const needed = voteThreshold();
    if (player.votes.size >= needed) {
      io.emit('toast', { type: 'info', msg: `🗳️ Publiken röstade – hoppar över "${getSong(player.now.songId)?.title || 'låten'}"` });
      startNext();
    } else broadcastState();
    ack(cb, { ok: true, count: player.votes.size, needed });
  });

  socket.on('settings:set', (patch = {}, cb) => {
    const keys = Object.keys(patch || {}).filter((k) => SETTING_RULES[k]);
    if (!socket.data.admin && keys.some((k) => !SIMPLE_KEYS.has(k))) return ack(cb, { error: 'PIN krävs' });
    if (settings.hostMode && !socket.data.admin && keys.length) return ack(cb, { error: 'Värdläge: inställningar kräver PIN' });
    const applied = {};
    for (const k of keys) { settings[k] = SETTING_RULES[k](patch[k]); applied[k] = settings[k]; }
    settingsStore.save();
    io.emit('settings', settings);
    if ('hostMode' in applied || 'fairQueue' in applied || 'voteSkipPercent' in applied) broadcastState();
    if (applied.autoSync) for (const s of Object.values(songs())) syncSong(s.id); // slogs på → analysera det som saknas
    ack(cb, { ok: true, applied });
  });

  socket.on('offset:nudge', ({ deltaMs } = {}) => {
    player.liveOffsetMs = clamp(player.liveOffsetMs + clamp(num(deltaMs), -1000, 1000), -5000, 5000);
    io.emit('offset', { liveOffsetMs: player.liveOffsetMs });
  });

  socket.on('offset:set', ({ ms } = {}, cb) => {
    if (needAdmin(cb)) return;
    player.liveOffsetMs = clamp(Math.round(num(ms)), -5000, 5000);
    io.emit('offset', { liveOffsetMs: player.liveOffsetMs });
    ack(cb, { ok: true });
  });

  socket.on('offset:save', (_ = {}, cb) => {
    if (needAdmin(cb)) return;
    const s = player.now ? getSong(player.now.songId) : null;
    if (!s) return ack(cb, { error: 'Ingen låt spelas' });
    s.offsetMs = player.liveOffsetMs;
    s.suggestedOffsetMs = 0;
    library.save();
    ack(cb, { ok: true, offsetMs: s.offsetMs });
    broadcastState();
  });

  socket.on('offset:applySuggestion', (_ = {}, cb) => {
    const s = player.now ? getSong(player.now.songId) : null;
    if (!s?.suggestedOffsetMs) return ack(cb, { error: 'Inget förslag för låten' });
    player.liveOffsetMs = s.suggestedOffsetMs;
    if (socket.data.admin) { s.offsetMs = s.suggestedOffsetMs; s.suggestedOffsetMs = 0; library.save(); }
    io.emit('offset', { liveOffsetMs: player.liveOffsetMs });
    broadcastState();
    ack(cb, { ok: true, offsetMs: player.liveOffsetMs, saved: socket.data.admin });
  });

  socket.on('reaction', ({ emoji } = {}) => {
    if (!settings.reactionsEnabled || !C.REACTIONS.includes(emoji)) return;
    const now = Date.now();
    socket.data.reactTokens = Math.min(6, socket.data.reactTokens + (now - socket.data.reactAt) / 250);
    socket.data.reactAt = now;
    if (socket.data.reactTokens < 1) return;
    socket.data.reactTokens -= 1;
    io.to('tv').emit('reaction', { emoji });
    if (player.now) player.applause = (player.applause || 0) + 1;
  });

  // ── Från TV:n ──
  socket.on('tv:vocalMono', ({ mono } = {}) => {
    if (socket.data.role !== 'tv' || player.vocalMono === !!mono) return;
    player.vocalMono = !!mono;
    broadcastState();
  });

  socket.on('tv:beat', () => { if (socket.data.role === 'tv') lastTvBeat = Date.now(); });

  // ── Kalibrering av ljudfördröjning (värd) ──
  socket.on('calib:set', ({ on } = {}, cb) => {
    if (needAdmin(cb)) return;
    io.to('tv').emit('tv:calib', { on: !!on });
    clearTimeout(player.calibTimer);
    if (on) player.calibTimer = setTimeout(() => io.to('tv').emit('tv:calib', { on: false }), 3 * 60 * 1000);
    ack(cb, { ok: true });
  });

  socket.on('tv:state', ({ phase, t, d, paused, lat } = {}) => {
    if (socket.data.role !== 'tv') return;
    lastTvBeat = Date.now();
    if (!player.now) return;
    player.playback = { t: num(t), d: num(d), paused: !!paused, lat: num(lat) };
    if (['intro', 'playing', 'paused'].includes(phase) && player.phase !== 'celebrate') player.phase = phase;
    socket.broadcast.volatile.emit('playback', { ...player.playback, phase: player.phase });
  });

  socket.on('tv:ended', () => {
    if (socket.data.role !== 'tv' || !player.now || player.phase === 'celebrate') return;
    player.phase = 'celebrate';
    maybeLogPlay(true);
    broadcastState();
    player.celebrateTimer = setTimeout(afterCelebration, 10000);
  });

  socket.on('tv:celebrated', () => { if (socket.data.role === 'tv') afterCelebration(); });

  socket.on('tv:error', ({ message } = {}) => {
    if (socket.data.role !== 'tv') return;
    io.emit('toast', { type: 'error', msg: `TV:n kunde inte spela låten (${String(message || 'okänt fel').slice(0, 120)}). Hoppar vidare.` });
    startNext();
  });

  socket.on('disconnect', () => {
    if (tvSockets.delete(socket.id)) broadcastState();
    const cid = socket.data.clientId;
    if (cid) {
      const n = (remoteClients.get(cid) || 1) - 1;
      if (n <= 0) remoteClients.delete(cid); else remoteClients.set(cid, n);
    }
  });
});

// ───────────────────────────── Start/stopp ─────────────────────────────
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] Stänger ner (${reason})`);
  try { saveQueue(); library.flush(); settingsStore.flush(); queueStore.flush(); flushCoverCache(); } catch (e) { console.error(e); }
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

await verifyLibrary();
restoreQueue();
server.listen(C.PORT, '0.0.0.0', () => {
  console.log(`🎤 LAN Karaoke igång\n   TV:     http://localhost:${C.PORT}/tv\n   Mobil:  ${remoteUrl()}\n   Media:  ${C.MEDIA_DIR}\n   PIN:    ${C.ADMIN_PIN ? 'aktiv' : 'av'}`);
  // Analysera låtar som saknar loudness-data (uppgradering från v1) – i bakgrunden, en åt gången
  for (const s of Object.values(songs())) { if (!s.analyzed) analyzeSong(s.id); else syncSong(s.id); }
  setTimeout(maybeAutoStart, 3000);
});
