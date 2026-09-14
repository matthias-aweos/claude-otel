#!/usr/bin/env node
// claude-otel — local viewer for Claude Code OpenTelemetry raw API bodies
// Single-file ESM, Node stdlib only.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measure, readApiKey } from './tokens.mjs';

const PKG = 'claude-otel';
const VERSION = '0.1.0';
const DEFAULT_PORT = 47821;
const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'claude-otel');

const HELP = `${PKG} v${VERSION}
Local viewer for Claude Code's OpenTelemetry raw API bodies.

usage:
  ${PKG} [view] [path]              serve the viewer  (default command)
  ${PKG} record [-- claude-args]    wrap \`claude\` with OTel raw-body logging
  ${PKG} --help | --version

view options:
      --port <n>      port              default: ${DEFAULT_PORT}
      --host <h>      host              default: 127.0.0.1
      --no-open       don't open browser
      --html <path>   override viewer.html location

record options:
      --root <dir>    log root          default: ~/.claude/claude-otel
      --events        also stream OTel events to stderr
      --cmd <bin>     program to spawn  default: claude  (e.g. ccr, mise exec claude)
all args after \`record\` (and after the wrapper options) are passed through to the spawned program.

layout:
  Sessions are grouped by project (the cwd at \`record\` time):
    <root>/<encoded-cwd>/<timestamp>/  ← raw .request.json / .response.json files
  The encoded-cwd dir contains a .project file with the original path.

env:
  CLAUDE_OTEL_ROOT, CLAUDE_OTEL_PORT, CLAUDE_OTEL_HOST  override defaults

examples:
  ${PKG}                              # serve ~/.claude/claude-otel
  ${PKG} ~/logs                       # serve a custom root
  ${PKG} --port 8000 --no-open
  ${PKG} record -p "hello"            # capture a one-shot session
  ${PKG} record --events -- -c        # pass --events to wrapper, then \`-c\` to claude
  ${PKG} record --cmd ccr code        # capture a session launched via ccr
`;

// ─────────────── helpers ───────────────
function findViewerHtml(scriptPath, override) {
  if (override) {
    const abs = path.resolve(override);
    return fs.existsSync(abs) ? abs : null;
  }
  const real = fs.realpathSync(scriptPath);
  const here = path.dirname(real);
  const candidates = [
    path.join(here, 'viewer.html'),                                    // alongside (npm pack)
    path.join(here, '..', 'viewer.html'),                              // repo: bin/* → ../viewer.html
    path.join(here, '..', 'share', PKG, 'viewer.html'),
    path.join(os.homedir(), '.local', 'share', PKG, 'viewer.html'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* nope */ }
  }
  return null;
}

function safeJoin(base, name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name.includes('\0')) return null;
  const baseR = path.resolve(base);
  const target = path.resolve(baseR, name);
  if (target === baseR) return null;
  if (!target.startsWith(baseR + path.sep)) return null;
  return target;
}

function classify(name) {
  if (name.endsWith('.request.json')) return 'request';
  if (name.endsWith('.response.json')) return 'response';
  return 'other';
}

function encodeProject(cwd) {
  return path.resolve(cwd).replace(/[\\/]/g, '-');
}

function readProjectPath(projectDir) {
  try { return fs.readFileSync(path.join(projectDir, '.project'), 'utf8').trim() || null; }
  catch { return null; }
}

function dirHasSessionFiles(dir) {
  try {
    for (const n of fs.readdirSync(dir)) {
      if ((n.endsWith('.request.json') || n.endsWith('.response.json'))
          && fs.statSync(path.join(dir, n)).isFile()) return true;
    }
  } catch { /* nope */ }
  return false;
}

// Slug shape: "<encodedProject>/<session>" or just "<session>" (legacy).
// `encodeProject` collapses path separators to `-`, so the encoded form
// never contains `/`. Session names are timestamps, also `/`-free. The
// first `/` therefore unambiguously separates the two halves.
function parseSlug(slug) {
  const idx = slug.indexOf('/');
  if (idx < 0) return { project: null, session: slug };
  return { project: slug.slice(0, idx), session: slug.slice(idx + 1) };
}

function resolveSessionDir(root, slug) {
  const { project, session } = parseSlug(slug);
  // If a `/` was present, both halves must be non-empty.
  if (project === '') return null;
  if (project) {
    const projDir = safeJoin(root, project);
    if (!projDir) return null;
    return safeJoin(projDir, session);
  }
  return safeJoin(root, session);
}

