'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Free-mint triage server
// Stack: Node.js 18+, zero npm deps (built-in http + global fetch)
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// x402 (optional — guarded: if the packages are missing the server still
// boots and every other route keeps working; only /x402/verify degrades).
let x402FacilitatorClient = null;
try {
  const { facilitator } = require('@coinbase/x402');
  const { HTTPFacilitatorClient } = require('@x402/core/http');
  x402FacilitatorClient = new HTTPFacilitatorClient(facilitator);
} catch (err) {
  console.log('[x402] facilitator client unavailable:', err.message);
}

const PORT          = process.env.PORT || 3000;
const ZERO_ADDRESS  = '0x0000000000000000000000000000000000000000';
const ADDR_RE       = /^0x[0-9a-fA-F]{40}$/;
const TIMEOUT_MS    = 10_000;

// BSC RPC nodes — blastapi is the most reliable free endpoint; publicnode
// rate-limits aggressively and is not used.
const NODES = [
  'https://bsc-mainnet.public.blastapi.io',
  'https://bsc-dataseed.bnbchain.org',
];

// Pre-computed function selectors
// mint(uint256)         keccak256 → 0xa0712d68
// freeMint()            keccak256 → 0x5b70ea9f   (verified offline 2026-11-10)
// mintFree()            keccak256 → 0x8ab53447   (verified offline 2026-11-10)
// mint(uint256,address) keccak256 → 0x94bf804d
const SELECTORS = [
  {
    name:     'mint(uint256)',
    calldata: '0xa0712d68' +
              '0000000000000000000000000000000000000000000000000000000000000001',
  },
  {
    name:     'freeMint()',
    calldata: '0x5b70ea9f',
  },
  {
    name:     'mintFree()',
    calldata: '0x8ab53447',
  },
  {
    name:     'mint(uint256,address)',
    calldata: '0x94bf804d' +
              '0000000000000000000000000000000000000000000000000000000000000001' +
              '0000000000000000000000000000000000000000000000000000000000000000',
  },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Fetch JSON with a hard timeout.
 * Returns { ok: true, data } or { ok: false, error: string }.
 */
async function fetchJson(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'timeout after 10s' : String(err.message || err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post a JSON-RPC request to a BSC node.
 */
async function rpcCall(nodeUrl, method, params) {
  return fetchJson(nodeUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

// ─── on-chain simulation ──────────────────────────────────────────────────────

/**
 * Try the three mint selectors in order against a single node.
 * Returns the first success, or the last result if all fail.
 */
async function simOnNode(nodeUrl, contract, from) {
  let last = null;
  for (const sel of SELECTORS) {
    const result = await rpcCall(nodeUrl, 'eth_call', [
      {
        from,
        to:    contract,
        value: '0x0',
        gas:   '0xf4240',
        data:  sel.calldata,
      },
      'latest',
    ]);

    if (!result.ok) {
      last = { status: 'unavailable', selector: sel.name, detail: result.error };
      continue;
    }

    const rpc = result.data;

    // A success means result is a hex string (even 0x) with no error field
    if (rpc.result !== undefined && !rpc.error) {
      return { status: 'success', selector: sel.name, detail: rpc.result };
    }

    // RPC-level error: a real revert means the mint function ran and refused
    // (gated / sold out / now paid). A node error (rate limit, overload) is
    // NOT a revert — report it as unavailable, never as a pass or fail.
    const errMsg = rpc.error
      ? (rpc.error.message || JSON.stringify(rpc.error))
      : 'no result field';
    const isNodeError = rpc.error && (
      rpc.error.code === -32005 ||
      /rate limit/i.test(errMsg) ||
      /too many requests/i.test(errMsg)
    );
    last = isNodeError
      ? { status: 'unavailable', selector: sel.name, detail: errMsg }
      : { status: 'revert', selector: sel.name, detail: errMsg };
  }
  return last;
}

/**
 * Run eth_getCode + sim on both nodes in parallel.
 */
async function runSimulations(contract, from) {
  // eth_getCode — just need one authoritative answer; use the primary node
  const codeResult = await rpcCall(NODES[0], 'eth_getCode', [contract, 'latest']);
  let codeExists = null; // null = unknown
  if (codeResult.ok) {
    const raw = codeResult.data.result || '';
    // "0x" or "0x0" means no code
    codeExists = raw !== '0x' && raw !== '0x0' && raw.length > 2;
  }

  // Sim both nodes in parallel
  const [sim1, sim2] = await Promise.all([
    simOnNode(NODES[0], contract, from),
    simOnNode(NODES[1], contract, from),
  ]);

  return {
    code: { exists: codeExists },
    node1: { node: NODES[0], ...sim1 },
    node2: { node: NODES[1], ...sim2 },
  };
}

// ─── GoPlus ──────────────────────────────────────────────────────────────────

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1';

/**
 * Fetch one GoPlus endpoint (token or nft) for chain 56.
 * Returns { indexed, flags, raw } or { indexed: false } when empty / error.
 */
async function fetchGoPlus(endpoint, contract) {
  const url = `${GOPLUS_BASE}/${endpoint}/56?contract_addresses=${contract}`;
  const result = await fetchJson(url);

  if (!result.ok) {
    return { indexed: false, error: result.error };
  }

  const body = result.data;

  // GoPlus wraps results: body.result is an object keyed by address (lowercase)
  if (!body || body.code !== 1 || !body.result) {
    return { indexed: false };
  }

  // Address key is lowercase
  const key  = contract.toLowerCase();
  const data = body.result[key];

  if (!data || Object.keys(data).length === 0) {
    return { indexed: false };
  }

  // Extract the flags we care about
  const flags = {};
  const FLAG_FIELDS = [
    'is_honeypot',
    'honeypot_with_same_creator',
    'is_blacklisted',
    'is_whitelisted',
    'is_in_dex',
    'is_anti_whale',
    'is_mintable',
    'is_proxy',
    'is_open_source',
    'can_take_back_ownership',
    'owner_change_balance',
    'hidden_owner',
    'selfdestruct',
    'external_call',
    'is_airdrop_scam',
    'transfer_pausable',
    // NFT-specific
    'oversupply_minting',
    'nft_proxy',
    'nft_open_source',
  ];
  for (const f of FLAG_FIELDS) {
    if (data[f] !== undefined) flags[f] = data[f];
  }

  return { indexed: true, flags, raw: data };
}

async function runGoPlus(contract) {
  const [token, nft] = await Promise.all([
    fetchGoPlus('token_security', contract),
    fetchGoPlus('nft_security',   contract),
  ]);
  return { token, nft };
}

// ─── Sourcify ─────────────────────────────────────────────────────────────────

async function runSourcify(contract) {
  const url    = `https://sourcify.dev/server/v2/contract/56/${contract}`;
  const result = await fetchJson(url);

  if (!result.ok) {
    return { checked: false, error: result.error, match: null };
  }

  // A 404 from Sourcify still returns JSON with error; look for the match field
  const body  = result.data;
  const match = body && body.match != null ? body.match : null;

  return { checked: true, match };
}

// ─── verdict ─────────────────────────────────────────────────────────────────

/**
 * Deterministic verdict from collected evidence.
 * Red-flag > clean > ambiguous (last resort)
 */
function computeVerdict(evidence) {
  const { code, simulation, goplus, sourcify } = evidence;

  // ── Red-flag conditions ──────────────────────────────────────────────────
  // 1. No code at address
  if (code.exists === false) {
    return {
      verdict: 'red-flag',
      summary: 'No contract code found at this address.',
    };
  }

  // 2. GoPlus honeypot / malicious flag
  const goplusRedFlag = checkGoPlusRedFlag(goplus);
  if (goplusRedFlag) {
    return {
      verdict: 'red-flag',
      summary: `GoPlus flagged this contract: ${goplusRedFlag}.`,
    };
  }

  // 3. Both nodes reverted or unavailable (no success on either)
  const n1ok = simulation.node1.status === 'success';
  const n2ok = simulation.node2.status === 'success';
  if (!n1ok && !n2ok) {
    // Only a red-flag if at least one node actually reverted (not just unavailable)
    const anyRevert =
      simulation.node1.status === 'revert' ||
      simulation.node2.status === 'revert';
    if (anyRevert) {
      // A reverting mint is NOT proof of malice: the free lane may be gated
      // (Agent ID / allowlist), sold out, or now paid. Only call it a red
      // flag when the source is also unverified.
      const srcOk = sourcify.match === 'exact_match' || sourcify.match === 'partial_match';
      if (srcOk && !goplusRedFlag) {
        return {
          verdict: 'ambiguous',
          summary: 'Mint simulation reverted on both nodes — the free lane may be gated (Agent ID / allowlist), sold out, or now paid. Retry with your wallet address, or check the project site for its exact mint function.',
        };
      }
      return {
        verdict: 'red-flag',
        summary: 'Mint simulation reverted on both nodes and the source is unverified — treat as not mintable.',
      };
    }
  }

  // ── Clean conditions ─────────────────────────────────────────────────────
  // Both nodes succeeded, Sourcify verified, GoPlus indexed with no flags
  if (n1ok && n2ok) {
    const srcOk = sourcify.match === 'exact_match' || sourcify.match === 'partial_match';
    const gpOk  = goplusIndexedClean(goplus);
    if (srcOk && gpOk) {
      return {
        verdict: 'clean',
        summary: 'Mint simulated successfully on both nodes; source verified; no GoPlus flags found.',
      };
    }
  }

  // ── Ambiguous ─────────────────────────────────────────────────────────────
  return {
    verdict: 'ambiguous',
    summary: buildAmbiguousSummary(evidence),
  };
}

function checkGoPlusRedFlag(goplus) {
  for (const type of ['token', 'nft']) {
    const gp = goplus[type];
    if (!gp || !gp.indexed) continue;
    const f = gp.flags || {};
    if (f.is_honeypot === '1')             return 'honeypot detected';
    if (f.honeypot_with_same_creator === '1') return 'honeypot creator';
    if (f.is_airdrop_scam === '1')         return 'airdrop scam';
  }
  return null;
}

function goplusIndexedClean(goplus) {
  // At least one of token / nft must be indexed
  const anyIndexed = goplus.token.indexed || goplus.nft.indexed;
  if (!anyIndexed) return false;

  // Check both indexed sources for any red flags
  for (const type of ['token', 'nft']) {
    const gp = goplus[type];
    if (!gp.indexed) continue;
    const f = gp.flags || {};
    if (f.is_honeypot === '1' ||
        f.honeypot_with_same_creator === '1' ||
        f.is_airdrop_scam === '1') return false;
  }
  return true;
}

function buildAmbiguousSummary(evidence) {
  const parts = [];
  const { code, simulation, goplus, sourcify } = evidence;

  if (code.exists === null) parts.push('code presence unknown');

  const n1ok = simulation.node1.status === 'success';
  const n2ok = simulation.node2.status === 'success';
  if (!n1ok || !n2ok) {
    if (n1ok || n2ok) {
      parts.push('mint simulation succeeded on one node only');
    } else {
      parts.push('mint simulation unavailable on both nodes');
    }
  }

  const anyGpIndexed = goplus.token.indexed || goplus.nft.indexed;
  if (!anyGpIndexed) parts.push('contract not indexed by GoPlus');

  if (!sourcify.match) parts.push('source not verified on Sourcify');

  return parts.length
    ? `Needs closer inspection: ${parts.join('; ')}.`
    : 'Some checks incomplete — review evidence manually.';
}

// ─── triage handler ───────────────────────────────────────────────────────────

async function handleTriage(query) {
  // Input validation
  const rawContract = (query.contract || '').trim();
  if (!ADDR_RE.test(rawContract)) {
    return { status: 400, body: { error: 'contract must be a 0x address (40 hex chars)' } };
  }
  const contract = rawContract.toLowerCase();

  const rawFrom = (query.from || '').trim();
  const from    = ADDR_RE.test(rawFrom) ? rawFrom : ZERO_ADDRESS;

  // Run all checks in parallel
  const [simResult, goplusResult, sourcifyResult] = await Promise.all([
    runSimulations(contract, from),
    runGoPlus(contract),
    runSourcify(contract),
  ]);

  const evidence = {
    code:       simResult.code,
    simulation: {
      node1: simResult.node1,
      node2: simResult.node2,
    },
    goplus:   goplusResult,
    sourcify: sourcifyResult,
  };

  const { verdict, summary } = computeVerdict(evidence);

  return {
    status: 200,
    body: {
      contract,
      from,
      verdict,
      summary,
      disclaimer: 'This is a first-pass triage, not a safety guarantee.',
      checked_at: new Date().toISOString(),
      evidence,
    },
  };
}

// ─── static file serving ──────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(__dirname, 'public', urlPath);
  const ext      = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

function parseQuery(urlStr) {
  const idx = urlStr.indexOf('?');
  if (idx === -1) return {};
  const params = new URLSearchParams(urlStr.slice(idx + 1));
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

// ─── BotWork agent webhook (v1) ─────────────────────────────────────────────
// BotWork sends paid tasks here as POST { taskId, payload } and expects a
// fast 200. Ara picks queued tasks up on a poll loop; results go back
// through BotWork's own completion path (dashboard / Telegram bot).
// NOTE: Render free tier sleeps when idle — first hit after idle wakes ~50s.
const BOTWORK_TASKS_FILE = path.join(__dirname, 'botwork-tasks.jsonl');
let botworkQueue = [];

function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function botworkStore(task) {
  botworkQueue.push(task);
  if (botworkQueue.length > 200) botworkQueue = botworkQueue.slice(-200);
  fs.appendFile(BOTWORK_TASKS_FILE, JSON.stringify(task) + '\n', () => {});
}

async function handleBotwork(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agent: 'zhi19', queued: botworkQueue.length }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
    return;
  }
  const task = {
    taskId: body.taskId || body.task_id || body.id || null,
    payload: body.payload ?? body.task ?? body.prompt ?? body.description ?? null,
    receivedAt: new Date().toISOString(),
    raw: body,
  };
  botworkStore(task);
  console.log(`[botwork] task received: ${task.taskId}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, taskId: task.taskId, status: 'queued', agent: 'zhi19' }));
}

// ─── Moltify agent webhook (v3) ─────────────────────────────────────────────
// Moltify sends buyer tasks as POST { event: 'task.submitted', timestamp,
// data: { taskId, agentId, title, description, agreedPrice, status,
// callbackUrl, test } } and expects the agent to POST back to
// data.callbackUrl within 15s ("Callback round-trip" test).
// Verified 2026-11-12: POST { taskId, status, result } to a callbackUrl
// returns 200 {"received":true} with no auth header needed.
// v3: the callback is HMAC-signed — HMAC-SHA256(secret, raw JSON body),
// hex digest in header X-Moltify-Signature (plus X-Webhook-Signature with
// the same value as a fallback name). The secret lives ONLY in the Render
// env var MOLTIFY_WEBHOOK_SECRET, never in code. This is the standard
// scheme (first guess); if the live test still rejects it, the stored
// inbound headers from Moltify's own delivery will show the exact
// header/format they use — mirror that next.
// v2 behaviour kept: test tasks get 'completed' + verification message;
// real tasks get 'accepted' immediately (the result follows via a second
// callback once the work is done — TODO when the first real task arrives).
// The callback is awaited (10s cap) before the 200 reply so it goes out fast.
// Queue is listed at GET /moltify-tasks; each entry records its callback
// and the inbound headers (authorization excluded).
// NOTE: Render free tier sleeps when idle — first hit after idle wakes
// ~50s. The 5-min BotWork queue-watch poll keeps the instance warm.
const MOLTIFY_TASKS_FILE = path.join(__dirname, 'moltify-tasks.jsonl');
const MOLTIFY_WEBHOOK_SECRET = process.env.MOLTIFY_WEBHOOK_SECRET || '';
let moltifyQueue = [];

// POST JSON with a hard timeout. Returns the fetch Response.
async function postJson(url, obj, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// POST JSON signed with HMAC-SHA256(secret, rawBody). The signature covers
// the exact raw bytes sent — never a re-serialized copy.
async function postSignedJson(url, obj, secret, timeoutMs = 10_000) {
  const raw = JSON.stringify(obj);
  const sig = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Moltify-Signature': sig,
        'X-Webhook-Signature': sig,
      },
      body: raw,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function moltifyStore(task) {
  moltifyQueue.push(task);
  if (moltifyQueue.length > 200) moltifyQueue = moltifyQueue.slice(-200);
  fs.appendFile(MOLTIFY_TASKS_FILE, JSON.stringify(task) + '\n', () => {});
}

async function handleMoltify(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agent: 'zhi19', queued: moltifyQueue.length }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
    return;
  }
  const data = (body && typeof body === 'object' && body.data && typeof body.data === 'object') ? body.data : body;
  const task = {
    taskId: data.taskId || data.task_id || data.id || (data.task && data.task.id) || null,
    payload: data.payload ?? data.task ?? data.prompt ?? data.description ?? data.input ?? null,
    receivedAt: new Date().toISOString(),
    raw: body,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.includes('authorization'))),
  };
  const callbackUrl = data.callbackUrl || data.callback_url || body.callbackUrl || null;
  if (callbackUrl) {
    const isTest = data.test === true || task.taskId === null || String(task.taskId || '').startsWith('test');
    const payload = isTest
      ? { taskId: task.taskId, status: 'completed', result: 'Connection verified: Yudi Research Desk webhook is live and responding.' }
      : { taskId: task.taskId, status: 'accepted', message: 'Task received — Yudi Research Desk is working on it.' };
    try {
      const resp = MOLTIFY_WEBHOOK_SECRET
        ? await postSignedJson(callbackUrl, payload, MOLTIFY_WEBHOOK_SECRET, 10_000)
        : await postJson(callbackUrl, payload, 10_000);
      task.callback = { ok: resp.ok, status: resp.status, signed: Boolean(MOLTIFY_WEBHOOK_SECRET) };
      console.log(`[moltify] callback ${resp.status} (signed=${task.callback.signed}) for ${task.taskId}`);
    } catch (err) {
      task.callback = { ok: false, error: String((err && err.message) || err).slice(0, 120) };
      console.log(`[moltify] callback failed for ${task.taskId}: ${task.callback.error}`);
    }
  }
  moltifyStore(task);
  console.log(`[moltify] task received: ${task.taskId}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, taskId: task.taskId, status: 'queued', agent: 'zhi19' }));
}

// ─── x402 paid services ─────────────────────────────────────────────────────
// Three paid products share one flow (x402PaidFlow): no X-PAYMENT header ->
// 402 with accepts; paid -> facilitator verify (CDP keys from env) ->
// produce() -> facilitator settle -> 200 + X-PAYMENT-RESPONSE header.
// produce() runs BEFORE settle: if it fails, the buyer is NOT charged.
//   GET /x402/verify?contract=0x...&from=0x...   — deep mint verification, $0.50
//   GET /x402/research?topic=...&lang=id|en|zh  — research brief, $5, sync
//   GET /x402/research-deep?topic=...&lang=...  — deep research report, $25, async job
//   GET /x402/jobs/:id                          — deep job status + report
//   GET /x402/jobs                              — recent deep jobs (worker poll)
//   POST /x402/jobs/:id/result                  — worker ingest (X-JOB-SECRET)
// Orchestration is manual on purpose: @x402/core's x402HTTPResourceServer
// demands a registered scheme implementation for exact/base and its
// initialize() needs facilitator auth even for the 402 path, so we call the
// HTTPFacilitatorClient directly and build the 402 body ourselves.
const X402_PAY_TO   = '0xf437F9fe8851Da07197ebd7C1bEa6504d45A7Ceb';
const X402_ASSET    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bd029029'; // USDC on Base
const X402_NETWORK  = 'eip155:8453';
const X402_TIMEOUT  = 300;
const X402_VERIFY_AMOUNT   = '500000';   // 0.50 USDC
const X402_RESEARCH_AMOUNT = '5000000';  // 5 USDC
const X402_DEEP_AMOUNT     = '25000000'; // 25 USDC
const X402_SALES_FILE = path.join(__dirname, 'x402-sales.jsonl');
const X402_JOBS_FILE  = path.join(__dirname, 'x402-jobs.jsonl');
const X402_JOB_SECRET = process.env.X402_JOB_SECRET || '';

function x402Requirements(amount) {
  return {
    scheme: 'exact',
    network: X402_NETWORK,
    asset: X402_ASSET,
    amount,
    payTo: X402_PAY_TO,
    maxTimeoutSeconds: X402_TIMEOUT,
    extra: { name: 'USDC', version: '2' },
  };
}

function x402PaymentRequiredBody(error, amount) {
  return {
    x402Version: 2,
    error: error || 'Payment Required',
    accepts: [x402Requirements(amount)],
  };
}

// ── Deep checks (paid report only) ──────────────────────────────────────────
// PancakeSwap V2 pair + liquidity for the contract token (answers: sellable?).
const PCS_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const WBNB_ADDR   = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT_BSC    = '0x55d398326f99059fF775485246999027B3197955';

function padAddr(a) { return '000000000000000000000000' + a.slice(2).toLowerCase(); }

async function checkOnePair(token, quote, quoteSymbol) {
  try {
    const pairData = await rpcCall(NODES[0], 'eth_call', [{
      to: PCS_FACTORY,
      data: '0xe6a43905' + padAddr(token) + padAddr(quote),
    }, 'latest']);
    const pair = '0x' + (pairData || '').slice(-40);
    if (!pair || pair === '0x0000000000000000000000000000000000000000') {
      return { quote: quoteSymbol, pair: null };
    }
    const [res, lp] = await Promise.all([
      rpcCall(NODES[0], 'eth_call', [{ to: pair, data: '0x0902f1ac' }, 'latest']).catch(() => null),
      rpcCall(NODES[0], 'eth_call', [{ to: pair, data: '0x18160ddd' }, 'latest']).catch(() => null),
    ]);
    const out = { quote: quoteSymbol, pair };
    if (res && res !== '0x') {
      out.reserve0 = BigInt('0x' + res.slice(2, 66)).toString();
      out.reserve1 = BigInt('0x' + res.slice(66, 130)).toString();
    }
    if (lp && lp !== '0x') out.lpTotalSupply = BigInt(lp).toString();
    return out;
  } catch (err) {
    return { quote: quoteSymbol, pair: null, error: err.message };
  }
}

async function checkPairs(contract) {
  const [wbnb, usdt] = await Promise.all([
    checkOnePair(contract, WBNB_ADDR, 'WBNB'),
    checkOnePair(contract, USDT_BSC, 'USDT'),
  ]);
  return { checked: true, wbnb, usdt };
}

// Sourcify source scan for owner-control / risky function names.
async function scanSource(contract) {
  const url = `https://sourcify.dev/server/v2/contract/56/${contract}?fields=sources`;
  const result = await fetchJson(url);
  if (!result.ok || !result.data || !result.data.sources) {
    return { checked: false, error: result.error || 'sources unavailable' };
  }
  let text = '';
  let files = 0;
  for (const [name, entry] of Object.entries(result.data.sources)) {
    if (entry && entry.content) { text += '\n' + entry.content; files += 1; }
  }
  const WATCH = [
    'onlyOwner', 'setPrice', 'setBaseURI', 'setBaseUri', 'withdraw', 'pause',
    'unpause', 'setFee', 'setTax', 'setMaxTx', 'setMaxWallet', 'blacklist',
    'setMinter', 'mintToOwner', 'renounceOwnership', 'transferOwnership',
  ];
  const hits = {};
  for (const w of WATCH) {
    const n = (text.match(new RegExp(w, 'g')) || []).length;
    if (n > 0) hits[w] = n;
  }
  return { checked: true, files, bytes: text.length, hits };
}

async function runDeepChecks(contract) {
  const [pairs, source] = await Promise.all([
    checkPairs(contract).catch((e) => ({ checked: false, error: e.message })),
    scanSource(contract).catch((e) => ({ checked: false, error: e.message })),
  ]);
  return { pairs, source };
}

// ── Shared paid flow ────────────────────────────────────────────────────────
// produce(payer) returns { status, body, meta } — meta is merged into the
// sale record. Any non-200 status returns WITHOUT settling the payment.
// onSettled() runs after a successful settle and before the 200 goes out:
// use it for side effects that must only happen for a PAID request (a deep
// job must not become queued if settle fails, or the worker would do $25 of
// free work for an unpaid buyer).
async function x402PaidFlow(req, res, amount, service, produce, onSettled) {
  const paymentHeader = req.headers['x-payment'];
  if (!paymentHeader) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x402PaymentRequiredBody(null, amount), null, 2));
    return;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
  } catch (err) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x402PaymentRequiredBody('Invalid X-PAYMENT header', amount), null, 2));
    return;
  }
  // Shape-check before calling the facilitator: a malformed payload is a
  // 402, not a facilitator error.
  if (!payload || !payload.payload || !payload.payload.authorization ||
      !payload.payload.authorization.from || !payload.payload.signature) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x402PaymentRequiredBody('Invalid payment payload', amount), null, 2));
    return;
  }
  if (!x402FacilitatorClient) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'payment verification unavailable — facilitator not configured (CDP keys missing)' }));
    return;
  }
  const requirements = x402Requirements(amount);
  let verify;
  try {
    verify = await x402FacilitatorClient.verify(payload, requirements);
  } catch (err) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'payment verification failed', detail: err.message }));
    return;
  }
  if (!verify || !verify.isValid) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x402PaymentRequiredBody(
      (verify && (verify.invalidReason || verify.invalidMessage)) || 'Payment invalid', amount
    ), null, 2));
    return;
  }
  const payer = (verify.payer ||
    (payload.payload && payload.payload.authorization && payload.payload.authorization.from) || '').toLowerCase();
  let produced;
  try {
    produced = await produce(payer);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
    return;
  }
  if (!produced || produced.status !== 200) {
    res.writeHead(produced ? produced.status : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(produced ? produced.body : { error: 'Internal server error' }));
    return;
  }
  let settle;
  try {
    settle = await x402FacilitatorClient.settle(payload, requirements);
  } catch (err) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x402PaymentRequiredBody('Settlement failed: ' + err.message, amount), null, 2));
    return;
  }
  if (!settle || !settle.success) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x402PaymentRequiredBody(
      'Settlement failed: ' + ((settle && (settle.errorReason || settle.error)) || 'unknown'), amount
    ), null, 2));
    return;
  }
  if (onSettled) {
    try { await onSettled(); } catch (err) { console.log('[x402] onSettled failed:', err.message); }
  }
  const sale = {
    ts: new Date().toISOString(),
    service,
    payer,
    transaction: settle.transaction || null,
    network: settle.network || X402_NETWORK,
    amount,
    asset: X402_ASSET,
    ...(produced.meta || {}),
  };
  fs.appendFile(X402_SALES_FILE, JSON.stringify(sale) + '\n', () => {});
  console.log(`[x402] sale: ${service} paid by ${payer} tx ${sale.transaction}`);
  const responseHeader = Buffer.from(JSON.stringify({
    success: true,
    transaction: settle.transaction || null,
    network: settle.network || X402_NETWORK,
    payer,
  })).toString('base64');
  const body = { paid: true, payment: sale, ...produced.body };
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'X-PAYMENT-RESPONSE': responseHeader,
  });
  res.end(JSON.stringify(body, null, 2));
}

