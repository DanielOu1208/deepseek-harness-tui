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
| Tool calls, results, and diffs | Supported | Terminal-native cards, bounded output, syntax-aware diffs, approval dialogs, `/inspect` drill-down | Keep presentation aligned with official tool metadata. |
| Questions and approvals | Supported | Single- and multi-select dialogs, custom answers, required-interaction priority | Keep aligned with official request contracts. |
| Plan, goal, permissions, model, reasoning | Supported | Slash commands, F2 settings, Shift+Tab, Shift+Up/Down | Surface richer provider/model capability details where useful. |
| Context and token visibility | Supported | Footer context pressure plus `/stats` session timing and four provider-reported token/cache buckets | Keep the distinction between context estimates and provider usage explicit. |
| Session discovery and resume | Supported | `/sessions` or bare `/resume` opens title-aware fuzzy search across title, full ID, and working directory | Add session actions without turning the navigator into a browser clone. |
| Session actions | Supported | `/session` renames, creates a boundary-safe fork, or archives after strong confirmation | Harness rc.6 has no safe unarchive contract; archive is one-way. |
| Workspace grouping | Supported | `/workspaces` groups non-archived sessions through the official workspace registry | Keep working-directory failures isolated from session opening. |
| Queued work | Supported | Bare `/queue` views, edits text-only items, and safely removes unclaimed items | Reordering is deferred because rc.6 exposes no public reorder operation. |
| Per-session composer drafts | Supported | Text drafts save privately under `$DSH_HOME/tui/drafts/v1` and restore across navigation | Images remain deliberately non-persistent. |
| Produced files and deliverables | Supported | `/deliverables` derives successful mutation outputs and offers copy/open actions | Only tool-declared successful mutations are treated as deliverables. |
| Tool trajectory and inspection | Supported | `/inspect` searches bounded step, root-tool, and nested Code Mode records with timing and error context | Raw detail remains bounded for terminal safety. |
| Jobs, workflows, and subagents | Supported | `/activity` inspects process-local jobs, durable workflow records, and durable descendant sessions | Live workflow phase/log messages are not durable in rc.6; subagent activity is not an outcome. |
| Image input and output | Partial | `/attach path` and Ctrl+V use official image attachments; transcript fallback is `[image]` | Inline terminal image rendering and model-produced image output are intentionally not emulated. |
| Providers and credentials | Partial | F2 provider summaries, model modalities, launcher `auth status`, and secret-redacted advanced settings | Provider profiles remain a `settings.yaml` workflow; credentials are never shown. |
| Presets, plugins, and runtime settings | Supported | F2 shows the read-only Host plugin inventory, configuration paths, and registered settings namespaces | Plugin enablement and deeper preset composition remain configuration-file workflows. |
| Export | Supported | `/export` writes owner-private, atomic Markdown or versioned JSON without attachment bytes | Exports disclose that prompts, tool output, and paths may be sensitive. |
| Feedback | Supported | F2 → Support and feedback invokes the official `/feedback` command and its sharing disclosure | Keep the official command as the recording authority. |
| Session statistics | Supported | `/stats` uses official whole-log stats and provider-reported usage buckets | Nested Code Mode time is labeled separately from official root-tool time. |
| Browser layout, split panes, theme | Intentionally different | Scrollable transcript, inline dialogs, compact status footer | Preserve terminal navigation and readable narrow-width behavior. |
| Drag-and-drop and image lightbox | Intentionally different | `/attach`, clipboard input, `[image]` transcript fallback, and external-open actions | Preserve portable terminal behavior rather than requiring graphics protocols. |

The session navigator intentionally does not search full transcript text. It searches title, full session ID, and working directory so results remain fast and predictable without maintaining a second content index.

## Evidence map

Use these paths to reproduce the matrix rather than treating status labels as assertions:

- Core conversation, tools, questions, approvals, drafts, and transcript behavior: [`tests/projection.test.ts`](../tests/projection.test.ts), [`tests/ui.test.ts`](../tests/ui.test.ts), and [`tests/drafts.test.ts`](../tests/drafts.test.ts).
- Plan/reasoning shortcuts, context pressure, capacity, and request usage: [`tests/shortcuts.test.ts`](../tests/shortcuts.test.ts) and the footer cases in [`tests/ui.test.ts`](../tests/ui.test.ts).
- Session discovery, caching, filtering, switching, and failure safety: [`tests/sessions.test.ts`](../tests/sessions.test.ts), session picker cases in [`tests/interaction.test.ts`](../tests/interaction.test.ts), and the terminal smoke below.
- Models, permissions, queues, settings, goals, commands, attachments, and deliverables: [`tests/interaction.test.ts`](../tests/interaction.test.ts), [`tests/commands.test.ts`](../tests/commands.test.ts), and [`tests/parity-foundation.test.ts`](../tests/parity-foundation.test.ts).
- Tool timing, token buckets, workflows, and export: [`tests/visibility.test.ts`](../tests/visibility.test.ts), [`tests/activity.test.ts`](../tests/activity.test.ts), and [`tests/export.test.ts`](../tests/export.test.ts).
- Partial and Deferred rows are comparison findings: verify the current TUI paths above against the installed official `@deepseek-ai/dsh-web-app/cordis.patch.yml` roster and relevant installed `@deepseek-ai/dsh-client-ui-*/README.md` contracts. Record the exact package version and observed gap when changing a status.

The current matrix is based on 123 automated tests plus an isolated compiled-launcher and terminal startup/exit smoke on macOS. It is a contract/capability comparison, not browser pixel testing. Clipboard commands are covered with deterministic adapters; real clipboard acceptance still requires manual testing on each operating system.

## Verification gates

A parity change is ready to commit only when all of these hold:

- `npm run check` passes the full suite and regenerates `lib/` without drift.
- `npm run pack:check` passes, and compressed package growth stays within 250 KiB of the 49,804-byte pre-parity baseline unless a larger change is explicitly reviewed.
- The profile dump contains only Host/runtime services added by this TUI—no `dsh-client-*`, React, Web API proxy, browser UI, or browser transport additions.
- An isolated packed install passes `deepseek --help` and `deepseek --version` without creating state outside its temporary `$DSH_HOME`.
- An isolated compiled TUI starts, renders an idle session, and exits with Ctrl+D without sending a model request.
- CI repeats build, generated-output, launcher, and package checks on Ubuntu with Node 22.19 and 24, macOS with Node 24, and Windows with Node 24.

Record evidence honestly: the suite is automated, the local startup/exit check is a terminal smoke, and real clipboard interoperability is manual/unavailable until exercised on the named platform.

## Roadmap

### P0 — Session navigation

- [x] Search all persisted top-level sessions without an arbitrary result cap.
- [x] Show logged session titles, recent activity, working directory, short ID, state, and fork lineage.
- [x] Include a new, not-yet-persisted current session and preselect it.
- [x] Cache titles by persistence revision and isolate individual inspection failures.
- [x] Protect queued work and confirm before stopping an active turn.

### P1a — Daily workflow

- [x] Queue manager with view, text editing, and safe removal. Reordering awaits an official contract.
- [x] Session rename, boundary-safe fork, and one-way archive actions.
- [x] Produced-files and deliverables panel.
- [x] Portable clipboard and path-based image attachment with `[image]` fallback.
- [x] Owner-private per-session text drafts.

### P1b — Visibility

- [x] Drill-down step, tool, and nested-tool inspector.
- [x] Per-step, root-tool, and nested-tool timing.
- [x] Jobs, workflows, and subagent status views with lifecycle disclosures.
- [x] Provider token/cache buckets and whole-session timing statistics.

### P2 — Configuration and support

- [x] Safe provider capability summary and credential-source guidance.
- [x] Read-only preset/plugin/runtime discovery and configuration paths.
- [x] Owner-private Markdown and versioned JSON export.
- [x] Explicit feedback flow through the official command.

## Deferred runtime-contract gaps

These are deliberately not emulated with private state or Web client code:

- Queue reordering: rc.6 exposes replace and remove for unclaimed inbox items, but no public reorder operation.
- Unarchive: the workspace registry exposes one-way archive only. The TUI warns and defaults to Cancel.
- Per-session preset selection: the current Agent factory does not expose a safe published-session mutation path. Preset defaults and composition remain configuration-file workflows.
- Live plugin mutation: the Host inventory is read-only. Enablement and ordering remain profile patch workflows.
- Inline image rendering: clipboard and path input are portable, while transcript output stays `[image]`; terminal-specific graphics protocols are not required.

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
