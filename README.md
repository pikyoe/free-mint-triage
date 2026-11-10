# Free-Mint Triage

A read-only web app that runs three automated checks on a BNB Chain NFT contract and
shows a plain risk verdict. Paste a contract address, hit **Check contract**, read the
evidence. No wallet needed, no signing, no transactions — ever.

## What it checks

| Check | What it does |
|---|---|
| **On-chain simulation** | Sends an `eth_call` (no gas spent) with common free-mint selectors (`mint(uint256)`, `freeMint()`, `mintFree()`, `mint(uint256,address)`) against two independent BSC nodes. Reports success, revert, or unavailable per node. |
| **GoPlus security scan** | Queries the GoPlus Labs API for token and NFT security data: honeypot detection, airdrop-scam flag, and other risk fields. |
| **Sourcify verification** | Checks whether the contract source is verified on Sourcify (exact match, partial match, or unverified). |

### Verdict rules

- **Red flag** — any sim reverts on both nodes AND source is unverified, OR GoPlus reports
  honeypot / airdrop-scam, OR no contract code exists at the address.
- **Clean** — mint sim succeeds on both nodes AND source is verified (exact or partial) AND
  GoPlus is indexed with no red flags.
- **Ambiguous** — everything else (e.g. sim passes but source unverified, or GoPlus has no data).

## How to run

Requires Node.js 18+. No `npm install` needed — zero external dependencies.

```bash
node server.js
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

To use a different port:

```bash
PORT=8080 node server.js
```

## Honest limits

- Results are a snapshot at the moment you check. On-chain state changes.
- GoPlus coverage varies. "Not indexed" is not the same as clean.
- The simulation uses the zero address by default. Some contracts gate their free-mint
  behind an Agent ID or allowlist — if the sim reverts, paste your own wallet address in
  the optional field and re-check.
- Sourcify covers many contracts but not all; absence of verification is not proof of malice.
- **A "clean" verdict does not mean the contract is safe.** This is a first-pass triage,
  not a substitute for reading the contract or the project docs.
- Nothing here is investment advice.

## Project structure

```
├── public/index.html   frontend — form, verdict, evidence (vanilla HTML/CSS/JS)
├── server.js           http server + /api/triage logic (Node.js, zero deps)
├── package.json        scripts only (npm start)
└── .kiro/              Kiro steering and spec files
```

## Built with Kiro

This project was built with [Kiro](https://kiro.dev), an AI-powered development environment.

The steering files in `.kiro/steering/` defined the product, tech stack, and file structure
constraints. The spec in `.kiro/specs/triage-app/` drove the implementation. See
`KIRO-USAGE.md` for an honest breakdown of what Kiro generated versus what was written
by hand.

## License

MIT — see [LICENSE](LICENSE).