function listFiles(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    let st;
    try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ name, kind: classify(name), size: st.size, mtime: st.mtimeMs / 1000 });
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

function summarizeSessionDir(sessionDir, project, projectPath, sessionName) {
  const files = listFiles(sessionDir);
  if (!files.length) return null;
  const reqs = files.filter(f => f.kind === 'request').length;
  const resps = files.filter(f => f.kind === 'response').length;
  if (!reqs && !resps) return null;
  const mtimes = files.map(f => f.mtime);
  const id = project ? `${project}/${sessionName}` : sessionName;
  return {
    id,
    project,
    projectPath,
    projectLabel: projectPath ? path.basename(projectPath) : (project || ''),
    name: sessionName,
    turns: Math.max(reqs, resps),
    requests: reqs,
    responses: resps,
    files: files.length,
    first: Math.min(...mtimes),
    last: Math.max(...mtimes),
    size: files.reduce((s, f) => s + f.size, 0),
  };
}

function listSessions(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.')) continue;
    const d = path.join(root, name);
    let st;
    try { st = fs.statSync(d); } catch { continue; }
    if (!st.isDirectory()) continue;

    if (dirHasSessionFiles(d)) {
      // legacy: session directly under root, no project layer
      const sess = summarizeSessionDir(d, null, null, name);
      if (sess) out.push(sess);
      continue;
    }
    // project dir: scan one level deeper for sessions
    const projectPath = readProjectPath(d);
    let entries;
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const sName of entries) {
      if (sName.startsWith('.')) continue;
      const sDir = path.join(d, sName);
      let sst;
      try { sst = fs.statSync(sDir); } catch { continue; }
      if (!sst.isDirectory()) continue;
      const sess = summarizeSessionDir(sDir, name, projectPath, sName);
      if (sess) out.push(sess);
    }
  }
  out.sort((a, b) => b.last - a.last);
  return out;
}

// ─────────────── HTTP server ───────────────
function send(res, status, ctype, body) {
  res.writeHead(status, { 'Content-Type': ctype, 'Cache-Control': 'no-cache' });
  res.end(body);
}
function sendJson(res, status, obj) { send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj)); }
function sendBytes(res, status, ctype, buf) {
  res.writeHead(status, { 'Content-Type': ctype, 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
  res.end(buf);
}

function readBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// POST /api/tokens — Token je Werkzeug und System-Block eines Requests.
// Der Client schickt model, tools und system des Requests; gemessen wird nur,
// was für dieses Modell noch nicht in der Ablage liegt (siehe tokens.mjs).
async function handleTokens(req, res, ctx) {
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); }
  catch (e) { return sendJson(res, 400, { error: 'bad json', detail: String(e.message || e) }); }
  const apiKey = readApiKey(ctx.repoRoot);
  try {
    const out = await measure({ model: body.model, tools: body.tools || [], system: body.system || [], apiKey });
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 502, { error: 'count_tokens failed', detail: String(e.message || e) });
  }
}

function handle(req, res, ctx) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (req.method === 'POST' && p === '/api/tokens') return handleTokens(req, res, ctx);
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });

  if (p === '/' || p === '/index.html')  return sendBytes(res, 200, 'text/html; charset=utf-8', ctx.getHtml());
  if (p === '/api/health')                return sendJson(res, 200, { ok: true, root: ctx.root, version: VERSION });
  if (p === '/api/sessions')              return sendJson(res, 200, listSessions(ctx.root));

  let m;
  if ((m = p.match(/^\/api\/sessions\/([^/]+)\/files$/))) {
    const slug = decodeURIComponent(m[1]);
    const dir = resolveSessionDir(ctx.root, slug);
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return sendJson(res, 404, { error: 'session not found' });
    const { project } = parseSlug(slug);
    let projectPath = null;
    if (project) {
      const projDir = safeJoin(ctx.root, project);
      if (projDir) projectPath = readProjectPath(projDir);
    }
    return sendJson(res, 200, { session: path.basename(dir), project, projectPath, files: listFiles(dir) });
  }
  if ((m = p.match(/^\/api\/sessions\/([^/]+)\/file\/([^/]+)$/))) {
    const dir = resolveSessionDir(ctx.root, decodeURIComponent(m[1]));
    if (!dir) return sendJson(res, 404, { error: 'session not found' });
    const f = safeJoin(dir, decodeURIComponent(m[2]));
    if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return sendJson(res, 404, { error: 'file not found' });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Mtime': String(fs.statSync(f).mtimeMs / 1000),
    });
    return fs.createReadStream(f).pipe(res);
  }
  if ((m = p.match(/^\/api\/sessions\/([^/]+)\/events$/))) {
    const dir = resolveSessionDir(ctx.root, decodeURIComponent(m[1]));
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return sendJson(res, 404, { error: 'session not found' });
    return sseLoop(req, res, dir);
  }
  return sendJson(res, 404, { error: 'not found' });
}

