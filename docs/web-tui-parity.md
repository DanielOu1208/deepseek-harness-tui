# DeepSeek Harness Web–TUI Capability Parity

This is the living capability roadmap for the standalone DeepSeek Harness TUI. It compares user outcomes, not screen layouts.

> Baseline: official DeepSeek Harness Web and TUI packages `0.1.0-rc.6`. Last verified: 2026-08-14.

## Product principle

Aim for capability parity while staying strictly terminal-native. The TUI should expose the same important work, control, and inspection paths where a terminal can support them well. It should not copy the Web app's browser layout, visual theme, drag-and-drop behavior, or image lightbox.

The official Harness runtime remains the source of truth. New TUI features should use its public services and event contracts instead of importing React components or Web-only client state.

## Status legend

| Status | Meaning |
|---|---|
| Supported | The named workflow can be completed safely in the TUI; Web-only visual polish does not change the result. |
| Partial | At least one named part of the workflow is usable, but another named user action or required detail is absent. |
| Missing | No practical TUI path exists yet. |
| Intentionally different | The terminal uses, or should use, a different interaction suited to text input. |
| Deferred | Valuable, but not in the near-term roadmap. |

## Capability matrix

| Area | TUI status | Current terminal path | Remaining parity target |
|---|---|---|---|
| Core conversation and streaming | Supported | Composer, streaming reasoning and answers, stop, retry/error presentation | Keep aligned with official session events. |
| Tool calls, results, and diffs | Supported | Terminal-native cards, bounded output, syntax-aware diffs, approval dialogs | Add a drill-down inspector for full call/result metadata. |
| Questions and approvals | Supported | Single- and multi-select dialogs, custom answers, required-interaction priority | Keep aligned with official request contracts. |
| Plan, goal, permissions, model, reasoning | Supported | Slash commands, F2 settings, Shift+Tab, Shift+Up/Down | Surface richer provider/model capability details where useful. |
| Context and token visibility | Partial | Footer shows context pressure, capacity, and request token counts | Add session totals, timing, cache use, and clearer per-turn breakdowns. |
| Session discovery and resume | Supported | `/sessions` or bare `/resume` opens title-aware fuzzy search across title, full ID, and working directory | Add session actions without turning the navigator into a browser clone. |
| Session actions | Missing | Existing forks can be discovered and their lineage is shown, but the TUI cannot create a fork, rename, or archive | Add TUI-native create-fork, rename, and archive actions with confirmation. |
| Workspace grouping | Missing | Working directory is display/search metadata only; sessions are not grouped | Add optional grouping/filtering by working directory. |
| Queued work | Partial | `/queue`, `/steer`, Busy Enter mode, durable pending-work guard during session changes | Add a queue viewer with reorder/remove where runtime contracts allow it. |
| Per-session composer drafts | Missing | One in-process draft survives dialogs, but it is neither persisted nor associated with a session | Persist one draft per session and restore it on navigation. |
| Produced files and deliverables | Missing | Tool transcript may mention paths | Add a searchable file/deliverable panel with safe open/copy actions. |
| Tool trajectory and inspection | Partial | Debug transcript exposes bounded details | Add a focused step/tool inspector with timing and error context. |
| Jobs, workflows, and subagents | Partial | Official runtime events appear in the transcript; subagent sessions are hidden from ordinary resume | Add dedicated status and navigation views for active/background work. |
| Image input and output | Missing | No first-class image flow | Use terminal-native file selection and supported inline-image protocols, with textual fallback. |
| Providers and credentials | Partial | Launcher auth commands plus model selection | Add safe provider/credential status and management without displaying secrets. |
| Presets, plugins, and runtime settings | Partial | Core and registered settings namespaces are browsable; official commands remain available | Add discoverable preset/plugin summaries and safe configuration paths. |
| Export | Missing | Persisted session remains authoritative, but there is no export action | Add explicit Markdown and JSON export. |
| Feedback | Partial | A profile-provided `/feedback` command may be available, but there is no dedicated discoverable flow | Add a clear terminal-native feedback flow while preserving the official command. |
| Session statistics | Missing | Context and current-request usage only | Add totals and timing from official stats/projection contracts. |
| Browser layout, split panes, theme | Intentionally different | Scrollable transcript, inline dialogs, compact status footer | Preserve terminal navigation and readable narrow-width behavior. |
| Drag-and-drop and image lightbox | Intentionally different | File completion and text paths | Use file pickers, terminal image protocols, and external-open actions. |

The session navigator intentionally does not search full transcript text. It searches title, full session ID, and working directory so results remain fast and predictable without maintaining a second content index.

## Evidence map

Use these paths to reproduce the matrix rather than treating status labels as assertions:

