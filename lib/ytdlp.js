// yt-dlp-wrapper. spawn med argument-array (ingen shell → ingen injektion).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { YTDLP_BIN, YTDLP_ARGS, YTDLP_COOKIES, TMP_DIR, COVERS_DIR, MEDIA_DIR } from './config.js';
import { vttToLrc, isSyncedLrc } from '../public/lrc.js';
import { nfc, num, clamp, newId, fileExists, moveFile } from './util.js';

export const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Översätt kända yt-dlp-fel till begriplig svenska
export function friendlyYtError(msg) {
  if (/confirm you.?re not a bot|sign in to confirm/i.test(msg)) return 'YouTube kräver inloggning (bot-skydd). Ladda upp en cookies.txt under ⚙️ Avancerat → Systemkontroll.';
  if (/video unavailable|private video|has been removed/i.test(msg)) return 'Videon är inte tillgänglig.';
  if (/age.?restrict|confirm your age/i.test(msg)) return 'Videon är åldersbegränsad – kräver cookies.txt från ett inloggat konto.';
  if (/not available in your country|geo/i.test(msg)) return 'Videon är spärrad i Sverige.';
  if (/HTTP Error 429|too many requests/i.test(msg)) return 'YouTube begränsar antalet anrop just nu – vänta en stund.';
  if (/no such option|js-runtimes/i.test(msg)) return 'yt-dlp är för gammal – kör "sudo yt-dlp -U".';
  if (/Unable to download|timed out|getaddrinfo|network/i.test(msg)) return 'Nätverksfel mot YouTube.';
  return msg;
}

function baseArgs() {
  const a = [...YTDLP_ARGS];
  if (fs.existsSync(YTDLP_COOKIES)) a.push('--cookies', YTDLP_COOKIES);
  return a;
}

export function ytdlp(args, { onLine, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, [...baseArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const handle = (stream, isErr) => {
      readline.createInterface({ input: stream }).on('line', (line) => {
        if (isErr) stderr = (stderr + line + '\n').slice(-16384);
        else if (stdout.length < 32 * 1024 * 1024) stdout += line + '\n';
        onLine?.(line, isErr);
      });
    };
    handle(child.stdout, false);
    handle(child.stderr, true);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'yt-dlp saknas – kör setup-ubuntu.sh' : e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const msg = stderr.split('\n').filter((l) => /ERROR/.test(l)).pop() || stderr.trim().split('\n').pop() || `yt-dlp avslutades med kod ${code}`;
      reject(new Error(friendlyYtError(msg.replace(/^ERROR:\s*/, '').slice(0, 300))));
    });
  });
}

const parseLines = (stdout) => stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

export async function ytSearch(query, n = 8) {
  const { stdout } = await ytdlp(['--flat-playlist', '--dump-json', '--no-warnings', `ytsearch${n}:${nfc(query)}`], { timeoutMs: 45000 });
  return parseLines(stdout)
    .filter((e) => YT_ID_RE.test(e.id))
    .map((e) => ({
      ytId: e.id, title: nfc(e.title || ''), channel: nfc(e.channel || e.uploader || ''),
      duration: Math.round(num(e.duration)), thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
    }));
}

export function pickBestAudioMatch(results, targetDuration, preferInstrumental) {
  const bad = /karaoke|instrumental|cover|live|reaction|sped up|slowed|8d|nightcore|remix/i;
  return results.map((r) => {
    const dd = targetDuration && r.duration ? Math.abs(r.duration - targetDuration) : 30;
    let s = -dd;
    if (!preferInstrumental && bad.test(r.title)) s -= 25;
    if (preferInstrumental && !/instrumental|karaoke/i.test(r.title)) s -= 25;
    if (/official audio|topic$/i.test(`${r.title} ${r.channel}`)) s += 4;
    if (!r.duration || r.duration > 900) s -= 100;
    return { r, s, dd };
  }).sort((a, b) => b.s - a.s)[0] || null;
}

