#!/usr/bin/env node
/**
 * Zoth X Connector — Sovereign Local Controller & Vault Configurator
 * Zero external npm dependencies. Bound strictly to 127.0.0.1.
 * Never exposes raw API keys or OAuth secrets over HTTP.
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8152);
const HOST = '127.0.0.1';

const HOME = process.env.HOME || '/home/zoth';
const VAULT_DIR = path.join(HOME, '.config', 'zoth-vault');
const X_ENV_PATH = path.join(VAULT_DIR, 'x.env');
const STATE_PATH = path.join(VAULT_DIR, 'x_campaign_state.json');
const TIMER_PATH = path.join(HOME, '.config', 'systemd', 'user', 'x-multi-hub.timer');
const MULTI_HUB_SCRIPT = process.env.X_MULTI_HUB_SCRIPT || path.join(HOME, 'Desktop', 'world-of-zoth', 'tools', 'x_multi_hub.mjs');

const KNOWN_HANDLES = ['1nc0gn30', 'zoth_os', 'nealfraziertech', 'dinorawrai', 'zothstudio', 'nullaitech'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function writeEnvFile(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lines = Object.entries(entries)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function getHandleCreds(env, handle) {
  const keyUpper = handle.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  let accessToken = env[`X_TOKEN_${keyUpper}`] || env[`X_ACCESS_TOKEN_${keyUpper}`];
  let accessSecret = env[`X_SECRET_${keyUpper}`] || env[`X_ACCESS_SECRET_${keyUpper}`];
  if (!accessToken && (handle === '1nc0gn30' || handle === 'default')) {
    accessToken = env.X_ACCESS_TOKEN;
    accessSecret = env.X_ACCESS_SECRET;
  }
  return {
    apiKey: env.X_API_KEY,
    apiSecret: env.X_API_SECRET,
    accessToken,
    accessSecret
  };
}

function maskVal(val) {
  if (!val || val.length < 8) return val ? '••••' : '';
  return `${val.slice(0, 4)}••••${val.slice(-4)}`;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {}
  return fallback;
}

function runCmd(bin, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env: { ...process.env, HOME } }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      });
    });
  });
}

function getTimerScheduleHours() {
  if (!fs.existsSync(TIMER_PATH)) return [9, 12, 15, 18, 21];
  const txt = fs.readFileSync(TIMER_PATH, 'utf8');
  const m = txt.match(/OnCalendar=\*-\*-\*\s+([0-9,]+):00:00/);
  if (!m) return [9, 12, 15, 18, 21];
  return m[1].split(',').map(n => Number(n)).filter(n => !Number.isNaN(n));
}

function pct(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function oauthHeader(method, urlStr, creds) {
  const oauth = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0'
  };
  const paramString = Object.keys(oauth)
    .sort()
    .map(k => `${pct(k)}=${pct(oauth[k])}`)
    .join('&');
  const baseStr = `${method.toUpperCase()}&${pct(urlStr)}&${pct(paramString)}`;
  const signingKey = `${pct(creds.apiSecret)}&${pct(creds.accessSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');
  return 'OAuth ' + Object.keys(oauth).sort().map(k => `${pct(k)}="${pct(oauth[k])}"`).join(', ');
}

function sendTweet(text, creds) {
  return new Promise((resolve, reject) => {
    const urlStr = 'https://api.twitter.com/2/tweets';
    const body = Buffer.from(JSON.stringify({ text }), 'utf8');
    const req = https.request(urlStr, {
      method: 'POST',
      headers: {
        Authorization: oauthHeader('POST', urlStr, creds),
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data || '{}');
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json.data);
          else reject(new Error(`HTTP ${res.statusCode}: ${json.detail || json.title || data}`));
        } catch (e) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function buildStatus() {
  const env = parseEnvFile(X_ENV_PATH);
  const state = readJsonSafe(STATE_PATH, { startedAt: null, accounts: {} });
  const [timerActive, timerShow, logsRes] = await Promise.all([
    runCmd('systemctl', ['--user', 'is-active', 'x-multi-hub.timer']),
    runCmd('systemctl', ['--user', 'show', 'x-multi-hub.timer', '-p', 'NextElapseUSecRealtime,LastTriggerUSec,ActiveState,UnitFileState']),
    runCmd('journalctl', ['--user', '-u', 'x-multi-hub.service', '-n', '30', '--no-pager', '-o', 'short-iso'])
  ]);

  const timerProps = {};
  for (const line of timerShow.stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) timerProps[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }

  const allHandles = Array.from(new Set([...KNOWN_HANDLES, ...Object.keys(state.accounts || {})]));
  const accounts = allHandles.map(handle => {
    const creds = getHandleCreds(env, handle);
    const hasToken = Boolean(creds.accessToken && creds.accessSecret);
    const st = state.accounts?.[handle] || { day: 1, nextSlot: 1, history: [] };
    const hist = Array.isArray(st.history) ? st.history : [];
    const last = hist[hist.length - 1] || null;
    return {
      handle,
      connected: hasToken,
      tokenPreview: hasToken ? maskVal(creds.accessToken) : '',
      day: st.day || 1,
      nextSlot: st.nextSlot || 1,
      totalPosts: hist.length,
      lastPost: last
    };
  });

  return {
    ok: true,
    service: 'zoth-x-connector',
    version: '1.0.0',
    vault: {
      path: X_ENV_PATH,
      exists: fs.existsSync(X_ENV_PATH),
      hasConsumerKey: Boolean(env.X_API_KEY && env.X_API_SECRET),
      consumerKeyPreview: maskVal(env.X_API_KEY || ''),
      hasBearer: Boolean(env.X_BEARER_TOKEN)
    },
    timer: {
      installed: fs.existsSync(TIMER_PATH),
      active: timerActive.stdout.trim() === 'active',
      state: timerActive.stdout.trim() || 'unknown',
      enabled: timerProps.UnitFileState === 'enabled',
      nextTrigger: timerProps.NextElapseUSecRealtime || '',
      lastTrigger: timerProps.LastTriggerUSec || '',
      scheduleHours: getTimerScheduleHours()
    },
    multiHubScriptExists: fs.existsSync(MULTI_HUB_SCRIPT),
    campaignStartedAt: state.startedAt || null,
    accounts,
    logs: logsRes.stdout.trim().split('\n').filter(Boolean)
  };
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 1024 * 1024) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'zoth-x-connector', port: PORT, version: '1.0.0' });
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      return sendJson(res, 200, await buildStatus());
    }

    if (req.method === 'POST' && pathname === '/api/run-slot') {
      const body = await readBody(req);
      if (!fs.existsSync(MULTI_HUB_SCRIPT)) {
        return sendJson(res, 404, { ok: false, error: `Multi-hub script not found at ${MULTI_HUB_SCRIPT}` });
      }
      const args = [MULTI_HUB_SCRIPT, '--run-slot'];
      if (body.dryRun) args.push('--dry-run');
      if (body.account && /^[a-zA-Z0-9_]+$/.test(body.account)) {
        args.push('--account', body.account);
      }
      if (body.slot && Number(body.slot) >= 1 && Number(body.slot) <= 5) {
        args.push('--slot', String(Number(body.slot)));
      }
      const out = await runCmd(process.execPath, args, 120000);
      return sendJson(res, out.ok ? 200 : 500, {
        ok: out.ok,
        dryRun: Boolean(body.dryRun),
        output: (out.stdout + '\n' + out.stderr).trim()
      });
    }

    if (req.method === 'POST' && pathname === '/api/timer') {
      const body = await readBody(req);
      const action = body.action;
      if (action === 'start' || action === 'stop' || action === 'restart') {
        const out = await runCmd('systemctl', ['--user', action, 'x-multi-hub.timer']);
        return sendJson(res, out.ok ? 200 : 500, { ok: out.ok, action, message: (out.stdout + out.stderr).trim() || `Timer ${action}ed` });
      }
      if (action === 'schedule') {
        const hours = Array.isArray(body.hours)
          ? Array.from(new Set(body.hours.map(Number).filter(h => Number.isInteger(h) && h >= 0 && h <= 23))).sort((a, b) => a - b)
          : [];
        if (!hours.length) return sendJson(res, 400, { ok: false, error: 'Select at least one hour (0-23).' });
        const calHours = hours.map(h => String(h).padStart(2, '0')).join(',');
        const unit = `[Unit]
Description=Run World of Zoth X Multi-Hub Poster (${hours.length}x Daily)

[Timer]
OnCalendar=*-*-* ${calHours}:00:00
Persistent=true
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
`;
        fs.mkdirSync(path.dirname(TIMER_PATH), { recursive: true });
        fs.writeFileSync(TIMER_PATH, unit, 'utf8');
        await runCmd('systemctl', ['--user', 'daemon-reload']);
        const out = await runCmd('systemctl', ['--user', 'restart', 'x-multi-hub.timer']);
        return sendJson(res, out.ok ? 200 : 500, { ok: out.ok, hours, message: `Updated schedule to ${calHours}:00` });
      }
      return sendJson(res, 400, { ok: false, error: 'Unknown timer action' });
    }

    if (req.method === 'POST' && pathname === '/api/post-now') {
      const body = await readBody(req);
      const handle = String(body.handle || '').replace(/^@/, '').trim();
      const text = String(body.text || '').trim();
      if (!handle || !/^[a-zA-Z0-9_]+$/.test(handle)) return sendJson(res, 400, { ok: false, error: 'Invalid X handle.' });
      if (!text || text.length > 280) return sendJson(res, 400, { ok: false, error: 'Post text must be 1–280 characters.' });

      const env = parseEnvFile(X_ENV_PATH);
      const creds = getHandleCreds(env, handle);
      if (!creds.apiKey || !creds.apiSecret || !creds.accessToken || !creds.accessSecret) {
        return sendJson(res, 400, { ok: false, error: `@${handle} is not connected in Zoth Vault (${X_ENV_PATH}).` });
      }
      if (body.dryRun) {
        return sendJson(res, 200, { ok: true, dryRun: true, handle, length: text.length, preview: text });
      }
      const tweet = await sendTweet(text, creds);
      return sendJson(res, 200, {
        ok: true,
        id: tweet.id,
        url: `https://x.com/${handle}/status/${tweet.id}`
      });
    }

    if (req.method === 'POST' && pathname === '/api/config/account') {
      const body = await readBody(req);
      const env = parseEnvFile(X_ENV_PATH);
      if (body.apiKey) env.X_API_KEY = String(body.apiKey).trim();
      if (body.apiSecret) env.X_API_SECRET = String(body.apiSecret).trim();
      if (body.bearerToken) env.X_BEARER_TOKEN = String(body.bearerToken).trim();
      if (body.handle && body.accessToken && body.accessSecret) {
        const cleanHandle = String(body.handle).replace(/^@/, '').trim();
        if (!/^[a-zA-Z0-9_]+$/.test(cleanHandle)) return sendJson(res, 400, { ok: false, error: 'Invalid X handle.' });
        const keyUpper = cleanHandle.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        env[`X_TOKEN_${keyUpper}`] = String(body.accessToken).trim();
        env[`X_SECRET_${keyUpper}`] = String(body.accessSecret).trim();
      }
      writeEnvFile(X_ENV_PATH, env);
      return sendJson(res, 200, { ok: true, message: 'Saved securely to Zoth Vault (chmod 600).' });
    }

    // Static assets
    let relPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(path.join(PUBLIC_DIR, relPath));
    if (!safePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return fs.createReadStream(safePath).pipe(res);
    }
    // SPA fallback
    const idx = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(idx).pipe(res);
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`✦ Zoth X Connector listening on http://${HOST}:${PORT}`);
});