async function handleX402(req, res) {
  const query = parseQuery(req.url);
  const rawContract = (query.contract || '').trim();
  if (!ADDR_RE.test(rawContract)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'contract must be a 0x address (40 hex chars)' }));
    return;
  }
  await x402PaidFlow(req, res, X402_VERIFY_AMOUNT, 'verify', async (payer) => {
    // Sim from the payer's wallet: can THIS buyer mint free?
    if (ADDR_RE.test(payer)) query.from = payer;
    const triage = await handleTriage(query);
    if (triage.status !== 200) return triage;
    const deep = await runDeepChecks(rawContract.toLowerCase());
    return { status: 200, body: { ...triage.body, deep }, meta: { contract: rawContract.toLowerCase() } };
  });
}

// ── Research brief ($5, synchronous, extractive) ────────────────────────────
// No LLM key lives on this server, so the brief is evidence-first: a live
// web search plus the top pages fetched and excerpted, each finding naming
// its source URL. Nothing is invented: findings are excerpts, never prose
// the server wrote from nothing.
const RESEARCH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchText(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': RESEARCH_UA }, signal: ctrl.signal });
    if (!res.ok || !res.body) return null;
    // Bound the body: a hostile or giant page must not OOM the free tier.
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    const MAX_BYTES = 2_000_000;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { try { await reader.cancel(); } catch (e) { /* ignore */ } break; }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function stripHtmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(noscript|svg|nav|footer|header)[\s\S]*?<\/(noscript|svg|nav|footer|header)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

// Bing's /ck/a u= parameter is base64 of the destination URL, sometimes
// prefixed with a 2-char version marker ("a1"). Try both forms and keep the
// first that decodes to a valid http(s) URL; otherwise null.
function decodeBingU(raw) {
  let v;
  try { v = decodeURIComponent(raw); } catch (e) { v = raw; }
  for (const cand of [v, v.slice(2)]) {
    try {
      const decoded = Buffer.from(cand, 'base64').toString('utf8');
      if (/^https?:\/\//.test(decoded)) return decoded;
    } catch (e) { /* try next form */ }
  }
  return null;
}

function parseBingResults(html) {
  const out = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  for (const b of blocks) {
    const m = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/);
    if (!m) continue;
    // Bing HTML-escapes ampersands in hrefs (&amp;), so unescape first or
    // the u= parameter below never matches and every result is dropped.
    let url = m[1].replace(/&amp;/g, '&');
    // Bing routes result links through /ck/a?...&u=<base64 of the real URL>
    const u = url.match(/[?&]u=([^&]+)/);
    if (u) {
      const decoded = decodeBingU(u[1]);
      if (decoded) url = decoded;
    }
    if (!/^https?:\/\//.test(url) || /bing\.com\//.test(url)) continue;
    const s = b.match(/<div class="b_caption"><p[^>]*>([\s\S]*?)<\/p>/);
    out.push({
      title: stripHtmlToText(m[2]).slice(0, 200),
      url,
      snippet: s ? stripHtmlToText(s[1]).slice(0, 300) : '',
    });
  }
  if (out.length) return out;
  // Fallback: Bing sometimes serves a different SERP layout. Any /ck/a link
  // with a base64 u= parameter is a result link regardless of its container.
  const seen = new Set();
  const re = /<a[^>]*href="https:\/\/www\.bing\.com\/ck\/a\?[^"]*?&amp;u=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const url = decodeBingU(m[1]);
    if (!url || /bing\.com\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    const title = stripHtmlToText(m[2]).slice(0, 200);
    if (title) out.push({ title, url, snippet: '' });
    if (out.length >= 10) break;
  }
  return out;
}

function parseDdgResults(html) {
  const out = [];
  const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [...html.matchAll(linkRe)];
  const snips = [...html.matchAll(snipRe)];
  links.forEach((m, i) => {
    let url = m[1];
    // DDG wraps external links through //duckduckgo.com/l/?uddg=<encoded>
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch (e) { /* keep as-is */ } }
    if (!/^https?:\/\//.test(url)) return;
    out.push({
      title: stripHtmlToText(m[2]).slice(0, 200),
      url,
      snippet: snips[i] ? stripHtmlToText(snips[i][1]).slice(0, 300) : '',
    });
  });
  return out;
}

// Search providers, in order: Bing HTML (works from this network), then
// DuckDuckGo HTML, then DDG lite. DDG returns empty replies from this VM's
// IPs (2026-11-10) but may work from Render's egress IPs, so it stays as a
// fallback rather than being removed.
async function webSearch(query) {
  const bing = await fetchText('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&count=10', 15000);
  if (bing) {
    const results = parseBingResults(bing);
    if (results.length) return results;
  }
  const html = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), 15000);
  if (html) {
    const results = parseDdgResults(html);
    if (results.length) return results;
  }
  const lite = await fetchText('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query), 15000);
  if (lite) {
    const out = [];
    const re = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    for (const m of lite.matchAll(re)) {
      if (/^https?:\/\//.test(m[1])) out.push({ title: stripHtmlToText(m[2]).slice(0, 200), url: m[1], snippet: '' });
    }
    if (out.length) return out;
  }
  return [];
}

async function runResearchBrief(topic, lang) {
  // One retry: Bing's SERP layout varies per request and any provider can
  // flake once, so a single empty result is retried before giving up.
  let results = await webSearch(topic);
  if (!results.length) results = await webSearch(topic);
  if (!results.length) throw new Error('web search returned no results');
  const top = results.slice(0, 5);
  const pages = await Promise.all(top.map(async (r) => {
    const html = await fetchText(r.url, 10000);
    const text = html ? stripHtmlToText(html).slice(0, 4000) : '';
    return { ...r, textLength: text.length, excerpt: (r.snippet || text.slice(0, 300)).slice(0, 300) };
  }));
  return {
    service: 'research-brief',
    topic,
    lang,
    generated_at: new Date().toISOString(),
    sources_consulted: pages.length,
    findings: pages.map((p) => ({ title: p.title, url: p.url, excerpt: p.excerpt })),
    sources: pages.map((p) => p.url),
    note: 'Extractive brief: every finding is an excerpt from its listed source. Verify claims against the sources before acting.',
  };
}

async function handleResearch(req, res) {
  const query = parseQuery(req.url);
  const topic = (query.topic || '').trim();
  const lang = (query.lang || 'en').trim().toLowerCase();
  if (!topic || topic.length > 200) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'topic is required (max 200 chars), e.g. ?topic=Agent+Mining+AMNT' }));
    return;
  }
  if (!['id', 'en', 'zh'].includes(lang)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'lang must be id, en or zh' }));
    return;
  }
  await x402PaidFlow(req, res, X402_RESEARCH_AMOUNT, 'research-brief', async () => {
    const brief = await runResearchBrief(topic, lang);
    return { status: 200, body: brief, meta: { topic } };
  });
}

