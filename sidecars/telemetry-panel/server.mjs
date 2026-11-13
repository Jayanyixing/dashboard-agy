import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectConversationTelemetry,
  resolveAppDataDir,
  resolveHookDataDir,
  SAFE_ID_RE,
} from './lib/telemetry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = 8000;
const BIND_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const PRELOAD_FALLBACK = '// Antigravity sidecar preload stub\n';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function readPreloadJs(appDataDir) {
  const candidates = [
    path.join(appDataDir, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    path.join(resolveAppDataDir(), 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.readFileSync(candidate, 'utf-8');
      }
    } catch {
      // Try next fallback.
    }
  }
  return PRELOAD_FALLBACK;
}

function injectQueryIntoLocalAssets(html, token, conversationId) {
  if (!token && !conversationId) return html;
  const parts = [];
  if (token) parts.push(`token=${encodeURIComponent(token)}`);
  if (conversationId) parts.push(`conversationId=${encodeURIComponent(conversationId)}`);
  const suffix = parts.join('&');
  return html.replace(/\b(href|src)=(["'])(\/[^"'\s>]*)\2/g, (match, attr, quote, urlPath) => {
    if (urlPath.startsWith('//')) return match;
    const [base, ...hashParts] = urlPath.split('#');
    const hash = hashParts.length > 0 ? `#${hashParts.join('#')}` : '';
    const sep = base.includes('?') ? '&' : '?';
    return `${attr}=${quote}${base}${sep}${suffix}${hash}${quote}`;
  });
}

function execAgentApi(args, projectId) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE?.trim();
    const file = exe || 'agentapi';
    const cmdArgs = exe ? ['agentapi', ...args] : args;
    execFile(file, cmdArgs, { encoding: 'utf-8', env, timeout: 15000 }, (err, stdout) => {
      if (err) {
        resolve({ error: err.message });
        return;
      }
      const trimmed = (stdout || '').trim();
      try {
        resolve(trimmed ? JSON.parse(trimmed) : {});
      } catch {
        resolve({ raw: trimmed });
      }
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Payload Too Large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      const p = parseInt(argv[i + 1], 10);
      if (!Number.isNaN(p)) opts.port = p;
      i++;
    }
  }
  return opts;
}

