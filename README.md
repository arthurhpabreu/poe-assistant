# PoE Assistant

A native AI chat panel on the **right side of Path of Building Community Fork**, powered by your own Claude Code or Codex CLI. The addon uses the live build and the current PoB installation rather than a frozen copy of game data.

## Start here

**Windows installer:** download `PoE-Assistant-Setup-0.2.0.exe` from [Releases](https://github.com/autis-analytics/poe-assistant/releases), run it, and select your existing `Path of Building.exe`. Node is bundled; install your own Claude Code or Codex CLI separately. The installer creates **PoE Assistant**, **Update PoE Assistant**, **Rollback PoE Assistant** and **Uninstall PoE Assistant** shortcuts. This repository is currently private: downloads/updates require repository access (GitHub CLI authentication for private updates).

The managed installation uses versioned releases under `%LOCALAPPDATA%\PoE Assistant`, with settings, request history and recovery data in a separate `data` directory. Updates verify archive and file SHA256 hashes, serialize installation, wait for the owned backend to stop, run compatibility/startup checks, and preserve the prior release for rollback. Save and close the assistant's PoB window before updating; unrelated PoB windows are preserved. Checksums detect corruption; this initial installer is not code-signed. Uninstall removes the owned addon entry point and shortcuts while preserving builds and recovery data.

For development from source:

1. Install Node.js 22+ and either Claude Code or Codex CLI.
2. In this project, run `npm install`, then `npm run install:addon`.
3. Open the new **PoB Helper** desktop shortcut, or run `powershell -NoProfile -File scripts/launch.ps1`.
4. Maximize the PoB window and open a build. Select your CLI and model in the right panel.
5. Open **Settings**. Use **Sign in** to open your selected CLI's official browser login flow. Complete authentication in your browser. **Check login** refreshes the status.
6. Describe your goals, league and budget, then send a message. **Ctrl+Enter** sends; **F8** collapses or expands the panel.

No separate API key is required for the addon. Usage follows your selected provider's subscription, limits and billing.

The model dropdown remembers a separate choice for each CLI. **Model: CLI default** keeps your CLI's default; Codex choices come from its local model catalog and refresh automatically, while Claude offers the current Sonnet, Opus and Haiku aliases. **Custom model...** accepts another model ID; save it in Settings or send your next message to use it. Model availability follows your CLI/account. Type every request in chat, including analysis and optimization.

An empty reasoning-effort field uses the CLI's default. Settings also accepts an absolute native `.exe` path or a `.js` entry point. The npm-installed CLIs on this machine are detected automatically. To select another PoB installation:

```powershell
npm run install:addon -- --pob "C:\path\to\Path of Building"
```

## Browser sign-in

The **Sign in** button starts `codex login` or `claude auth login --claudeai`. The CLI opens the system browser and owns its OAuth callback and normal credential storage. The user completes authentication directly with the provider. Sign-in runs only when requested by the user; there is no automatic logout, account switch, credential copying or password field in the addon.

The addon does not change HOME, CODEX_HOME or CLI profiles, and does not capture authentication URLs, codes, tokens or account details in its logs. **Check login** keeps only the provider and signed-in boolean. **Cancel** can stop an unfinished sign-in process. Existing CLI authentication continues to work without signing in again.

## Build access and changes

- Reads the complete live build XML, including unsaved changes, all item/skill/tree sets, masteries, clusters, configuration, notes and party settings, plus current calculator outputs.
- Gives the agent tools to inspect tree IDs, allocation and connections, and to search/read current PoB source code and data.
- Compares ordinary passive additions/removals and replacement items with the **real PoB calculator**, without loading a candidate build for a preview. Isolated mastery simulations are rejected because their effect selections need special treatment.
- Reads skill mechanics and current unique items with searchable native catalogs, including eligible current variants and materialized PoB item text. Legacy unique versions are excluded. Reads live Calcs breakdowns, active skill data and conditions.
- Compares up to eight **complete** candidates per tool call in fresh, isolated real PoB processes. The worker copies only manifest-listed code, data, assets and binaries into a session-owned engine, excluding credentials, builds, settings and native runtime config. It never swaps the open build. Reports include baseline/candidate stats, deltas, conditions, warnings, point budgets, connectivity and item/gem recognition.
- Every proposal that changes calculations must match the exact XML hash of a measured candidate, its baseline and engine fingerprint. Untested final edits trigger automatic calculation and another model review. Notes-only proposals are exempt based on resulting XML, including replacement operations. Invalid candidates cannot become applicable proposals.
- Unique validation checks the current database name/base, selected version, modifier shapes, ranges and missing modifiers. Nonstandard corruptions/enchants requiring further validation are rejected conservatively. Being in the database does not establish current-league drop availability or price.
- Produces structured XML proposals that can edit any serializable build section. The operations and values appear in the chat for review before **Apply proposal**.
- Applying changes rebuilds the open build in memory. It does not save over the original file. Review the result and use PoB's Ctrl+S when ready. Durable backups, `recovery.xml` and **Undo** support recovery.
- Rejects stale proposals and undo when the build has changed. Ordinary tab navigation is excluded from the revision check. Apply is confirmed only after initialization, calculation and a committed snapshot; failures restore the previous build.

The chat has separate message cards, readable headings and lists, mouse-wheel scrolling, **Latest**, **Copy reply**, and a **Wider** view. **Clear chat**, beside the send controls, starts a fresh conversation for the current build, clears the draft and discards pending suggestions. It keeps the build, settings and existing Undo recovery. It is available when the assistant is idle. Proposed changes appear as a short review card; **Details** shows paths and values, with previews for very large values. **Copy changes** copies the complete proposal. Type your request in the larger composer; **Ctrl+Enter** sends it.

**Full machine access** is enabled as requested. The selected CLI can read/write local files and run commands beyond this project with your Windows user's permissions. It does not grant administrator rights. **Settings → Agent access → PoB tools only** restores the restricted mode. Local file/command changes happen during the request; PoB Undo covers only changes applied through the PoB bridge. Cancel and timeouts terminate the CLI process tree, including running child commands; completed side effects are not automatically reversed.

Large requests, including complete builds, have **no addon CLI time limit and no analysis-step limit**. Progress shows elapsed time; **Cancel** stops the running request. Tool outputs and working checkpoints stay in the request folder, while recent context is kept bounded and older results can be read on demand. Codex event logs are processed without accumulating their total output in memory. Individual connection checks and PoB commands still have response deadlines; your provider's usage, context and service limits still apply. Keep PoB available for live calculator operations.

PoB builds still use typed tools, validated XML and **Apply changes**/**Undo**. The full-access agent is instructed to use this workflow and preserve official PoB files; this is an instruction, not an OS-enforced filesystem boundary in full-access mode. Claude keeps safe mode and empty MCP configuration while enabling its native tools with `bypassPermissions`. Codex enables local shell tools with `danger-full-access` and `approval_policy="never"`; inherited apps, hooks, plugins, browser/computer control, subagents and MCP integrations stay disabled. Authentication and global CLI settings are untouched. Separate fallback research calls remain restricted to native web search. Native local tools are available only in full-access main chat calls.

The complete build and requested evidence are sent to the selected CLI/provider for analysis. Work files and backups stay under `.pob-helper/`, which Git ignores. Chat histories are separated by open build and kept in backend memory. One backend controls one PoB window at a time; a second window cannot take over an active connection.

## Current data and updates

Every request uses the installed manifest, game versions and source/data fingerprints. Code and data are read directly from the installation. A change during analysis invalidates the result; an installation update requires reopening PoB so the loaded calculator and disk files match.

PoB 2.67.2 does not expose a formal plugin loader. The addon installs an additional `PobHelperLaunch-<session>.lua` entry point beside the official launcher. It loads the current official `Launch.lua` and intercepts `Modules/Main` in memory. **Official PoB sources and manifest hashes are preserved.** The additional launcher survives the updater without causing same-version repair downloads.

Runtime/basic updates explicitly relaunch the ordinary PoB executable without the addon argument. If the panel disappears after an update, close that window and open **PoB Helper** again. The launcher uses the newly installed files. Future incompatible Lua API changes can require an addon update; compatibility with untested versions is not assumed.

To uninstall, run `npm run uninstall:addon` and close the addon window. Only this session's launcher and shortcut are removed. Official PoB files, build data and backups remain available.

## Research and optimization limits

**Only the current and immediately previous league are permitted.** Dated GGG release evidence in `src/released-leagues.json` defines the window (currently `3.29` and `3.28`); both must exist in the installed PoB. The evidence expires on the announced next expansion date, November 13, 2026: the addon then requires a policy update instead of silently treating an old installation as current. Preview trees cannot advance the window. Older trees are blocked in candidate validation and historical tree searches. Community build sources must explicitly identify a supported patch in their title. Previous-league mechanics must be checked against the target calculation, and legacy unique variants are excluded. Sources without an identifiable league cannot be used as build evidence.

The engineering workflow starts from the live XML and local skill/mechanics data, compares competing scaling ideas and unique/rare combinations, then iterates against real calculations and declared offensive/defensive constraints. Existing current/previous-league builds can inform a mechanics hypothesis, with attribution; importing a guide is not a substitute for building and measuring candidates. Models must disclose assumptions, inspiration, conditional uptime and unmodeled effects.

The assistant can research current evidence; it cannot guarantee complete mechanics knowledge or a global optimum. Public searches use Bing RSS/DuckDuckGo and fall back to the selected CLI's native web search when needed. Additional CLI research calls consume provider quota. Only retrieved sources count as verification; snippets are leads.

Forum, wiki and Reddit availability varies. In this environment the official forum and wiki returned readable content; Reddit blocked direct reading. Such blocks are reported rather than treated as verified evidence. Supplying an exact thread URL can help discovery, though it cannot bypass a site block. Community claims must be checked against patch dates and current code.

Numerical comparisons alone do not prove every in-game interaction, rare affix legality, league drop availability or market price. Full-build validation checks PoB connectivity, point budgets, retained node/mastery selections and supported unique modifiers, but cannot certify everything the game permits. Inspect final builds in PoB. Account/trade transactions and game automation are outside the addon.

The standard PoB renderer has limited Unicode support. The sidebar transliterates unsupported characters only for display; original responses and XML remain UTF-8. Small windows show a compact badge until enlarged.

## Development and verification

```powershell
npm test
npm run check
npm run verify:lab
npm run package:windows
node scripts/verify-live.mjs
node scripts/verify-cli.mjs --provider codex
node scripts/verify-cli.mjs --provider claude
node scripts/verify-agent.mjs
node scripts/verify-research.mjs
```

CLI/agent/research checks make real provider or web requests. `verify-live.mjs --mutations` temporarily edits notes, checks stale rejection and restores the initial state. `verify-agent.mjs --mutations` checks the full proposal/apply/undo path and requires a new level-1 build with empty notes. Use a test build.

Tests cover XML edits, source/web boundaries, CLI arguments, agent tool loops, current-version checks, Lua syntax, first-frame transaction rollback, input limits, and browser-login delegation without retaining account details. Native UI and live calculator behavior also require inspection in PoB.

Source map: `addon/PobHelper.lua` (UI, file bridge, calculator, transactions), `src/server.mjs` (session/queue), `src/agent.mjs` and `src/instructions.mjs` (agent), `src/cli.mjs` (providers), `src/auth.mjs` (native browser sign-in), `src/xml.mjs` (build edits), `scripts/install.mjs` (standalone launcher/shortcut). The bridge uses session IDs, request IDs, deadlines, temporary-file replacement and live build revisions, with no exposed HTTP server.

References: [PoB Community Fork](https://github.com/PathOfBuildingCommunity/PathOfBuilding), [Codex CLI authentication](https://developers.openai.com/codex/auth), [Claude Code CLI](https://code.claude.com/docs/en/cli-reference). PoB source code is not redistributed in this project.