// ── Deep research jobs ($25, async) ─────────────────────────────────────────
// The buyer pays, gets a jobId, and polls GET /x402/jobs/:id. A worker on
// Ara's own VM polls GET /x402/jobs, researches each queued job, and POSTs
// the report to /x402/jobs/:id/result with X-JOB-SECRET.
// Storage is an append-only JSONL file; the last line per jobId wins. Render's
// free-tier filesystem is ephemeral, so a restart can lose queued jobs — the
// sale log (x402-sales.jsonl) keeps payer + topic + tx, so a lost job can be
// rebuilt and delivered by hand.
const jobs = new Map();
function loadJobs() {
  try {
    const lines = fs.readFileSync(X402_JOBS_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { const j = JSON.parse(line); if (j && j.jobId) jobs.set(j.jobId, j); } catch (e) { /* skip bad line */ }
    }
  } catch (err) { /* no jobs file yet */ }
}
loadJobs();

function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  jobs.set(job.jobId, job);
  fs.appendFile(X402_JOBS_FILE, JSON.stringify(job) + '\n', () => {});
}

function publicJob(job) {
  const out = { jobId: job.jobId, status: job.status, topic: job.topic, lang: job.lang, createdAt: job.createdAt, updatedAt: job.updatedAt };
  if (job.status === 'done' && job.report) out.report = job.report;
  if (job.status === 'failed' && job.error) out.error = job.error;
  return out;
}

