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

// Portrad: "\t\tanalog-output-headphones: Headphones (type: Headphones, priority: 9900, availability group: Legacy 2, not available)"
function parsePorts(raw) {
  const out = [];
  let inPorts = false;
  for (const l of raw) {
    if (/^\tPorts:/.test(l)) { inPorts = true; continue; }
    if (inPorts && !/^\t\t/.test(l)) inPorts = false;
    if (!inPorts) continue;
    const m = /^\t\t([\w.:@-]+): (.+?) \((.*)\)\s*$/.exec(l);
    if (!m) continue;
    const meta = m[3];
    out.push({
      name: m[1], description: m[2], type: /type: ([\w-]+)/.exec(meta)?.[1] || '',
      available: /not available/.test(meta) ? 'no' : /availability unknown/.test(meta) ? 'unknown' : /available/.test(meta) ? 'yes' : 'unknown',
    });
  }
  return out;
}

const kindOf = (str) => (/hdmi|displayport/i.test(str) ? 'hdmi' : /bluez|bluetooth/i.test(str) ? 'bluetooth' : /usb/i.test(str) ? 'usb' : /analog|headphone|speaker|line/i.test(str) ? 'analog' : 'other');

export async function listSinks() {
  const [long, def] = await Promise.all([pactl(['list', 'sinks']), getDefaultSink().catch(() => '')]);
  return {
    default: def,
    sinks: parseBlocks(long, 'Sink #').map((b) => ({
      name: b.name, description: b.description || b.name, state: b.state || '', hdmi: /hdmi|displayport/i.test(`${b.name} ${b.description}`),
      activePort: b['active port'] || '', ports: parsePorts(b.raw),
    })),
  };
}

function portLabel(port, sinkDesc) {
  const t = `${port.type} ${port.name}`.toLowerCase();
  if (/headphone/.test(t)) return '🎧 Hörlursuttag / AUX (3,5 mm)';
  if (/line/.test(t)) return '🔌 Linjeutgång';
  if (/speaker/.test(t)) return '🔈 Inbyggd högtalare';
  if (/hdmi/.test(t)) return `📺 ${port.description}`;
  return `🔈 ${sinkDesc} – ${port.description}`;
}
function mappingLabel(mapping, desc) {
  if (mapping === 'analog-stereo' || mapping.startsWith('analog')) return '🎧 Analog / hörlursuttag (3,5 mm)';
  const hd = /^hdmi-stereo(?:-extra(\d+))?$/.exec(mapping);
  if (hd) return `📺 HDMI${hd[1] ? ` ${Number(hd[1]) + 1}` : ''} (TV)`;
  return `🔈 ${desc}`;
}

// Alla valbara utgångar: befintliga sinks (per port) + utgångar som först kräver profilbyte på ljudkortet
// (t.ex. analog när kortet står i HDMI-profilen – då finns ingen analog sink alls).
export async function listOutputs() {
  const [{ sinks, default: def }, cardsTxt] = await Promise.all([listSinks(), pactl(['list', 'cards']).catch(() => '')]);
  const outputs = [];
  for (const sk of sinks) {
    const kind = kindOf(`${sk.name} ${sk.description}`);
    const ports = sk.ports;
    if (ports.length > 1) {
      for (const p of ports) {
        outputs.push({
          id: JSON.stringify({ sink: sk.name, port: p.name }), label: portLabel(p, sk.description), kind: kindOf(`${p.type} ${p.name} ${sk.name}`),
          active: sk.name === def && sk.activePort === p.name, available: p.available,
        });
      }
    } else {
      const p = ports[0];
      outputs.push({
        id: JSON.stringify({ sink: sk.name, port: p?.name }), label: kind === 'hdmi' ? `📺 ${sk.description}` : p ? portLabel(p, sk.description) : `🔈 ${sk.description}`,
        kind, active: sk.name === def, available: p?.available || 'unknown',
      });
    }
  }
  const sinkNames = sinks.map((s) => s.name);
  for (const c of parseBlocks(cardsTxt, 'Card #')) {
    const profiles = c.raw
      .map((l) => /^\t\t((?:output|input|pro)[\w:+.-]*): (.+?) \(.*?available: (\w+)\)/.exec(l))
      .filter(Boolean)
      .map((m) => ({ name: m[1], desc: m[2], available: m[3], outs: [...m[1].matchAll(/output:([\w.-]+)/g)].map((x) => x[1]) }));
    const mappings = [...new Set(profiles.flatMap((p) => p.outs))];
    for (const mapping of mappings) {
      if (sinkNames.some((n) => n.endsWith(`.${mapping}`))) continue; // finns redan som sink
      const cands = profiles.filter((p) => p.outs.includes(mapping) && p.available !== 'no');
      if (!cands.length) continue;
      // Behåll analog ingång om möjligt (mikrofon), annars enklaste profilen
      cands.sort((a, b) => (b.name.includes('input:analog') - a.name.includes('input:analog')) || (a.outs.length - b.outs.length));
      const prof = cands[0];
      outputs.push({
        id: JSON.stringify({ card: c.name, profile: prof.name, mapping }), label: mappingLabel(mapping, prof.desc),
        kind: kindOf(mapping), active: false, available: 'yes', needsProfile: true,
      });
    }
  }
  return { outputs, default: def };
}

