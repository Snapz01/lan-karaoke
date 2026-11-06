// Ljudutgång via pactl (PipeWire-Pulse/PulseAudio). Tjänsten kör som skrivbordsanvändaren och når
// användarens ljudserver via XDG_RUNTIME_DIR. Long-format-parsning fungerar på både 22.04 och 24.04.
import { execFile } from 'node:child_process';
import { PACTL_BIN } from './config.js';

function pactl(args) {
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' }; // fältnamn översätts annars ("Namn:")
  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  return new Promise((resolve, reject) => {
    execFile(PACTL_BIN, args, { env, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').pop()));
      else resolve(stdout);
    });
  });
}

export function parseBlocks(text, header) {
  const blocks = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith(header)) { cur = { raw: [] }; blocks.push(cur); continue; }
    if (!cur) continue;
    cur.raw.push(line);
    const m = /^\t([A-Za-z ]+):\s?(.*)$/.exec(line);
    if (m) cur[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return blocks;
}

export async function listSinks() {
  const [long, def] = await Promise.all([pactl(['list', 'sinks']), getDefaultSink().catch(() => '')]);
  return {
    default: def,
    sinks: parseBlocks(long, 'Sink #').map((b) => ({
      name: b.name, description: b.description || b.name, state: b.state || '', hdmi: /hdmi|displayport/i.test(`${b.name} ${b.description}`),
    })),
  };
}

export async function getDefaultSink() {
  try { return (await pactl(['get-default-sink'])).trim(); }
  catch {
    const info = await pactl(['info']);
    return /Default Sink:\s*(.+)/.exec(info)?.[1]?.trim() || '';
  }
}

export async function setDefaultSink(name) {
  if (!/^[\w.:@-]+$/.test(name)) throw new Error('Ogiltigt utgångsnamn');
  await pactl(['set-default-sink', name]);
  // Flytta pågående strömmar (Chromium) till nya utgången
  const inputs = await pactl(['list', 'short', 'sink-inputs']).catch(() => '');
  for (const line of inputs.split('\n').filter(Boolean)) {
    const idx = line.split('\t')[0];
    await pactl(['move-sink-input', idx, name]).catch(() => {});
  }
}

// Aktivera HDMI-profil på ljudkortet (krävs ofta innan HDMI-utgången ens syns) och välj den.
export async function enableHdmi() {
  const cards = parseBlocks(await pactl(['list', 'cards']), 'Card #');
  for (const c of cards) {
    const profiles = c.raw
      .map((l) => /^\t\t(output:hdmi[^:+]*(?:\+input:[^:]+)?):.*?available:\s*(\w+)/.exec(l))
      .filter(Boolean)
      .filter((m) => m[2] !== 'no')
      .map((m) => m[1]);
    if (!profiles.length) continue;
    const prof = profiles.find((p) => p === 'output:hdmi-stereo') || profiles[0];
    await pactl(['set-card-profile', c.name, prof]);
    break;
  }
  const { sinks } = await listSinks();
  const hdmi = sinks.find((s) => s.hdmi);
  if (!hdmi) throw new Error('Hittade ingen HDMI-utgång – är TV:n påslagen och ansluten?');
  await setDefaultSink(hdmi.name);
  return hdmi;
}
