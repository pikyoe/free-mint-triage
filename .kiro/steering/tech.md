# Tech steering — Kiroween 2026 Frankenstein entry

## Stack
- Node.js 18+ only. Zero external dependencies if possible: built-in `http` server and
  global `fetch`. This keeps `npm install` out of the demo path and the deploy trivial.
- Frontend: a single static `public/index.html` (vanilla HTML/CSS/JS, no framework,
  no build step). It calls one JSON API on the same origin.
- Backend: a single `server.js` exposing `GET /api/triage?contract=<0x...>&from=<0x...>`
  plus static file serving. No database, no state.

## External services (all read-only, all server-side so the browser never hits CORS)
1. BSC RPC, 2 independent public nodes (primary: https://bsc-dataseed.bnbchain.org,
   secondary: https://bsc.publicnode.com). `eth_call` with `from` = the user-supplied
   wallet address, `to` = contract, `value` = 0x0, `gas` = 0x493e0 (300,000).
   Function selectors tried, in order, first success wins:
   - `mint(uint256)` 0xa0712d68, calldata = selector + uint256(1)
   - `freeMint()` — selector computed from keccak at runtime, calldata = selector only
   - `mint(uint256,address)` 0x94bf804d, calldata = selector + uint256(1) + zero address
   A node result counts only if the call returns data (not a revert). Report per-node.
2. GoPlus: `GET https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=<addr>`
   and `GET https://api.gopluslabs.io/api/v1/nft_security/56?contract_addresses=<addr>`,
   one address per request. Absent data = "not indexed", NOT clean.
3. Sourcify: `GET https://sourcify.dev/server/v2/contract/56/<addr>` — read the `match`
   field (`exact_match` / `partial_match` / null).

## Verdict rules (deterministic, stated in the UI)
- `red-flag`: any sim reverts on BOTH nodes, OR GoPlus reports is_honeypot / malicious
  flags, OR the contract has no code (eth_getCode returns 0x).
- `clean`: at least one sim succeeds on BOTH nodes AND Sourcify match is exact/partial
  AND GoPlus returns data with no flags.
- `ambiguous`: everything else (e.g. sims pass but source unverified, or GoPlus no data).

## Reliability rules
- Every external call has a 10s timeout. A timeout/transport error is reported as
  "unavailable", never treated as a pass or a fail.
- Never trust a single node: sims must be attempted on both nodes and both results shown.
- Input validation: contract must match ^0x[0-9a-fA-F]{40}$; `from` defaults to the
  zero address if omitted or invalid.
