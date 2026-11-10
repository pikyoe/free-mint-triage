# Requirements — free-mint triage app

## Introduction
A minimal web app: paste a BNB Chain contract address, get a triage verdict from three
independent read-only checks (on-chain simulation on 2 RPC nodes, GoPlus security scan,
Sourcify verification). No wallet, no signing, no transactions.

## Requirements

### 1. Triage endpoint
- **R1.1** `GET /api/triage?contract=<address>&from=<address>` returns JSON.
- **R1.2** The endpoint validates the contract address format (`^0x[0-9a-fA-F]{40}$`)
  and returns HTTP 400 with an error message otherwise.
- **R1.3** `from` is optional; when absent or invalid it defaults to the zero address
  `0x0000000000000000000000000000000000000000`.
- **R1.4** The response contains: the contract address, a `verdict` of `clean`,
  `ambiguous`, or `red-flag`, a short human-readable `summary`, and an `evidence`
  object with the raw per-check results (per-node sim results, GoPlus payloads,
  Sourcify match) plus a `checked_at` timestamp.

### 2. On-chain simulation
- **R2.1** The server attempts `eth_call` mints against TWO public BSC RPC nodes.
- **R2.2** It tries `mint(uint256)`, `freeMint()`, `mintFree()`, then
  `mint(uint256,address)` with value 0; the first selector that returns data
  (no revert) on a node is that node's sim result, recorded with the selector name.
- **R2.3** Each node call has a 10s timeout; a timeout or transport error is reported
  as `status: "unavailable"` with the error, never as a pass or fail.
- **R2.4** The server also reads `eth_getCode` for the contract; `0x` (no code) is a
  red-flag condition.

### 3. GoPlus security scan
- **R3.1** The server queries the GoPlus token-security and NFT-security endpoints for
  chain 56, one address per request.
- **R3.2** Absent data is reported as `indexed: false` ("not indexed"), never as clean.
- **R3.3** The raw flag fields that matter (honeypot / malicious / owner-controls where
  present) are surfaced in the evidence.

### 4. Sourcify verification check
- **R4.1** The server queries `sourcify.dev/server/v2/contract/56/<address>`.
- **R4.2** The `match` field (`exact_match`, `partial_match`, or null) is surfaced.

### 5. Verdict
- **R5.1** `red-flag` when: no code at the address, OR GoPlus reports honeypot/malicious flags, OR all sims revert on both nodes AND the source is unverified. A failed generic sim is NOT proof of closure or malice: a verified source whose mint reverts is `ambiguous` (free lane may be gated, sold out, or now paid — needs a site-specific check).
- **R5.2** `clean` when: a sim succeeds on BOTH nodes AND Sourcify match is
  exact/partial AND GoPlus returned data with no flags.
- **R5.3** `ambiguous` in all other cases.
- **R5.4** The verdict is always shown with the sentence: "This is a first-pass triage,
  not a safety guarantee."

### 6. Frontend
- **R6.1** `public/index.html` has two inputs (contract address required, wallet address
  optional), a Check button, and a results area.
- **R6.2** Results show the verdict prominently, the summary, and the evidence grouped
  by check (simulation / GoPlus / Sourcify) in readable form.
- **R6.3** The page states plainly: read-only, no wallet connection, no signing, no
  transactions, no guarantees.
- **R6.4** The page works with no build step and no configuration.

### 7. Running
- **R7.1** `node server.js` starts the app on port 3000 (or $PORT) and serves the
  frontend at `/`.
- **R7.2** The project has zero npm dependencies.