- Core conversation, tools, questions, approvals, and transcript behavior: [`tests/projection.test.ts`](../tests/projection.test.ts) and [`tests/ui.test.ts`](../tests/ui.test.ts).
- Plan/reasoning shortcuts, context pressure, capacity, and request usage: [`tests/shortcuts.test.ts`](../tests/shortcuts.test.ts) and the footer cases in [`tests/ui.test.ts`](../tests/ui.test.ts).
- Session discovery, caching, filtering, switching, and failure safety: [`tests/sessions.test.ts`](../tests/sessions.test.ts), session picker cases in [`tests/interaction.test.ts`](../tests/interaction.test.ts), and the terminal smoke below.
- Models, permissions, queues, settings, goals, and commands: [`tests/interaction.test.ts`](../tests/interaction.test.ts), [`tests/commands.test.ts`](../tests/commands.test.ts), and the command paths documented in the [README](../README.md#run).
- Partial and Missing rows are comparison findings: verify the current TUI paths above against the installed official `@deepseek-ai/dsh-web-app/cordis.patch.yml` roster and relevant installed `@deepseek-ai/dsh-client-ui-*/README.md` contracts. Record the exact package version and observed gap when changing a status.

The current matrix is based on automated tests plus an isolated terminal smoke. It is a contract/capability comparison, not browser pixel testing.

## Roadmap

### P0 — Session navigation

- [x] Search all persisted top-level sessions without an arbitrary result cap.
- [x] Show logged session titles, recent activity, working directory, short ID, state, and fork lineage.
- [x] Include a new, not-yet-persisted current session and preselect it.
- [x] Cache titles by persistence revision and isolate individual inspection failures.
- [x] Protect queued work and confirm before stopping an active turn.

### P1a — Daily workflow

- [ ] Queue manager with view and safe removal/reordering where supported.
- [ ] Session rename, fork, and archive actions.
- [ ] Produced-files and deliverables panel.
- [ ] Terminal-native image attachment and rendering with graceful fallback.
- [ ] Per-session composer drafts.

### P1b — Visibility

- [ ] Drill-down tool and trajectory inspector.
- [ ] Per-turn and per-tool timing.
- [ ] Jobs, workflows, and subagent status views.
- [ ] Richer token, cache, and session-total statistics.

### P2 — Configuration and support

- [ ] Provider and credential status/management.
- [ ] Preset and plugin discovery/configuration.
- [ ] Markdown and JSON export.
- [ ] Explicit feedback flow.

## How to refresh this document

When the pinned Harness version changes:

1. Update the exact Harness versions in `package.json`, regenerate `package-lock.json`, and update the pinned-version statements in `README.md` and this document.
2. From a clean worktree, install and confirm the resolved comparison packages:

   ```sh
   npm install --package-lock-only --ignore-scripts
   npm install --ignore-scripts
   npm ls @deepseek-ai/dsh @deepseek-ai/dsh-web-app @deepseek-ai/dsh-web-frontend
   ```

3. Inspect `node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml` for added or removed user-facing services. Read the matching `node_modules/@deepseek-ai/dsh-client-ui-*/README.md` files and the official runtime/session package types used by the TUI. Runtime and session contracts are authoritative; do not infer behavior only from Web components.
4. Exercise both products for each affected matrix row. In the change report, record the package version, command or test case, user-visible result, and whether evidence was automated, terminal-smoke, browser/manual, or unavailable.
5. Update the matrix, evidence map, and verification date. Re-rank roadmap items based on daily terminal value, data-safety risk, and whether the official runtime exposes a stable contract.
6. Run the checks below and have a fresh reader verify that this document answers: what is supported, what differs intentionally, what comes next, and how the comparison was made.

Do not mark a row Supported based only on a compiled implementation. Note whether evidence is automated, terminal-smoke tested, or manually verified when recording a substantial parity change in release notes or a pull request.

For the current session-navigation baseline, run:

```sh
npm run check
npm run pack:check
```

Both commands clean and rebuild the tracked `lib/` output. Start from a clean or intentionally isolated checkout, then review the generated diff; do not use them over unrelated uncommitted generated-file changes.

The automated fixture must cover more than 30 top-level sessions, a hidden subagent session, an unpersisted current session, title and working-directory search, revision-cache reuse and invalidation, one failed inspection, cancellation of a slow scan, queued-work blocking, and running-turn confirmation. Then launch the compiled TUI with an isolated Harness home. On macOS or Linux:

```sh
smoke_root="$(mktemp -d)"
printf 'Temporary Harness home: %s\n' "$smoke_root"
DSH_HOME="$smoke_root" node lib/src/bin.js
```

In PowerShell on Windows:

```powershell
$smokeRoot = Join-Path ([IO.Path]::GetTempPath()) ("dsh-tui-smoke-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $smokeRoot | Out-Null
Write-Host "Temporary Harness home: $smokeRoot"
$env:DSH_HOME = $smokeRoot
node lib/src/bin.js
```

Open `/sessions`, confirm the untitled current session is selected, type a query with no match, press Escape, and exit with Ctrl+D. This smoke test should not send a model request. The command prints the disposable directory explicitly; after the run, move that exact directory to the Trash or Recycle Bin with the platform's recoverable-delete tool.