const NAME_RE = /^[\w.:@+-]+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function selectOutput(id) {
  let sel;
  try { sel = JSON.parse(id); } catch { throw new Error('Ogiltigt utgångsval'); }
  for (const v of [sel.sink, sel.port, sel.card, sel.profile, sel.mapping]) if (v != null && !NAME_RE.test(String(v))) throw new Error('Ogiltigt utgångsnamn');
  let sinkName = sel.sink;
  let port = sel.port;
  if (sel.card && sel.profile) {
    await pactl(['set-card-profile', sel.card, sel.profile]);
    let sink = null;
    for (let i = 0; i < 10 && !sink; i++) { // ljudservern behöver en stund innan nya sinken finns
      const { sinks } = await listSinks();
      sink = sinks.find((s) => s.name.endsWith(`.${sel.mapping}`)) || sinks.find((s) => s.name.includes(sel.mapping));
      if (!sink) await sleep(150);
    }
    if (!sink) throw new Error('Utgången dök inte upp efter profilbytet');
    sinkName = sink.name;
    // Analogt: välj hörlurs-/linjeporten om den är inkopplad (annars kan "Speaker" väljas – tyst på en mini-PC)
    const pick = sink.ports.find((p) => /headphone|line/i.test(`${p.type} ${p.name}`) && p.available !== 'no');
    if (pick) port = pick.name;
  }
  if (!sinkName) throw new Error('Ogiltigt utgångsval');
  if (port) await pactl(['set-sink-port', sinkName, port]).catch(() => {});
  await setDefaultSink(sinkName);
  const { sinks } = await listSinks();
  const s = sinks.find((x) => x.name === sinkName);
  return { sink: sinkName, port: port || null, kind: kindOf(`${port || ''} ${sinkName}`), mapping: sel.mapping || (/\.([\w-]+)$/.exec(sinkName)?.[1] ?? null), description: s?.description || sinkName };
}

// Återställ sparat val (körs av kiosk-skriptet vid start). Matchar i ordning: exakt sink+port → samma utgångstyp på kortet → samma sort.
export async function restoreOutput(pref) {
  if (!pref || pref.kind === 'hdmi') return { ...(await enableHdmi()), kind: 'hdmi' };
  const { outputs } = await listOutputs();
  const parsed = outputs.map((o) => ({ o, sel: JSON.parse(o.id) }));
  const hit = parsed.find(({ sel }) => sel.sink === pref.sink && (!pref.port || sel.port === pref.port))
    || parsed.find(({ sel }) => pref.mapping && (sel.mapping === pref.mapping || sel.sink?.endsWith(`.${pref.mapping}`)) && (!pref.port || !sel.port || sel.port === pref.port))
    || parsed.find(({ o }) => o.kind === pref.kind && o.available !== 'no');
  if (!hit) throw new Error(`Sparad ljudutgång (${pref.description || pref.kind}) hittades inte`);
  return selectOutput(hit.o.id);
}

export async function getDefaultSink() {
  try { return (await pactl(['get-default-sink'])).trim(); }
  catch {
    const info = await pactl(['info']);
    return /Default Sink:\s*(.+)/.exec(info)?.[1]?.trim() || '';
  }
}

export async function setDefaultSink(name) {
  if (!NAME_RE.test(name)) throw new Error('Ogiltigt utgångsnamn');
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
