import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');

// Isolated temporary HOME so tests NEVER read/mutate live ~/.config/zoth-vault or post to X
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zoth-x-conn-test-'));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return res.json();
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error(`Server did not become healthy at ${baseUrl}: ${lastErr?.message || 'timeout'}`);
}

after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('zoth-x-connector — syntax & CLI checks', () => {
  it('server.mjs, bin/zoth-x-connector, and public/app.js pass node --check', () => {
    for (const rel of ['server.mjs', 'bin/zoth-x-connector', 'public/app.js']) {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000
      });
    }
  });

  it('bin/zoth-x-connector --help exits 0 with usage info', () => {
    const out = execFileSync(path.join(ROOT, 'bin/zoth-x-connector'), ['--help'], {
      encoding: 'utf8',
      timeout: 5000
    });
    assert.match(out, /zoth-x-connector/);
    assert.match(out, /--status/);
    assert.match(out, /--json/);
  });

  it('bin/zoth-x-connector --json outputs deterministic read-only JSON', () => {
    const out = execFileSync(path.join(ROOT, 'bin/zoth-x-connector'), ['--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: TMP_HOME },
      timeout: 5000
    });
    const data = JSON.parse(out);
    assert.equal(data.id, 'zoth-x-connector');
    assert.equal(data.version, '1.0.0');
    assert.equal(data.vaultExists, false);
    assert.equal(data.license, '100% Free & Open Access');
    assert.equal(data.support.stripe, 'https://buy.stripe.com/3cIfZg27PdKo2D64Ocfw40X');
    assert.equal(data.support.solana, 'GG2eQbVh8ut1BK6j1A2tz7pSySdLpD38BgyEhGcxdXoK');
  });
});

describe('zoth-x-connector — ephemeral read-only HTTP contract', () => {
  let child = null;
  let port = 0;
  let baseUrl = '';

  before(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
      env: {
        ...process.env,
        PORT: String(port),
        HOME: TMP_HOME,
        X_MULTI_HUB_SCRIPT: path.join(TMP_HOME, 'nonexistent-multi-hub.mjs')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await waitForHealth(baseUrl);
  });

  after(async () => {
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 2500);
      killTimer.unref();
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  });

  it('GET /health returns 200 with service metadata', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'zoth-x-connector');
    assert.equal(body.port, port);
    assert.equal(body.version, '1.0.0');
  });

  it('GET /api/status returns 200 with isolated vault & accounts contract (no secrets)', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'zoth-x-connector');
    assert.equal(body.vault.exists, false);
    assert.equal(body.vault.hasConsumerKey, false);
    assert.equal(body.multiHubScriptExists, false);
    assert.ok(Array.isArray(body.accounts) && body.accounts.length >= 1);
    assert.ok(Array.isArray(body.timer.scheduleHours));
    for (const acc of body.accounts) {
      assert.equal(acc.connected, false);
      assert.equal(acc.accessSecret, undefined);
    }
  });

  it('GET / serves HTML workstation and static SEO files with 200', async () => {
    const [rootRes, robotsRes, sitemapRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/robots.txt`),
      fetch(`${baseUrl}/sitemap.xml`)
    ]);
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers.get('content-type') || '', /text\/html/);
    assert.match(await rootRes.text(), /Zoth X Connector/);

    assert.equal(robotsRes.status, 200);
    assert.equal(sitemapRes.status, 200);
  });

  it('POST /api/post-now validates inputs and blocks unconnected accounts without calling X', async () => {
    const badHandle = await fetch(`${baseUrl}/api/post-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'bad handle!', text: 'test', dryRun: true })
    });
    assert.equal(badHandle.status, 400);

    const emptyText = await fetch(`${baseUrl}/api/post-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: '1nc0gn30', text: '', dryRun: true })
    });
    assert.equal(emptyText.status, 400);

    const unconnected = await fetch(`${baseUrl}/api/post-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: '1nc0gn30', text: 'read-only check', dryRun: true })
    });
    assert.equal(unconnected.status, 400);
    const body = await unconnected.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /not connected in Zoth Vault/i);
  });
});

describe('zoth-x-connector — production guardrail invariants', () => {
  it('public/robots.txt allows frontier crawlers and declares absolute Sitemap', () => {
    const txt = fs.readFileSync(path.join(ROOT, 'public/robots.txt'), 'utf8');
    for (const bot of ['User-agent: *', 'Googlebot', 'GPTBot', 'ClaudeBot', 'PerplexityBot', 'Applebot']) {
      assert.ok(txt.includes(bot), `robots.txt missing ${bot}`);
    }
    assert.match(txt, /^Sitemap:\s+https:\/\/.+\/sitemap\.xml$/m);
  });

  it('public/sitemap.xml has valid urlset, canonical loc, and lastmod', () => {
    const xml = fs.readFileSync(path.join(ROOT, 'public/sitemap.xml'), 'utf8');
    assert.match(xml, /<urlset\b/);
    assert.match(xml, /<loc>https:\/\/[^<]+<\/loc>/);
    assert.match(xml, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  });

  it('netlify.toml defines publish dir, security headers, and SPA catch-all redirect', () => {
    const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
    assert.match(toml, /publish\s*=\s*"public"/);
    assert.match(toml, /X-Frame-Options\s*=\s*"SAMEORIGIN"/);
    assert.match(toml, /X-Content-Type-Options\s*=\s*"nosniff"/);
    assert.match(toml, /Referrer-Policy\s*=\s*"strict-origin-when-cross-origin"/);
    assert.match(toml, /from\s*=\s*"\/\*"/);
    assert.match(toml, /to\s*=\s*"\/index\.html"/);
    assert.match(toml, /status\s*=\s*200/);
  });

  it('public/index.html has valid JSON-LD @graph, support links, and zero paywall stubs', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);

    const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(ldMatch, 'Missing JSON-LD script block');
    const ld = JSON.parse(ldMatch[1]);
    assert.equal(ld['@context'], 'https://schema.org');
    assert.ok(Array.isArray(ld['@graph']), 'JSON-LD must contain @graph array');

    const hasApp = ld['@graph'].some(n => {
      const types = Array.isArray(n['@type']) ? n['@type'] : [n['@type']];
      return types.includes('WebApplication') || types.includes('SoftwareApplication');
    });
    const hasFaq = ld['@graph'].some(n => n['@type'] === 'FAQPage' && Array.isArray(n.mainEntity) && n.mainEntity.length >= 2);
    assert.ok(hasApp, 'JSON-LD @graph missing WebApplication/SoftwareApplication');
    assert.ok(hasFaq, 'JSON-LD @graph missing FAQPage with >=2 questions');

    assert.ok(html.includes('https://buy.stripe.com/3cIfZg27PdKo2D64Ocfw40X'), 'Missing Stripe Buy Us a Coffee link');
    assert.ok(html.includes('GG2eQbVh8ut1BK6j1A2tz7pSySdLpD38BgyEhGcxdXoK'), 'Missing Solana tip address');

    const lower = html.toLowerCase();
    for (const forbidden of ['depay', 'filter: blur(', 'license key', 'unlock pro', 'founding lifetime']) {
      assert.ok(!lower.includes(forbidden), `Forbidden paywall stub found: ${forbidden}`);
    }
  });
});
