# Structure steering — Kiroween 2026 Frankenstein entry

```
.
├── .kiro/
│   ├── steering/          # product.md, tech.md, structure.md (this file)
│   └── specs/
│       └── triage-app/    # requirements.md, design.md, tasks.md
├── public/
│   └── index.html         # the whole frontend: form + verdict + evidence
├── server.js              # http server + /api/triage
├── package.json           # scripts only (start: node server.js), no deps
├── README.md
├── KIRO-USAGE.md          # honest record: what Kiro generated vs by hand
├── LICENSE                # MIT
└── .gitignore             # node_modules etc. — NEVER ignore .kiro
```

Rules:
- Keep it to these files. No framework, no build step, no extra folders.
- `server.js` is the only backend file; keep the triage logic in it, readable top to bottom.
- The frontend must work with zero configuration: open the page, paste an address, read the verdict.
