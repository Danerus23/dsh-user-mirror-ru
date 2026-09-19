# dsh-user-mirror — Russian edition

**Let the model know you.** A fork of the DSH plugin
[`dsh-user-mirror`](https://www.npmjs.com/package/dsh-user-mirror)
(upstream sources: [webkubor/dsh-mirror](https://github.com/webkubor/dsh-mirror), version **0.6.1**).

The plugin lets the model record *how a person thinks* — principles, red lines, workflow
habits, taste — and feeds those records back into the system prompt of later sessions.

This fork translates all user-visible text into Russian and adds **two fixes to the plugin
itself**. One of them is language-specific; the other is not:

| Change | Who it matters to |
|---|---|
| Full Russian localization (memory tab, help panel, tool descriptions, error texts, the memory block in the system prompt) | Russian-speaking users |
| **Fix 1 — awaited persistence**: upstream calls `table.put` / `table.delete` without `await` and then reads `table.size`, so both counters lied (`0 records` right after the first record), capacity eviction never fired for the record just added, and writes could be lost when the process exited right after the call | everyone |
| **Fix 2 — topic matcher knows Cyrillic**: upstream extracted entities with `/[a-z0-9]+/g` and compared Chinese bigrams, so for Russian records *no* channel worked except exact matching — near-duplicate memories piled up to the capacity limit | Russian-speaking users |

Fix 1 is a plain upstream bug and is worth reporting upstream by anyone who uses the plugin.

* Russian documentation (the main one): [README.md](README.md)
* Instructions for an AI agent — install, verify, roll back: [AGENTS.md](AGENTS.md)

---

## Requirements

* DSH ≥ `0.1.1-rc.2` (verified on `0.1.5-rc.2`), profile **`web` only** — the plugin needs the
  `storageDomain` and `webServer` services and fails the boot on a headless profile.
* `git` and `pnpm` — `dsh plugin` is a thin forwarder to `pnpm` run in the profile directory.

Fork and upstream are the **same package name** (`dsh-user-mirror`), so the fork replaces the
npm version rather than living next to it. Never install both: they register the same routes
and the same tools.

## Install

```powershell
dsh plugin --profile web add github:Danerus23/dsh-user-mirror-ru
```

Then restart the `web` profile (the plugin is read at boot) and hard-refresh the browser page
(`Ctrl+Shift+R`).

Verify: the **Память / Memory** tab must show Russian labels. If it still shows Chinese labels,
you are looking at a cached client bundle — hard-refresh, and restart the profile if that does
not help. From a clone you can also run:

```powershell
pwsh -File .\tools\check-server.ps1 -Url http://127.0.0.1:3080
```

## Uninstall / back to upstream

```powershell
dsh plugin --profile web remove dsh-user-mirror
dsh plugin --profile web add dsh-user-mirror      # back to the npm version
```

Memory records live in the DSH storage domain `dsh_mirror`, not inside the package, so they
survive uninstalling the plugin.

## Repository layout

The repository root *is* the package. `index.js` is the shipped host half, built from
`index.translation.js` by `tools/build-index.mjs`; `client.js` and `cordis.patch.yml` are
translated copies; `upstream/0.6.1/` keeps pristine upstream files for comparison. Everything
under `tools/` is development and verification tooling (`node tools/verify-structure.mjs`,
`node tools/test-matcher.mjs`).

## License

MIT, same as upstream. Copyright (c) 2026 webkubor (original plugin) is preserved;
copyright (c) 2026 Danerus23 (Russian edition and fixes) is added. See [LICENSE](LICENSE).