function sseLoop(req, res, dir, maxSeconds = 1800) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const seen = new Map();
  for (const f of listFiles(dir)) seen.set(f.name, f.mtime);
  const start = Date.now();
  let lastPing = start;
  const tick = setInterval(() => {
    if (req.destroyed || res.destroyed) return done();
    if (Date.now() - start > maxSeconds * 1000) return done();
    const now = Date.now();
    const current = listFiles(dir);
    const present = new Set();
    const changed = [];
    for (const f of current) {
      present.add(f.name);
      if (seen.get(f.name) !== f.mtime) {
        seen.set(f.name, f.mtime);
        changed.push(f);
      }
    }
    for (const k of seen.keys()) if (!present.has(k)) seen.delete(k);
    try {
      if (changed.length) { res.write(`data: ${JSON.stringify({ changed })}\n\n`); lastPing = now; }
      else if (now - lastPing > 15000) { res.write(': ping\n\n'); lastPing = now; }
    } catch { return done(); }
  }, 1000);
  function done() { clearInterval(tick); try { res.end(); } catch { /* ignore */ } }
  req.on('close', done);
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'start'
            :                                 'xdg-open';
  try { spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}

// ─────────────── commands ───────────────
async function cmdView(opts, positional) {
  const explicit = positional[0] || process.env.CLAUDE_OTEL_ROOT;
  const root = path.resolve(explicit || DEFAULT_ROOT);
  const port = +(opts.port || process.env.CLAUDE_OTEL_PORT || DEFAULT_PORT);
  const host = opts.host || process.env.CLAUDE_OTEL_HOST || '127.0.0.1';

  if (!fs.existsSync(root)) {
    if (!explicit) {
      try { await fsp.mkdir(root, { recursive: true }); }
      catch (e) { console.error(`${PKG}: cannot create ${root}: ${e.message}`); process.exit(1); }
    } else {
      console.error(`${PKG}: log root not found: ${root}`);
      console.error(`  hint: run \`${PKG} record\` first to populate it.`);
      process.exit(1);
    }
  }
  if (!fs.statSync(root).isDirectory()) {
    console.error(`${PKG}: log root is not a directory: ${root}`);
    process.exit(1);
  }
  const html = findViewerHtml(process.argv[1], opts.html);
  if (!html) {
    console.error(`${PKG}: viewer.html not found.`);
    console.error('  pass --html /path/to/viewer.html');
    process.exit(1);
  }
  // Re-read viewer.html on each request so live edits show up without
  // restarting the server. The file is tiny (≈70 KB) and the OS page
  // cache makes this effectively free.
  let cached = await fsp.readFile(html);
  const getHtml = () => {
    try { cached = fs.readFileSync(html); } catch { /* keep last good copy */ }
    return cached;
  };
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = http.createServer((req, res) => handle(req, res, { root, getHtml, repoRoot }));
  server.on('error', err => { console.error(`${PKG}: ${err.message}`); process.exit(1); });
  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log(`${PKG}  · root  ${root}`);
    console.log(`            · html  ${html}`);
    console.log(`            · serve ${url}`);
    if (!opts.noOpen) openInBrowser(url);
  });
  const shutdown = () => { server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdRecord(opts, claudeArgs) {
  const root = path.resolve(opts.root || process.env.CLAUDE_OTEL_ROOT || DEFAULT_ROOT);
  const cwd = process.cwd();
  const projectName = encodeProject(cwd);
  const projectDir = path.join(root, projectName);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const logDir = path.join(projectDir, ts);
  await fsp.mkdir(logDir, { recursive: true });
  try { await fsp.writeFile(path.join(projectDir, '.project'), cwd + '\n', { flag: 'w' }); } catch { /* ignore */ }
  process.stderr.write(`${PKG}: writing API bodies to ${logDir}\n`);

  const env = {
    ...process.env,
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOG_RAW_API_BODIES: `file:${logDir}`,
    OTEL_LOG_USER_PROMPTS: '1',
    OTEL_LOG_TOOL_CONTENT: '1',
    OTEL_LOG_TOOL_DETAILS: '1',
  };
  if (opts.events) {
    env.OTEL_LOGS_EXPORTER = 'console';
    env.OTEL_LOGS_EXPORT_INTERVAL = '1000';
  }

  // --cmd may be a multi-word string like "mise exec claude"; split on
  // whitespace into bin + prefix args (no shell, so no quoting hazards).
  const tokens = (opts.cmd || 'claude').trim().split(/\s+/).filter(Boolean);
  const bin = tokens[0];
  const prefixArgs = tokens.slice(1);
  const allArgs = [...prefixArgs, ...claudeArgs];
  const child = spawn(bin, allArgs, { stdio: 'inherit', env });
  child.on('exit', (code, signal) => {
    if (signal) process.exit(128 + (os.constants.signals[signal] || 0));
    process.exit(code ?? 1);
  });
  child.on('error', err => {
    console.error(`${PKG}: failed to exec ${bin}: ${err.message}`);
    console.error(`  hint: ensure \`${bin}\` is installed and on your $PATH.`);
    process.exit(1);
  });
}

// ─────────────── arg parsing ───────────────
function take(flag, argv, i) {
  const v = argv[i];
  if (v === undefined) { console.error(`${PKG}: ${flag} requires a value`); process.exit(2); }
  return v;
}

function parseViewArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open')                          opts.noOpen = true;
    else if (a === '--port')                         opts.port = take(a, argv, ++i);
    else if (a === '--host')                         opts.host = take(a, argv, ++i);
    else if (a === '--html')                         opts.html = take(a, argv, ++i);
    else if (a === '--help' || a === '-h')           { console.log(HELP); process.exit(0); }
    else if (a === '--version' || a === '-v')        { console.log(`${PKG} ${VERSION}`); process.exit(0); }
    else if (a.startsWith('-'))                      { console.error(`${PKG}: unknown flag: ${a}`); process.exit(2); }
    else                                             positional.push(a);
  }
  return { opts, positional };
}

