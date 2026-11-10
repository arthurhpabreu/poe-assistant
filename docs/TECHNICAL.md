# Engineering and installation

## Runtime

`addon/PobHelper.lua` attaches to `Modules/Main` in memory. `PoEAssistant.lua`,
an untracked root entry point, loads the current official `Launch.lua`.
`scripts/integrate-shortcuts.ps1` updates standard existing PoB shortcuts while
preserving their executable target, name and icon. Arbitrary custom Lua/build
arguments and other PoB installations are left alone. Uninstall restores the
original arguments only when the shortcut still matches our installed version.

No official PoB sources, binaries or manifest hashes are changed. Normal PoB
restarts retain the entry point. A separate basic update runtime is redirected
through `PoEAssistantUpdate.lua`, which delegates operations to the current
official `UpdateApply.lua` and restores the addon argument only for the exact
PoB executable restart. Future incompatible runtime APIs may require an addon
update. Direct double-clicking the executable bypasses shortcut integration.

The managed entry loads `PoEAssistant/Bootstrap.lua` using paths relative to
the native script directory. It does not rewrite session configuration from
Lua. This avoids ANSI/UTF-8 path mismatches in Lua's Windows CRT. The Node
launcher resolves absolute UTF-8 paths and writes updated metadata atomically.
Windows shortcuts use Unicode `IShellLinkW`/`IPersistFile` interfaces rather
than `WScript.Shell`; PowerShell metadata reads explicitly specify UTF-8.

The Windows installer stores releases and persistent data under
`<PoB>/PoEAssistant`. It validates package/file SHA256 hashes, serializes setup
per PoB installation, waits for the old backend to stop, health-checks the new
release, then integrates shortcuts. Failed activation restores the prior
release. Old addon links are backed up before removal. Builds and native PoB
settings are never copied or overwritten. The installer is currently unsigned.

Before accepting setup, `verify-native.ps1` starts an installer-owned PoB through
an integrated shortcut. A per-process nonce selects isolated settings/build
directories and a separate bridge. A receipt is accepted only after controls
initialize and a frame draws, with matching nonce, process ID, release and
installation path. The native panel must cold-start its isolated bundled Node
backend and read its response over the file bridge. Node health alone is insufficient. Failed native activation
rejects setup and restores the previous release. The probe closes only its own
process; it does not open/save user builds or launch a provider.

Normal native startup calls bundled Node with `src/launch-backend.mjs` directly,
without a shell or PowerShell execution-policy dependency. A Unicode
`CreateProcessW` call starts it hidden, with no elevation retry. Calculator
workers likewise use direct process creation and relative Lua paths. The launcher handles
owned shutdown markers, healthy backends, log redirection and startup errors.
No global execution policy or provider environment is changed. Failures before
attachment produce a dismissible PoB notice and `startup-error.log`; native
initialization/frame failures write `startup.json`. Small windows display an
explicit PoE Assistant badge with maximize instructions.

Settings and recovery data from recognized earlier managed installations are
migrated automatically. Old installation directories remain available as
backups; they are not recursively deleted. Moving PoB requires running setup
again to reconcile Windows shortcuts. Internal payload paths are resolved from
the current installation. Disposable calculator caches use a short path under
`%LOCALAPPDATA%/PoEAssistantCache` to avoid native Windows file-I/O limits.

## Build engineering

The backend reads complete live XML, including unsaved edits, all item/skill/tree
sets, configuration, notes and party settings. Typed tools inspect the installed
skill/unique catalogs, passive graph, source code and Calcs breakdowns.

Complete candidate comparisons run in fresh real PoB processes. Engine copies
include only manifest-listed runtime, code, data and assets, excluding personal
settings, builds and credentials. Validation checks retained nodes/masteries,
connectivity, point budgets, gem/item recognition, current unique variants and
modifier ranges. Database inclusion does not establish drop availability,
crafting legality or market price.

Successful exact measurements are reused within an analysis (up to 32). Keys
include XML hash, installed fingerprint, verified clone digest and calculator
code. Constraints/objectives are ranked anew. Changed builds/data miss cache;
integrity checks are retained. First calculations and model reasoning still
take time. No global optimum is claimed.

Every calculation-changing proposal must match measured XML and the active
engine/baseline. Apply writes a backup, loads the build in memory, completes the
first calculation frame, saves a committed snapshot and writes an immutable
receipt. Errors trigger rollback. Duplicate clicks, stale proposals and Undo
after manual edits are rejected. Backend restarts reconcile the exact receipt;
later snapshots cannot substitute for confirmation. Ctrl+S remains the user's
choice.

## Privacy and provider access

The selected CLI/provider receives the requested build and evidence. The addon
uses existing CLI authentication or its official browser login. It does not
capture tokens, change HOME/CODEX_HOME, copy provider credential stores, switch
accounts or log the user out. Provider subscription/billing rules still apply.

Full machine access allows the selected CLI to run commands with the current
Windows user's permissions. Settings can restrict it to PoB tools. Undo covers
PoB bridge applications, not arbitrary completed filesystem commands. Cancel
terminates active CLI process trees; completed external effects remain.

One backend owns one PoB window at a time. The file bridge uses session/window
IDs, deadlines, revision checks and durable request/commit records. There is no
public HTTP service. Conversations, backups and diagnostic files stay in the
local installation's `data` directory.

## Research policy

Only the current and immediately previous released league are accepted. Dated
official release evidence in `src/released-leagues.json` defines the window and
an expiry date. Preview trees do not advance it. Expired evidence requires a
policy update; stale data cannot silently become current. Community sources
must identify a supported patch, and mechanics must be checked against the
target calculator. Legacy unique variants are blocked.

## Development

```powershell
npm ci
npm test
npm run check
npm run package:windows
```

Real provider/native checks are available in `scripts/verify-*.mjs`. Use an
isolated PoB copy and disposable build; mutation checks can change that build.
`scripts/verify-installer.mjs --pob <isolated-directory>` checks deployment,
reinstall, settings preservation, failed-activation rollback and tampering.
It also runs the actual packaged EXE, including a repacked broken native addon,
and checks persistent diagnostics and the invocation-bound success receipt.
`tests/setup.test.mjs` compiles the installer with disposable payloads to test
partial errors without newlines, inherited pipes retained by descendants,
missing/mismatched receipts, and separate activation/rollback failures.

The EXE drains redirected output incrementally and waits at most one second
for remaining pipe data after PowerShell exits. `setup-entry.ps1` records the
primary ErrorRecord (phase, position, exception and script stack) outside the
extraction directory, before rollback can overwrite runtime evidence. Cleanup
errors are recorded separately. Setup success requires exit zero and a fresh
receipt matching this invocation, version, target, release and native probe.
For unattended installs, `--silent --diagnostics <directory>` retains a unique
diagnostic subfolder without showing dialogs. No automatic log upload occurs.

`npm run benchmark:lab -- --label cached` and a second run with
`--label uncached --no-cache` reproduce a synthetic Arc comparison without
touching saved/open builds. Its attribute amulet is a test fixture, not a
recommended game item.

Source map: `src/server.mjs` (queue/recovery), `src/agent.mjs` (tool loop),
`src/build-lab.mjs` and `addon/BuildLab.lua` (measurements), `src/xml.mjs`
(validated edits), `src/league-policy.mjs` (league window), `scripts/Installer.cs`
and `scripts/deploy.ps1` (setup), `scripts/install.mjs` (bootstrap generation).