async function handleDeepResearch(req, res) {
  const query = parseQuery(req.url);
  const topic = (query.topic || '').trim();
  const lang = (query.lang || 'en').trim().toLowerCase();
  if (!topic || topic.length > 200) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'topic is required (max 200 chars)' }));
    return;
  }
  if (!['id', 'en', 'zh'].includes(lang)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'lang must be id, en or zh' }));
    return;
  }
  let deepJob = null;
  await x402PaidFlow(req, res, X402_DEEP_AMOUNT, 'research-deep', async (payer) => {
    const job = {
      jobId: 'job-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'),
      // awaiting_payment until settle succeeds: the worker only processes
      // `queued` jobs, so a failed settle can never buy free work.
      status: 'awaiting_payment',
      topic,
      lang,
      payer,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveJob(job);
    deepJob = job;
    return {
      status: 200,
      body: { service: 'research-deep', jobId: job.jobId, status: 'queued', statusUrl: '/x402/jobs/' + job.jobId, eta_minutes: '10-30', topic, lang },
      meta: { topic, jobId: job.jobId },
    };
  }, async () => {
    if (deepJob) { deepJob.status = 'queued'; saveJob(deepJob); }
  });
}

function handleJobStatus(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'job not found' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(publicJob(job), null, 2));
}

