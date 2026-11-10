# Tasks — free-mint triage app

- [x] 1. Project skeleton
  - [x] 1.1 Create `package.json` with `start` script (`node server.js`), no dependencies
  - [x] 1.2 Create `server.js` with static serving of `public/` and a stub `/api/triage`
        that returns 400 for a bad address

- [x] 2. Triage endpoint core
  - [x] 2.1 Implement address validation and the `from` default (zero address)
  - [x] 2.2 Implement `fetchJson` helper with 10s AbortController timeout
  - [x] 2.3 Implement the `eth_call` sim: try `mint(uint256)`, `freeMint()`,
        `mintFree()`, `mint(uint256,address)` in order on one node; return first
        success or the last revert/unavailable
  - [x] 2.4 Run the sim against both BSC nodes in parallel; add `eth_getCode` check
  - [x] 2.5 Implement GoPlus token + NFT security fetches (one address per request)
  - [x] 2.6 Implement the Sourcify match fetch
  - [x] 2.7 Implement `computeVerdict` per the design doc and the response shape

- [x] 3. Frontend
  - [x] 3.1 Create `public/index.html`: contract + optional wallet inputs, Check
        button, verdict display, evidence sections, honest disclaimers
  - [x] 3.2 Frontend calls `/api/triage`, renders verdict/summary/evidence, shows
        loading and error states

- [x] 4. Verify
  - [x] 4.1 `node server.js` starts and serves `/`
  - [x] 4.2 `GET /api/triage` returns a verdict with evidence from all three
        checks. NOTE: the DRIFTWIRE example in the original task now returns
        `ambiguous` (its free mint reverts — the wallet already holds one, and
        the lane is 1-per-wallet). Positive sim-success controls verified live:
        VISION → `clean`, Star Agent → `ambiguous` (sim success, GoPlus not
        indexed), Roguefall → `ambiguous` (sim success, GoPlus not indexed).
  - [x] 4.3 A bad address returns HTTP 400; a random EOA address returns red-flag
        (no code)

- [x] 5. Docs
  - [x] 5.1 README.md: what it is, how to run, honest limits, Kiro usage note
  - [x] 5.2 .gitignore that ignores node_modules but NOT .kiro
  - [x] 5.3 LICENSE (MIT) + KIRO-USAGE.md (honest Kiro-vs-hand split)

- [x] 6. Fixes found by live testing (session 2, by hand — see KIRO-USAGE.md)
  - [x] 6.1 Nodes swapped to blastapi + bsc-dataseed (publicnode rate-limits)
  - [x] 6.2 Rate-limit RPC errors reported as `unavailable`, not `revert`
  - [x] 6.3 Verified-source revert → `ambiguous`, not `red-flag`
  - [x] 6.4 Sim gas cap raised 300k → 1,000,000
  - [x] 6.5 Added `mintFree()` selector (0x8ab53447)
