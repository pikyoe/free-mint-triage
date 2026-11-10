'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Free-mint triage server
// Stack: Node.js 18+, zero npm deps (built-in http + global fetch)
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const fs   = require('fs');
const path = require('path');

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

// ─── x402 paid deep verification ────────────────────────────────────────────
// GET /x402/verify?contract=0x...&from=0x...
// Price: 0.50 USDC on Base (500000 raw, 6 decimals), payTo = TaskMarket wallet.
// Flow: no X-PAYMENT header -> 402 with accepts; paid -> facilitator verify
// (CDP keys from env CDP_API_KEY_ID / CDP_API_KEY_SECRET) -> deep triage ->
// facilitator settle -> 200 report + X-PAYMENT-RESPONSE header.
// The report is the DEEP version: the free /api/triage evidence plus a
// PancakeSwap pair/liquidity check and a Sourcify source scan for
// owner-control functions. The free endpoint stays free; this one is the
// paid, deeper, per-request product.
// Orchestration is manual on purpose: @x402/core's x402HTTPResourceServer
// demands a registered scheme implementation for exact/base and its
// initialize() needs facilitator auth even for the 402 path, so we call the
// HTTPFacilitatorClient directly and build the 402 body ourselves.
const X402_PAY_TO   = '0xf437F9fe8851Da07197ebd7C1bEa6504d45A7Ceb';
const X402_ASSET    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bd029029'; // USDC on Base
const X402_AMOUNT   = '500000'; // 0.50 USDC, 6 decimals
const X402_NETWORK  = 'eip155:8453';
const X402_TIMEOUT  = 300;
const X402_SALES_FILE = path.join(__dirname, 'x402-sales.jsonl');

function x402Requirements() {
  return {
    scheme: 'exact',
    network: X402_NETWORK,
    asset: X402_ASSET,
    amount: X402_AMOUNT,
    payTo: X402_PAY_TO,
    maxTimeoutSeconds: X402_TIMEOUT,
    extra: { name: 'USDC', version: '2' },
  };
}

function x402PaymentRequiredBody(error) {
  return {
    x402Version: 2,
    error: error || 'Payment Required',
    accepts: [x402Requirements()],
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

async function handleX402(req, res) {
  const query = parseQuery(req.url);
  const rawContract = (query.contract || '').trim();
  if (!ADDR_RE.test(rawContract)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'contract must be a 0x address (40 hex chars)' }));
    return;
  }
  const paymentHeader = req.headers['x-payment'];
  if (!paymentHeader) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x402PaymentRequiredBody(), null, 2));
    return;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
  } catch (err) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x402PaymentRequiredBody('Invalid X-PAYMENT header'), null, 2));
    return;
  }
  // Shape-check before calling the facilitator: a malformed payload is a
  // 402, not a facilitator error.
  if (!payload || !payload.payload || !payload.payload.authorization ||
      !payload.payload.authorization.from || !payload.payload.signature) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x402PaymentRequiredBody('Invalid payment payload'), null, 2));
    return;
  }
  if (!x402FacilitatorClient) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'payment verification unavailable — facilitator not configured (CDP keys missing)' }));
    return;
  }
  const requirements = x402Requirements();
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
      (verify && (verify.invalidReason || verify.invalidMessage)) || 'Payment invalid'
    ), null, 2));
    return;
  }
  // Sim from the payer's wallet: can THIS buyer mint free?
  const payer = (verify.payer ||
    (payload.payload && payload.payload.authorization && payload.payload.authorization.from) || '').toLowerCase();
  if (ADDR_RE.test(payer)) query.from = payer;
  let triage;
  try {
    triage = await handleTriage(query);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
    return;
  }
  if (triage.status !== 200) {
    // Invalid input / triage failure: do NOT settle, buyer is not charged.
    res.writeHead(triage.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(triage.body));
    return;
  }
  const deep = await runDeepChecks(rawContract.toLowerCase());
  let settle;
  try {
    settle = await x402FacilitatorClient.settle(payload, requirements);
  } catch (err) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x402PaymentRequiredBody('Settlement failed: ' + err.message), null, 2));
    return;
  }
  if (!settle || !settle.success) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(x402PaymentRequiredBody(
      'Settlement failed: ' + ((settle && (settle.errorReason || settle.error)) || 'unknown')
    ), null, 2));
    return;
  }
  const sale = {
    ts: new Date().toISOString(),
    payer,
    transaction: settle.transaction || null,
    network: settle.network || X402_NETWORK,
    contract: rawContract.toLowerCase(),
    amount: X402_AMOUNT,
    asset: X402_ASSET,
  };
  fs.appendFile(X402_SALES_FILE, JSON.stringify(sale) + '\n', () => {});
  console.log(`[x402] sale: ${sale.contract} paid by ${payer} tx ${sale.transaction}`);
  const responseHeader = Buffer.from(JSON.stringify({
    success: true,
    transaction: settle.transaction || null,
    network: settle.network || X402_NETWORK,
    payer,
  })).toString('base64');
  const body = {
    paid: true,
    payment: sale,
    ...triage.body,
    deep,
  };
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'X-PAYMENT-RESPONSE': responseHeader,
  });
  res.end(JSON.stringify(body, null, 2));
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

  if (urlPath === '/x402/verify' && req.method === 'GET') {
    try {
      await handleX402(req, res);
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
