// claude-otel — Token je Bestandteil, gemessen über den count_tokens-Endpunkt.
//
// Ein Request trägt keine Tokenzahlen je Werkzeug oder System-Block, nur die
// API kann sie liefern. Der Endpunkt `count_tokens` misst immer einen ganzen
// Request; ein einzelner Bestandteil ergibt sich als Differenz. Das Verfahren
// ist aus `scripts/messe-tokens.py` des coding-agent-toolkit übernommen
// (dort mit Gegenprobe verifiziert, 2026-07-29):
//
//   Grundlast      = count(MINI)                          Trägernachricht allein
//   Werkzeuge      m1 = count(MINI, [A]), m2 = count(MINI, [A, B])
//                  Ankergewicht = m2 − m1; Rahmen = m1 − Grundlast − Ankergewicht
//                  Werkzeug X   = count(MINI, [A, X]) − m1
//   System-Blöcke  Zuschlag = einzeln(a) + einzeln(b) − zusammen(a, b)
//                  Block X  = count(MINI, [X]) − Grundlast − Zuschlag
//
// Der Anker ist nötig, weil die API einen Request zurückweist, in dem alle
// Werkzeuge aufgeschoben sind (`defer_loading`) — und genau die sind
// interessant: sie stehen nur mit ihrem Namen im Prompt.
//
// Ergebnisse werden je Modell unter einer Inhaltskennung (SHA-256 über den
// Bestandteil ohne cache_control) abgelegt und nie doppelt gemessen. Der
// Endpunkt ist laut Anbieter kostenlos und hat eigene Ratengrenzen.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const API = 'https://api.anthropic.com/v1/messages/count_tokens';
const API_VERSION = '2023-06-01';
const MINI = [{ role: 'user', content: '.' }];
const ANCHOR = [
  { name: 'aaaa', description: 'x', input_schema: { type: 'object', properties: {} } },
  { name: 'bbbb', description: 'x', input_schema: { type: 'object', properties: {} } },
];

export const DEFAULT_CACHE = path.join(os.homedir(), '.claude', 'claude-otel', 'tokens.json');

// ─────────────── Schlüssel ───────────────
// Reihenfolge: Umgebung, dann `.env` im Repo des Viewers (gitignored).
export function readApiKey(repoRoot) {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const env = path.join(repoRoot, '.env');
  try {
    for (const line of fs.readFileSync(env, 'utf8').split('\n')) {
      const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/);
      if (m) return m[1];
    }
  } catch { /* keine .env */ }
  return null;
}

// ─────────────── Hilfen ───────────────
export function stripCacheControl(obj) {
  if (Array.isArray(obj)) return obj.map(stripCacheControl);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (k !== 'cache_control') out[k] = stripCacheControl(v);
    return out;
  }
  return obj;
}

export function contentId(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(stripCacheControl(obj))).digest('hex').slice(0, 16);
}

async function count(model, apiKey, { system, tools, messages } = {}) {
  const body = { model, messages: stripCacheControl(messages || MINI) };
  if (system) body.system = stripCacheControl(system);
  if (tools) body.tools = stripCacheControl(tools);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 429 && attempt < 3) { await new Promise(w => setTimeout(w, 1000 * 2 ** attempt)); continue; }
    if (!r.ok) throw new Error(`count_tokens HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()).input_tokens;
  }
  throw new Error('count_tokens: Ratengrenze auch nach mehreren Versuchen nicht frei');
}

// ─────────────── Ablage ───────────────
function loadCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { modelle: {} }; }
}
async function saveCache(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 1));
}
function modelEntry(data, model) {
  if (!data.modelle) data.modelle = {};
  if (!data.modelle[model]) data.modelle[model] = { eichung: null, werkzeuge: {}, system: {} };
  return data.modelle[model];
}

// ─────────────── Messung ───────────────
// Misst, was für dieses Modell noch fehlt, und liefert Token je Werkzeug und
// je System-Block zurück. Ohne Schlüssel kommt `{ error: 'no_key' }`.
export async function measure({ model, tools = [], system = [], apiKey, cacheFile = DEFAULT_CACHE }) {
  if (!apiKey) return { error: 'no_key' };
  if (!model) return { error: 'no_model' };
  const data = loadCache(cacheFile);
  const e = modelEntry(data, model);
  let calls = 0;
  const now = () => new Date().toISOString();

  const systemBlocks = (Array.isArray(system) ? system : [{ type: 'text', text: String(system || '') }])
    .filter(b => b && typeof b.text === 'string');

  // Eichung: Grundlast, Werkzeugrahmen, System-Zuschlag — einmal je Modell.
  if (!e.eichung) {
    const base = await count(model, apiKey); calls++;
    const m1 = await count(model, apiKey, { tools: ANCHOR.slice(0, 1) }); calls++;
    const m2 = await count(model, apiKey, { tools: ANCHOR }); calls++;
    const anchorWeight = m2 - m1;
    e.eichung = {
      grundlast: base,
      basis_werkzeuge: m1,
      zuschlag_werkzeuge: m1 - base - anchorWeight,
      zuschlag_system: null,
      stand: now(),
    };
  }
  if (e.eichung.zuschlag_system == null && systemBlocks.length >= 2) {
    const [a, b] = systemBlocks;
    const g = e.eichung.grundlast;
    const single = t => count(model, apiKey, { system: [{ type: 'text', text: t }] });
    const singleA = await single(a.text) - g; calls++;
    const singleB = await single(b.text) - g; calls++;
    const both = await count(model, apiKey, { system: [{ type: 'text', text: a.text }, { type: 'text', text: b.text }] }) - g; calls++;
    e.eichung.zuschlag_system = singleA + singleB - both;
  }

  const toolResults = [];
  for (const t of tools) {
    const k = contentId(t);
    if (!e.werkzeuge[k]) {
      const raw = await count(model, apiKey, { tools: [ANCHOR[0], t] }); calls++;
      e.werkzeuge[k] = { name: t.name || '?', token: raw - e.eichung.basis_werkzeuge, defer: !!t.defer_loading, stand: now() };
    }
    toolResults.push({ name: t.name || '?', kennung: k, token: e.werkzeuge[k].token });
  }

  const blockResults = [];
  const systemExtra = e.eichung.zuschlag_system || 0;
  for (const b of systemBlocks) {
    const k = contentId({ text: b.text });
    if (!e.system[k]) {
      const raw = await count(model, apiKey, { system: [{ type: 'text', text: b.text }] }); calls++;
      e.system[k] = { token: raw - e.eichung.grundlast - systemExtra, zeichen: b.text.length, stand: now() };
    }
    blockResults.push({ kennung: k, zeichen: b.text.length, token: e.system[k].token });
  }

  if (calls) await saveCache(cacheFile, data);
  return {
    modell: model,
    aufrufe: calls,
    eichung: e.eichung,
    werkzeuge: toolResults,
    werkzeuge_summe: toolResults.reduce((s, w) => s + w.token, 0) + (tools.length ? e.eichung.zuschlag_werkzeuge : 0),
    system: blockResults,
    system_summe: blockResults.reduce((s, b) => s + b.token, 0) + (blockResults.length ? systemExtra : 0),
  };
}
