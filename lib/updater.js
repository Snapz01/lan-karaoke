// Uppdatering från GitHub (körs från värdpanelen). Laddar ner tarball för senaste commit, kontrollerar den,
// säkerhetskopierar nuvarande kod till data/backup och skriver över appfilerna. media/, data/ och node_modules/ rörs aldrig.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, UPDATE_REPO, UPDATE_BRANCH, UPDATE_TOKEN, USER_AGENT } from './config.js';

const VERSION_FILE = path.join(DATA_DIR, 'version.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
const WORK_DIR = path.join(DATA_DIR, 'update-tmp');
const KEEP = new Set(['media', 'data', 'node_modules', '.git']);
let busy = false;

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

export function currentVersion() {
  const v = readJson(VERSION_FILE, {});
  const pkg = readJson(path.join(ROOT, 'package.json'), {});
  return { version: pkg.version || '?', sha: v.sha || null, date: v.date || null, message: v.message || null, installedAt: v.installedAt || null, hasBackup: fs.existsSync(path.join(BACKUP_DIR, 'server.js')) };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${code}: ${err.trim().split('\n').pop() || ''}`))));
  });
}

async function gh(url, raw = false) {
  // Arkiv-endpointen (tarball) svarar 302 → codeload.github.com och accepterar bara JSON-medietypen;
  // 'application/octet-stream' ger 415. Authorization tas bort automatiskt vid omdirigering till annan domän.
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (UPDATE_TOKEN) headers.Authorization = `Bearer ${UPDATE_TOKEN}`;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(raw ? 120000 : 15000) });
  if (res.status === 404) throw new Error('Repot hittades inte – kontrollera UPDATE_REPO (privat repo kräver UPDATE_TOKEN)');
  if (res.status === 401) throw new Error('UPDATE_TOKEN är ogiltig eller har gått ut');
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0') throw new Error('GitHub begränsar anrop just nu (60/timme utan token) – försök igen om en stund');
    throw new Error('GitHub nekade åtkomst (403) – kontrollera UPDATE_TOKEN/behörighet');
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText}`.trim());
  if (!raw) return res.json();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error('GitHub skickade inget giltigt arkiv – försök igen');
  return buf;
}

export async function checkUpdate() {
  if (!UPDATE_REPO) throw new Error('Ingen GitHub-repo inställd. Lägg till UPDATE_REPO=ägare/repo i /etc/default/lan-karaoke');
  if (!/^[\w.-]+\/[\w.-]+$/.test(UPDATE_REPO)) throw new Error('UPDATE_REPO ska ha formatet ägare/repo');
  const c = await gh(`https://api.github.com/repos/${UPDATE_REPO}/commits/${encodeURIComponent(UPDATE_BRANCH)}`);
  const current = currentVersion();
  return {
    repo: UPDATE_REPO, branch: UPDATE_BRANCH, current,
    latest: { sha: c.sha, date: c.commit?.committer?.date, message: (c.commit?.message || '').split('\n')[0], author: c.commit?.author?.name },
    available: c.sha !== current.sha,
  };
}

async function copyTree(from, to) {
  for (const ent of await fsp.readdir(from)) {
    if (KEEP.has(ent)) continue;
    await fsp.cp(path.join(from, ent), path.join(to, ent), { recursive: true, force: true });
  }
}

const deps = (dir) => JSON.stringify(readJson(path.join(dir, 'package.json'), {}).dependencies || {});

export async function applyUpdate(onStage = () => {}) {
  if (busy) throw new Error('En uppdatering pågår redan');
  busy = true;
  try {
    const info = await checkUpdate();
    if (!info.available) return { updated: false, ...info };
    onStage('Laddar ner…');
    await fsp.rm(WORK_DIR, { recursive: true, force: true });
    await fsp.mkdir(WORK_DIR, { recursive: true });
    const tgz = path.join(WORK_DIR, 'src.tar.gz');
    await fsp.writeFile(tgz, await gh(`https://api.github.com/repos/${UPDATE_REPO}/tarball/${info.latest.sha}`, true));
    const src = path.join(WORK_DIR, 'src');
    await fsp.mkdir(src);
    await run('tar', ['-xzf', tgz, '-C', src, '--strip-components=1']);

    onStage('Kontrollerar…');
    // Repot kan ha appen i roten eller i en undermapp (t.ex. lan-karaoke/)
    let appDir = src;
    if (!fs.existsSync(path.join(src, 'server.js'))) {
      const sub = (await fsp.readdir(src)).find((d) => fs.existsSync(path.join(src, d, 'server.js')));
      if (!sub) throw new Error('Hittade ingen server.js i repot');
      appDir = path.join(src, sub);
    }
    for (const f of ['package.json', 'public/tv.html', 'public/remote.html', 'lib/config.js']) {
      if (!fs.existsSync(path.join(appDir, f))) throw new Error(`Uppdateringen saknar ${f} – avbryter`);
    }
    await run(process.execPath, ['--check', path.join(appDir, 'server.js')]);

    onStage('Säkerhetskopierar…');
    await fsp.rm(BACKUP_DIR, { recursive: true, force: true });
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    await copyTree(ROOT, BACKUP_DIR);
    await fsp.writeFile(path.join(BACKUP_DIR, '.version.json'), JSON.stringify(readJson(VERSION_FILE, {})));

    onStage('Installerar…');
    const depsChanged = deps(appDir) !== deps(ROOT);
    await copyTree(appDir, ROOT);
    if (depsChanged) {
      onStage('Installerar npm-paket…');
      await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT });
    }
    await fsp.writeFile(VERSION_FILE, JSON.stringify({ ...info.latest, installedAt: Date.now() }, null, 2));
    await fsp.rm(WORK_DIR, { recursive: true, force: true });
    return { updated: true, depsChanged, ...info };
  } finally { busy = false; }
}

export async function rollback() {
  if (busy) throw new Error('En uppdatering pågår');
  if (!fs.existsSync(path.join(BACKUP_DIR, 'server.js'))) throw new Error('Ingen säkerhetskopia finns');
  busy = true;
  try {
    const depsChanged = deps(BACKUP_DIR) !== deps(ROOT);
    await copyTree(BACKUP_DIR, ROOT);
    if (depsChanged) await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT });
    await fsp.writeFile(VERSION_FILE, JSON.stringify({ ...readJson(path.join(BACKUP_DIR, '.version.json'), {}), installedAt: Date.now() }, null, 2));
    await fsp.rm(BACKUP_DIR, { recursive: true, force: true });
    return { ok: true, depsChanged };
  } finally { busy = false; }
}
