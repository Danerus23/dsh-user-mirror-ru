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

Fork and upstream are **not** the same package name any more. Upstream moved to the scoped
name `@dsh-plugins/dsh-user-mirror` (published there: 0.6.3); this fork deliberately keeps the
old, unscoped name `dsh-user-mirror`, so it is a drop-in replacement for the *old* package.
If you have the new scoped package installed, remove it first — otherwise you end up with two
copies of the same plugin registering the same routes and tools:

```powershell
dsh plugin --profile web remove @dsh-plugins/dsh-user-mirror
```

The fork is based on the last unscoped release, **0.6.1** (upstream's host half `index.js` is
byte-identical across 0.6.1, 0.6.3 and the unreleased 0.7.0, so both fixes still apply).

## Install

```powershell
dsh plugin --profile web add github:Danerus23/dsh-user-mirror-ru
```

Worth pinning a version: `github:Danerus23/dsh-user-mirror-ru#v0.6.1-ru.1`.

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
dsh plugin --profile web add @dsh-plugins/dsh-user-mirror   # current upstream name
```

Memory records live in the DSH storage domain `dsh_mirror`, not inside the package, so they
survive uninstalling the plugin.

## Repository layout

The repository root *is* the package. `index.js` is the shipped host half, built from
`index.translation.js` by `tools/build-index.mjs`; `client.js` and `cordis.patch.yml` are
translated copies; `upstream/0.6.1/` keeps pristine upstream files for comparison.

Tooling under `tools/`:

* `node tools/verify-structure.mjs` — translation vs upstream skeleton, and the shipped
  `index.js` vs translation + fixes;
* `node tools/test-matcher.mjs` — 22 behavioural tests of the topic matcher;
* `pwsh -File tools/link-deps.ps1` — junctions to the profile's dependencies, needed to run the
  tests from a clone (the profile has to be populated first);
* `pwsh -File tools/check-server.ps1 -Url http://127.0.0.1:3080` — checks a *running* server:
  plugin routes and the language of the category labels (it prints counts only, never the
  memory texts);
* `pwsh -File tools/check-upstream.ps1` — checks whether upstream has released something new
  under either npm name and how much text a rebase would need to translate;
* `pwsh -File tools/apply-overlay.ps1` — fallback install that overlays the translation on top
  of an already installed npm package (with a backup and automatic rollback).

## License

MIT, same as upstream. Copyright (c) 2026 webkubor (original plugin) is preserved;
copyright (c) 2026 Danerus23 (Russian edition and fixes) is added. See [LICENSE](LICENSE).