export function createTelemetrySidecar(options = {}) {
  const appDataDir = resolveAppDataDir(options.appDataDir);
  const hookDataDir = options.hookDataDir || resolveHookDataDir(appDataDir);
  const publicDir = options.publicDir || PUBLIC_DIR;
  const envPort = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || '', 10);
  const port = options.port ?? (Number.isNaN(envPort) ? DEFAULT_PORT : envPort);
  const token =
    options.token ??
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ??
    process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN ??
    process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN ??
    '';
  const defaultConversationId =
    options.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? '';
  const preloadJs = readPreloadJs(appDataDir);
  const sseClients = new Set();

  let pollTimer = null;
  let brainWatcher = null;
  let hookWatcher = null;
  let debounceTimer = null;

  function isAuthorized(req, url) {
    if (!token) return true;
    const headerTok =
      typeof req.headers['x-sidecar-token'] === 'string'
        ? req.headers['x-sidecar-token'].trim()
        : '';
    const queryTok = url.searchParams.get('token')?.trim() || '';
    return headerTok === token || queryTok === token;
  }

  function buildSnapshot(conversationId, windowSize) {
    return collectConversationTelemetry({
      appDataDir,
      hookDataDir,
      conversationId: conversationId || defaultConversationId,
      windowSizeOverride: windowSize,
    });
  }

  function pushSseToClient(client) {
    if (client.res.writableEnded || client.res.destroyed) {
      sseClients.delete(client);
      return;
    }
    const snapshot = buildSnapshot(client.conversationId, client.windowSize);
    const serialized = JSON.stringify(snapshot);
    if (serialized === client.lastSerialized) return;
    client.lastSerialized = serialized;
    try {
      client.res.write(`data: ${serialized}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }

  function broadcastAll() {
    for (const client of sseClients) {
      pushSseToClient(client);
    }
  }

  function scheduleBroadcast() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      broadcastAll();
    }, 120);
    debounceTimer.unref?.();
  }

  function startWatchers() {
    const brainDir = path.join(appDataDir, 'brain');
    for (const [dirPath, setter] of [
      [brainDir, (w) => { brainWatcher = w; }],
      [hookDataDir, (w) => { hookWatcher = w; }],
    ]) {
      try {
        if (fs.existsSync(dirPath)) {
          const w = fs.watch(dirPath, { recursive: true }, () => scheduleBroadcast());
          w.on('error', () => {});
          w.unref?.();
          setter(w);
        }
      } catch {
        // Fallback polling handles environments where recursive fs.watch is unavailable.
      }
    }

    pollTimer = setInterval(broadcastAll, 700);
    pollTimer.unref?.();
  }

  function stopWatchers() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    for (const w of [brainWatcher, hookWatcher]) {
      if (w) {
        try {
          w.close();
        } catch {
          // Ignore close error.
        }
      }
    }
    brainWatcher = null;
    hookWatcher = null;
    for (const client of sseClients) {
      try {
        if (!client.res.writableEnded) client.res.end();
      } catch {
        // Ignore end error.
      }
    }
    sseClients.clear();
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${BIND_HOST}:${port}`);
    const pathname = url.pathname || '/';

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(preloadJs);
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/ui.html')) {
      try {
        let html = fs.readFileSync(path.join(publicDir, 'ui.html'), 'utf-8');
        const reqToken = url.searchParams.get('token')?.trim() || '';
        const reqConvId = url.searchParams.get('conversationId')?.trim() || '';
        html = injectQueryIntoLocalAssets(html, reqToken, reqConvId);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Failed to load ui.html: ${err.message}`);
      }
      return;
    }

    if (req.method === 'GET' && (pathname === '/styles.css' || pathname === '/app.js')) {
      const target = path.join(publicDir, pathname.slice(1));
      const ext = path.extname(target);
      try {
        const body = fs.readFileSync(target, 'utf-8');
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain; charset=utf-8' });
        res.end(body);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Not found: ${err.message}`);
      }
      return;
    }

    if ((pathname.startsWith('/api/') || pathname.startsWith('/_sidecar/')) && !isAuthorized(req, url)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/telemetry') {
      const convId = url.searchParams.get('conversationId') || '';
      const windowSize = url.searchParams.get('windowSize') || '';
      sendJson(res, 200, buildSnapshot(convId, windowSize));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      const convId = url.searchParams.get('conversationId') || '';
      const windowSize = url.searchParams.get('windowSize') || '';
      res.socket?.setNoDelay?.(true);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const client = {
        res,
        conversationId: convId,
        windowSize,
        lastSerialized: '',
      };
      sseClients.add(client);
      pushSseToClient(client);

      const cleanup = () => sseClients.delete(client);
      req.once('close', cleanup);
      res.once('close', cleanup);
      res.once('error', cleanup);
      return;
    }

    if (req.method === 'POST' && pathname === '/_sidecar/get-conversation-metadata') {
      try {
        const body = await readJsonBody(req);
        const convId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
        if (!convId || !SAFE_ID_RE.test(convId)) {
          sendJson(res, 400, { error: 'Invalid or missing conversationId' });
          return;
        }
        sendJson(res, 200, await execAgentApi(['get-conversation-metadata', convId]));
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/_sidecar/send-message') {
      try {
        const body = await readJsonBody(req);
        const convId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
        if (!convId || !SAFE_ID_RE.test(convId)) {
          sendJson(res, 400, { error: 'Invalid or missing conversationId' });
          return;
        }
        const args = ['send-message'];
        if (body.title) args.push('--title', String(body.title));
        args.push(convId, String(body.message || ''));
        sendJson(res, 200, await execAgentApi(args, body.projectId));
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  return {
    server,
    start() {
      startWatchers();
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, BIND_HOST, () => {
          const addr = server.address();
          console.log(`[dashboard-agy] listening on http://${BIND_HOST}:${addr.port}`);
          resolve(addr.port);
        });
      });
    },
    async close() {
      stopWatchers();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cliOpts = parseArgs(process.argv.slice(2));
  const app = createTelemetrySidecar({ port: cliOpts.port });
  app.start();
  const shutdown = () => {
    app.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