export async function ytDownload(ytId, { kind, maxHeight = 720, destDir, baseName, onProgress, withThumb = true }) {
  if (!YT_ID_RE.test(ytId)) throw new Error('Ogiltigt YouTube-id');
  const h = Number(maxHeight) || 720;
  const fmt = kind === 'video'
    ? `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]/b`
    : 'ba[ext=m4a]/ba/b';
  const outBase = path.join(TMP_DIR, baseName);
  const coverBase = path.join(COVERS_DIR, baseName);
  const args = [
    '-f', fmt, '--no-playlist', '--newline', '--progress', '--no-simulate', '--no-mtime', '--no-part',
    '--progress-template', 'download:KPROG %(progress._percent_str)s',
    '--print', 'after_move:KFILE %(filepath)s',
    '-o', `${outBase}.%(ext)s`,
  ];
  if (withThumb) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg', '-o', `thumbnail:${coverBase}.%(ext)s`);
  if (kind === 'video') args.push('--merge-output-format', 'mp4');
  args.push('--', `https://www.youtube.com/watch?v=${ytId}`);
  let filePath = null;
  let pass = 0;
  let last = 0;
  await ytdlp(args, {
    onLine: (line) => {
      const p = /KPROG\s+([\d.]+)%/.exec(line);
      if (p) {
        const v = Number(p[1]);
        if (v + 5 < last) pass++;
        last = v;
        onProgress?.(Math.round(kind === 'video' ? clamp((pass * 100 + v) / 2, 0, 99) : clamp(v, 0, 99)));
        return;
      }
      const f = /^KFILE (.+)$/.exec(line.trim());
      if (f) filePath = f[1];
    },
  });
  if (!filePath || !(await fileExists(filePath))) throw new Error('Nedladdningen gav ingen fil');
  const ext = path.extname(filePath).toLowerCase() || (kind === 'video' ? '.mp4' : '.m4a');
  const finalPath = path.join(destDir, `${baseName}${ext}`);
  await moveFile(filePath, finalPath);
  const coverPath = `${coverBase}.jpg`;
  const rel = (p) => path.relative(MEDIA_DIR, p).split(path.sep).join('/');
  return { file: rel(finalPath), cover: withThumb && (await fileExists(coverPath)) ? rel(coverPath) : null };
}

// Reserv när LRCLIB saknar synkad text: "lyrics"-video med undertexter. Ljudet tas från SAMMA video.
export async function ytLyricsFallback(query) {
  const { stdout } = await ytdlp(['--dump-json', '--no-warnings', '--skip-download', `ytsearch5:${nfc(query)} lyrics`], { timeoutMs: 90000 });
  const entries = parseLines(stdout);
  const pickLang = (obj, preferOrig) => {
    const keys = Object.keys(obj || {}).filter((k) => /^(sv|en)/i.test(k) && k !== 'live_chat');
    if (preferOrig) { const o = keys.find((k) => /-orig$/.test(k)); if (o) return o; }
    return keys.find((k) => /^sv/i.test(k)) || keys.find((k) => /^en/i.test(k)) || null;
  };
  let chosen = null;
  for (const e of entries) { const k = pickLang(e.subtitles, false); if (k) { chosen = { e, lang: k, auto: false }; break; } }
  if (!chosen) for (const e of entries) { const k = pickLang(e.automatic_captions, true); if (k) { chosen = { e, lang: k, auto: true }; break; } }
  if (!chosen) return null;
  const tmpBase = path.join(TMP_DIR, `subs-${newId()}`);
  await ytdlp(['--skip-download', '--sub-format', 'vtt', '--sub-langs', chosen.lang, '-o', `${tmpBase}.%(ext)s`,
    chosen.auto ? '--write-auto-subs' : '--write-subs', '--', `https://www.youtube.com/watch?v=${chosen.e.id}`], { timeoutMs: 60000 });
  const files = (await fsp.readdir(TMP_DIR)).filter((f) => f.startsWith(path.basename(tmpBase)) && f.endsWith('.vtt'));
  if (!files.length) return null;
  const vtt = await fsp.readFile(path.join(TMP_DIR, files[0]), 'utf8');
  await Promise.all(files.map((f) => fsp.unlink(path.join(TMP_DIR, f)).catch(() => {})));
  const lrc = vttToLrc(vtt);
  if (!isSyncedLrc(lrc)) return null;
  return {
    lrc, auto: chosen.auto, ytId: chosen.e.id, title: nfc(chosen.e.track || chosen.e.title || ''),
    artist: nfc(chosen.e.artist || chosen.e.creator || chosen.e.channel || ''), duration: Math.round(num(chosen.e.duration)),
  };
}

export async function ytdlpVersion() {
  try { return (await ytdlp(['--version'], { timeoutMs: 10000 })).stdout.trim(); }
  catch (e) { return `saknas (${e.message})`; }
}

export const hasCookies = () => fs.existsSync(YTDLP_COOKIES);
export async function saveCookies(text) {
  if (!/^# (Netscape )?HTTP Cookie File/m.test(text) && !/\tTRUE\t|\tFALSE\t/.test(text)) throw new Error('Inte en cookies.txt i Netscape-format');
  await fsp.writeFile(YTDLP_COOKIES, text.replace(/\r\n/g, '\n'), { mode: 0o600 });
}
export async function deleteCookies() { await fsp.unlink(YTDLP_COOKIES).catch(() => {}); }