function handleJobsList(req, res) {
  const list = [...jobs.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 20)
    .map((j) => ({ jobId: j.jobId, status: j.status, topic: j.topic, lang: j.lang, createdAt: j.createdAt, updatedAt: j.updatedAt }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, jobs: list }, null, 2));
}

async function handleJobResult(req, res, jobId) {
  if (!X402_JOB_SECRET || req.headers['x-job-secret'] !== X402_JOB_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'job not found' }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 200000) req.destroy(); });
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body || '{}'); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }
    if (!['working', 'done', 'failed'].includes(data.status)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'status must be working, done or failed' }));
      return;
    }
    if (data.status === 'done' && (!data.report || typeof data.report !== 'object')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'done requires a report object' }));
      return;
    }
    job.status = data.status;
    if (data.report) job.report = data.report;
    if (data.error) job.error = String(data.error).slice(0, 500);
    saveJob(job);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, job: publicJob(job) }));
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/botwork-webhook') {
    try {
      await handleBotwork(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
    }
    return;
  }

  if (urlPath === '/botwork-tasks' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agent: 'zhi19', tasks: botworkQueue }, null, 2));
    return;
  }

  if (urlPath === '/moltify-webhook') {
    try {
      await handleMoltify(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
    }
    return;
  }

  if (urlPath === '/moltify-tasks' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agent: 'zhi19', tasks: moltifyQueue }, null, 2));
    return;
  }

  if (urlPath === '/x402/verify' && req.method === 'GET') {
    try {
      await handleX402(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
    }
    return;
  }

  if (urlPath === '/x402/research' && req.method === 'GET') {
    try {
      await handleResearch(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
    }
    return;
  }

  if (urlPath === '/x402/research-deep' && req.method === 'GET') {
    try {
      await handleDeepResearch(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
    }
    return;
  }

  if (urlPath === '/x402/jobs' && req.method === 'GET') {
    handleJobsList(req, res);
    return;
  }

  if (urlPath.startsWith('/x402/jobs/') && req.method === 'GET') {
    handleJobStatus(req, res, urlPath.slice('/x402/jobs/'.length).split('/')[0]);
    return;
  }

  if (urlPath.startsWith('/x402/jobs/') && req.method === 'POST' && urlPath.endsWith('/result')) {
    try {
      await handleJobResult(req, res, urlPath.slice('/x402/jobs/'.length).split('/')[0]);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
    }
    return;
  }

  if (urlPath === '/api/triage' && req.method === 'GET') {
    const query = parseQuery(req.url);
    try {
      const { status, body } = await handleTriage(query);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
    }
    return;
  }

  // Serve static files for everything else
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Free-mint triage server running at http://localhost:${PORT}`);
});
