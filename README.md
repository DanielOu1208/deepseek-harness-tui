# DeepSeek Harness TUI

A standalone terminal interaction plane for the **official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**, rendered with [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui).

This package does **not** fork or replace the Harness. The official runtime still owns the agent loop, models, tools, permissions, sessions, checkpoints, compaction, goals, skills, MCP, and subagents. This repository only supplies a Cordis profile layer and terminal UI.

> **Status:** experimental MVP targeting DeepSeek Harness `0.1.0-rc.6`. The Harness is prerelease software, so keep the CLI and this plugin on matching versions.

## Features

- Full-screen terminal UI with a multiline editor and command completion
- Streaming assistant text, reasoning, tool calls, results, usage, and todos
- Approval prompts and `ask_user_question` interaction
- Terminal control-sequence sanitization for model, tool, session, and plugin text
- New, list, switch, and resume persisted sessions
- Model and reasoning-effort selection
- Official Harness slash commands, goals, plans, compaction, settings, and permissions
- Queue or steer while an agent turn is active
- `Ctrl+C` interruption and clean terminal teardown
- Cooperative durable pause: cancel → wait for idle → flush → exit → resume by session ID

## Architecture

```text
Official DeepSeek Harness runtime
├── agent loop, models, tools, permissions
├── sessions, checkpoints, goals, skills, MCP
└── Cordis services
          ↑
   @chalk/dsh-tui
          ↑
 @earendil-works/pi-tui
```

The durable DeepSeek session log is the source of truth. Session events are folded into a render-only projection for the TUI.

## Requirements

- macOS, Linux, or Windows terminal
- Node.js **22.19.0 or newer** (Node 24 is also tested)
- Git
- `pnpm` available on `PATH` because `dsh plugin` delegates package management to it
- A DeepSeek API key for live model requests

Check your environment:

```sh
node --version
pnpm --version
dsh --version
```

## Quick start

### 1. Install the official CLI and pnpm

```sh
npm install --global @deepseek-ai/dsh@0.1.0-rc.6 pnpm@11.21.0
```

If `npm` warns about the Node engine, upgrade Node before continuing.

### 2. Install this profile from GitHub

```sh
dsh plugin --profile tui add github:DanielOu1208/deepseek-harness-tui
```

The first command initializes the `tui` profile if it does not exist and composes this bundle over the official `@deepseek-ai/dsh-base` runtime.

### 3. Configure the API key

#### Temporary key for one shell session

This avoids putting the key in a repository or shell-history command:

```sh
printf 'DeepSeek API key: '
read -s DEEPSEEK_API_KEY
printf '\n'
export DEEPSEEK_API_KEY
```

Run the TUI from the workspace the agent should operate on:

```sh
cd /path/to/your/project
dsh --profile tui
```

When finished:

```sh
unset DEEPSEEK_API_KEY
```

#### Persistent Harness credential

The official local credential provider reads `~/.dsh/.credentials.yaml` by default. If you set `DSH_HOME`, use `$DSH_HOME/.credentials.yaml` instead.

```sh
mkdir -p ~/.dsh
chmod 700 ~/.dsh
nano ~/.dsh/.credentials.yaml
```

Add this YAML mapping with your real key:

```yaml
DEEPSEEK_API_KEY: "sk-your-key-here"
```

Then secure the file:

```sh
chmod 600 ~/.dsh/.credentials.yaml
```

Never commit `.credentials.yaml`, `.env`, or a real key. An inherited `DEEPSEEK_API_KEY` environment variable takes precedence over the credential file, so unset stale shell values if a newly stored key appears to have no effect.

An OpenAI-compatible DeepSeek gateway can be selected separately:

```sh
export DEEPSEEK_BASE_URL="https://your-gateway.example/v1"
```

Omit it to use the public DeepSeek endpoint.

### 4. Send a live test prompt

Interactive:

```sh
dsh --profile tui
```

Start with an initial prompt:

```sh
dsh --profile tui "Reply exactly with LIVE_MODEL_OK"
```

Choose a working directory explicitly:

```sh
dsh --profile tui --cwd /path/to/project
```

Resume a persisted session:

```sh
dsh --profile tui --resume session-xxxxxxxx
```

## Controls

| Input | Action |
|---|---|
| `Enter` | Submit the editor contents |
| `/` or `Tab` | Browse and complete commands |
| `F2` | Open settings |
| `Ctrl+C` | Interrupt the active turn; press again to exit |
| `Ctrl+D` | Exit when the editor is empty |

## Local TUI commands

