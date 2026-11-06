// Central konfiguration (miljövariabler + sökvägar). Inga npm-beroenden.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.PORT || 3000);
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(ROOT, 'media'));
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
export const SONGS_DIR = path.join(MEDIA_DIR, 'songs');
export const CACHE_DIR = path.join(MEDIA_DIR, 'cache');
export const COVERS_DIR = path.join(MEDIA_DIR, 'covers');
export const TMP_DIR = path.join(MEDIA_DIR, 'tmp');
export const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
export const PLAYS_FILE = path.join(DATA_DIR, 'plays.jsonl'); // en rad per sjungen låt
export const COVER_CACHE_FILE = path.join(DATA_DIR, 'cover-cache.json');

// Karaokedatorn själv (localhost) är alltid värd. Sätt TRUST_LOCALHOST=0 för att kräva PIN även där.
export const TRUST_LOCALHOST = process.env.TRUST_LOCALHOST !== '0';
export const ADMIN_PIN = String(process.env.KARAOKE_PIN || '').trim();
export const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
export const YTDLP_ARGS = (process.env.YTDLP_ARGS ?? '--js-runtimes node').split(/\s+/).filter(Boolean);
export const YTDLP_COOKIES = process.env.YTDLP_COOKIES || path.join(DATA_DIR, 'cookies.txt');
export const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
export const PACTL_BIN = process.env.PACTL_BIN || 'pactl';
export const CACHE_MAX_BYTES = Number(process.env.CACHE_MAX_GB || 10) * 1024 ** 3;
export const MIN_FREE_BYTES = Number(process.env.MIN_FREE_GB || 1) * 1024 ** 3;
export const MAX_PARALLEL_JOBS = Number(process.env.MAX_PARALLEL_JOBS || 2);
export const COVERS_ONLINE = process.env.COVERS_ONLINE !== '0';
export const USER_AGENT = 'LAN-Karaoke/2.0 (self-hosted; Node.js)';
export const REACTIONS = ['🔥', '👏', '❤️', '🎉', '🍺', '😂'];
export const AUDIO_EXT = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus'];
export const VIDEO_EXT = ['.mp4', '.webm', '.m4v'];
// Wi-Fi-QR på TV:n (läses från /etc/default/lan-karaoke – lagras aldrig i koden)
export const WIFI_SSID = process.env.WIFI_SSID || '';
export const WIFI_PASSWORD = process.env.WIFI_PASSWORD || '';
export const WIFI_SECURITY = (process.env.WIFI_SECURITY || (process.env.WIFI_PASSWORD ? 'WPA' : 'nopass')).toUpperCase();
export const WIFI_SHOW_PASSWORD = process.env.WIFI_SHOW_PASSWORD !== '0';
// Uppdatering från GitHub (värdpanelen)
export const UPDATE_REPO = process.env.UPDATE_REPO || '';
export const UPDATE_BRANCH = process.env.UPDATE_BRANCH || 'main';
export const UPDATE_TOKEN = process.env.UPDATE_TOKEN || '';
export const TARGET_LUFS = Number(process.env.TARGET_LUFS || -16);

export function ensureDirs() {
  for (const d of [SONGS_DIR, CACHE_DIR, COVERS_DIR, TMP_DIR, DATA_DIR]) fs.mkdirSync(d, { recursive: true });
}
