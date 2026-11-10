'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Free-mint triage server
// Stack: Node.js 18+, zero npm deps (built-in http + global fetch)
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const fs   = require('fs');
const path = require('path');

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

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

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