function parseRecordArgs(argv) {
  const opts = {};
  const claudeArgs = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--')                                  { i++; break; }
    else if (a === '--root')                         { opts.root = take(a, argv, ++i); i++; }
    else if (a === '--events')                       { opts.events = true; i++; }
    else if (a === '--cmd')                          { opts.cmd = take(a, argv, ++i); i++; }
    else if (a === '--help')                         { console.log(HELP); process.exit(0); }
    else                                             { break; }                    // first non-option → spawn args
  }
  for (; i < argv.length; i++) claudeArgs.push(argv[i]);
  return { opts, claudeArgs };
}

// ─────────────── main ───────────────
function main() {
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
    console.error(`${PKG}: requires Node.js >= 18 (current: ${process.versions.node})`);
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  if (argv[0] === '--help' || argv[0] === '-h')      { console.log(HELP); return; }
  if (argv[0] === '--version' || argv[0] === '-v')   { console.log(`${PKG} ${VERSION}`); return; }
  const cmd = argv[0];
  if (cmd === 'record') {
    const { opts, claudeArgs } = parseRecordArgs(argv.slice(1));
    return cmdRecord(opts, claudeArgs);
  }
  if (cmd === 'view') {
    const { opts, positional } = parseViewArgs(argv.slice(1));
    return cmdView(opts, positional);
  }
  // default: view
  const { opts, positional } = parseViewArgs(argv);
  return cmdView(opts, positional);
}

// Run main() only when executed as a CLI, not when imported (e.g. by tests).
function isCliEntry() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch { return false; }
}

if (isCliEntry()) {
  try { main(); }
  catch (err) { console.error(`${PKG}: ${err.message}`); process.exit(1); }
}

export {
  encodeProject,
  parseSlug,
  resolveSessionDir,
  safeJoin,
  classify,
  dirHasSessionFiles,
  summarizeSessionDir,
  listSessions,
};