| Command | Purpose |
|---|---|
| `/help` | Show local and official Harness commands |
| `/new` | Start a fresh session |
| `/sessions` | List persisted sessions |
| `/resume [session-id]` | Select or directly resume a session |
| `/models` | List available models |
| `/model [provider/model]` | Select a model |
| `/reasoning [effort]` | Select reasoning effort |
| `/permission [mode]` | Select the official tool-permission preset |
| `/busy [queue\|steer]` | Choose how plain input behaves while busy |
| `/settings` | Open core TUI settings |
| `/queue <prompt>` | Queue a separate follow-up turn |
| `/steer <prompt>` | Steer the nearest active agent step |
| `/stop` | Cancel the active turn but keep the TUI open |
| `/pause` | Cancel, wait, flush, show the resume ID, and exit |
| `/exit` | Flush and exit cleanly |

Unknown slash commands are offered to the official Harness command service. Availability depends on the composed base profile; common examples include `/compact`, `/goal`, `/plan`, and `/feedback`.

## Pause and resume semantics

`/pause` is a **cooperative durable stop**, not process freezing. It:

1. Cancels active agent work while preserving queued inbox items.
2. Waits for the official agent to become idle.
3. Flushes the official session log.
4. Disposes the handle and exits the TUI.
5. Prints the official session ID for `--resume` or `/resume`.

It cannot continue an HTTP stream or tool process at the exact machine instruction where it stopped. That would be unsafe for network state, locks, child processes, and tool side effects.

## Install from a local checkout

Use this when developing or testing an unpublished change:

```sh
git clone https://github.com/DanielOu1208/deepseek-harness-tui.git
cd deepseek-harness-tui
npm install
npm run check

dsh plugin --profile tui add .
dsh --profile tui
```

The repository includes compiled `lib/` output so pnpm can install the package directly from GitHub without executing dependency build scripts. The explicit `npm run check` above rebuilds that output and runs all tests before linking a local checkout.

## Updating or uninstalling

Reinstall the current GitHub version:

```sh
dsh plugin --profile tui remove @chalk/dsh-tui
dsh plugin --profile tui add github:DanielOu1208/deepseek-harness-tui
```

Remove the plugin while retaining the profile directory and its user configuration:

```sh
dsh plugin --profile tui remove @chalk/dsh-tui
```

## Development

```sh
npm install
npm test
npm run build
npm run check
npm run pack:check
```

Project structure:

```text
cordis.patch.yml       official base-profile overlay
src/startup.ts         profile CLI options
src/index.ts           Harness lifecycle and interaction bridge
src/projection.ts      pure session-event projection
src/ui.ts              pi-tui terminal presentation
src/commands.ts        local/official command routing
src/interaction.ts     menus and input parsing
tests/                 non-TTY unit tests
```

## Troubleshooting

### `pnpm not found on PATH`

Install it globally and retry:

```sh
npm install --global pnpm@11.21.0
```

### Peer-dependency warnings during plugin installation

The current prerelease `dsh` profile layout may print peer warnings for Cordis/Harness services supplied by the official base bundle. The clean-profile smoke test for this repository produces that warning and then boots successfully. Do not install random peer versions manually; first verify the effective profile instead:

```sh
dsh --profile tui --dump-config
```

The bundle stack should contain `@deepseek-ai/dsh-base` and `@chalk/dsh-tui`.

### `MISSING_CREDENTIAL`

The process could not resolve `DEEPSEEK_API_KEY`. Check only whether it exists—do not print its value:

```sh
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then echo 'key is set'; else echo 'key is missing'; fi
```

For the persistent store, confirm permissions:

```sh
chmod 700 ~/.dsh
chmod 600 ~/.dsh/.credentials.yaml
```

Restart the TUI after changing an environment-sourced key. The managed credential file itself is hot-reloaded by the official Harness.

### Authentication or quota errors

- `AUTH`: the key was rejected; replace it and retry.
- `QUOTA`: the account has exhausted its balance or credits.
- `RATE_LIMIT`: wait and retry; the official runtime owns bounded step retries.

### Profile/plugin version mismatch

This MVP pins DeepSeek Harness `0.1.0-rc.6`. Confirm the CLI:

```sh
dsh --version
```

If it differs, install the matching CLI shown in this README and reinstall the profile.

### Broken terminal after a crash

The TUI normally restores terminal state. If the process is force-killed and your shell looks wrong, run:

```sh
reset
```

### Inspect the composed profile

```sh
dsh --profile tui --dump-config
```

You should see both `@deepseek-ai/dsh-base` and `@chalk/dsh-tui` in the effective bundle stack.

## Security notes

- Never put credentials in this repository, prompts, screenshots, issues, or terminal logs.
- The default Harness permission mode is `workspace-write`; review approval prompts before allowing actions.
- The local credential document is protected from other OS users by file mode, but agent tools run as your user. File permissions alone are not an isolation boundary from same-user processes.
- Session telemetry is disabled by default in the official base profile unless you explicitly enable it.

## License

MIT © 2026 Daniel Ou.

## Upstream

This is an independent community interaction plane and is not an official DeepSeek release.

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)
- [DeepSeek credential provider reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/credentials-local/README.md)
- [DeepSeek LLM adapter reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/README.md)
