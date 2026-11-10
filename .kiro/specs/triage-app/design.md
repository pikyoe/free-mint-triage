# Design — free-mint triage app

## Architecture
Single Node.js process, zero dependencies. `server.js` uses the built-in `http` module
and global `fetch`. It serves `public/index.html` at `/` and implements
`GET /api/triage` in the same file. All external checks run server-side so the browser
never deals with RPC/GoPlus/Sourcify CORS.

```
browser ──GET /────────────────▶ server.js ──▶ public/index.html
browser ──GET /api/triage ─────▶ server.js ──▶ eth_call ×2 nodes (parallel)
                                        ├─▶ GoPlus token + nft security
                                        └─▶ Sourcify v2 contract
```

## API contract
`GET /api/triage?contract=0x...&from=0x...`

Success (200):
```json
{
  "contract": "0x...",
  "from": "0x...",
  "verdict": "clean | ambiguous | red-flag",
  "summary": "one-sentence human summary",
  "checked_at": "2026-11-10T09:00:00.000Z",
  "evidence": {
    "code": { "exists": true },
    "simulation": {
      "node1": { "node": "https://bsc-dataseed.bnbchain.org", "status": "success|revert|unavailable", "selector": "mint(uint256)", "detail": "..." },
      "node2": { "...": "same shape, https://bsc.publicnode.com" }
    },
    "goplus": {
      "token": { "indexed": true, "flags": { "is_honeypot": "0", "...": "..." }, "raw": {} },
      "nft":   { "indexed": false }
    },
    "sourcify": { "match": "exact_match | partial_match | null", "checked": true }
  }
}
```

Error (400): `{ "error": "contract must be a 0x address (40 hex chars)" }`

## Verdict logic (function `computeVerdict(evidence)`)
1. `red-flag` if `!evidence.code.exists`, or any GoPlus flag `is_honeypot == "1"` /
   malicious indicator, or both nodes `revert` while the source is unverified.
   A reverting mint is NOT proof of malice on its own: the free lane may be
   gated (Agent ID / allowlist), sold out, or now paid — a verified source +
   both nodes `revert` is `ambiguous`, not `red-flag`.
2. Else `clean` if both nodes `success`, Sourcify match is `exact_match` or
   `partial_match`, and at least one GoPlus endpoint returned data with no flags.
3. Else `ambiguous`.
4. Node errors (rate limit, overload) are reported as `unavailable`, never as a
   revert. Nodes: blastapi (primary) + bsc-dataseed; publicnode is not used
   (aggressive rate limiting).

## Implementation notes
- `fetchJson(url, options, timeoutMs)` helper: AbortController, 10s default timeout.
- eth_call payload: `{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"from","to","value":"0x0","gas":"0xf4240","data":"<calldata>"},"latest"]}`.
  Success = response has `result` (a hex string) and no `error`. Revert = `error` field.
- Calldata builders: `mint(uint256)` = `0xa0712d68` + uint256(1) as 32-byte hex;
  `freeMint()` = 0x5b70ea9f (verified via ethers keccak, 2026-11-10) — hardcode it, no keccak needed at runtime;
  `mintFree()` = 0x8ab53447 (verified the same way, 2026-11-10 — Star Agent uses
  this selector, and the generic sim missed it until it was added);
  `mint(uint256,address)` = `0x94bf804d` + uint256(1) + zero address padded to 32 bytes.
- GoPlus endpoints: `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=<addr>`
  and `.../nft_security/56?contract_addresses=<addr>`. A 200 with empty result object
  for the address means not indexed.
- Sourcify: `https://sourcify.dev/server/v2/contract/56/<addr>`; `match` field at top
  level (`stdJson` match object has `match` too — read the top-level `match`).
- Port: `process.env.PORT || 3000`. Log a one-line startup message.
