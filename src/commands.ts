import type { SlashCommand } from '@earendil-works/pi-tui'

export type LocalCommandName =
  | 'help'
  | 'new'
  | 'resume'
  | 'sessions'
  | 'pause'
  | 'stop'
  | 'model'
  | 'models'
  | 'reasoning'
  | 'permission'
  | 'busy'
  | 'settings'
  | 'queue'
  | 'steer'
  | 'exit'

export type ParsedInput =
  | { kind: 'prompt'; text: string }
  | { kind: 'harness-command'; line: string }
  | { kind: 'local'; name: LocalCommandName; argument: string }

const LOCAL_COMMANDS = new Set<LocalCommandName>([
  'help', 'new', 'resume', 'sessions', 'pause', 'stop', 'model', 'models',
  'reasoning', 'permission', 'busy', 'settings', 'queue', 'steer', 'exit',
])

export interface HarnessCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
}

export const LOCAL_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'exit', description: 'Flush the session and exit' },
  { name: 'help', description: 'Show TUI and official Harness commands' },
  { name: 'model', description: 'Switch the model for the next request', argumentHint: '<provider>/<model>' },
  { name: 'models', description: 'List available models' },
  { name: 'reasoning', description: 'Select reasoning effort for the current model', argumentHint: '[default|effort]' },
  { name: 'new', description: 'Start a fresh session' },
  { name: 'pause', description: 'Stop, persist, and exit with a resume ID' },
  { name: 'permission', description: 'Set the tool permission mode', argumentHint: '<mode>' },
  { name: 'busy', description: 'Choose what plain Enter does while the agent is busy', argumentHint: '[queue|steer]' },
  { name: 'settings', description: 'Open the core TUI settings menu' },
  { name: 'setting', description: 'Open the core TUI settings menu (alias)' },
  { name: 'queue', description: 'Queue a separate follow-up turn', argumentHint: '<prompt>' },
  { name: 'resume', description: 'Open a persisted session', argumentHint: '<session-id>' },
  { name: 'sessions', description: 'List persisted sessions' },
  { name: 'steer', description: 'Steer the nearest active agent step', argumentHint: '<prompt>' },
  { name: 'stop', description: 'Stop the active turn' },
]

export function buildSlashCommands(harness: readonly HarnessCommandDescriptor[]): SlashCommand[] {
  const commands = new Map(LOCAL_SLASH_COMMANDS.map(command => [command.name, { ...command }]))
  for (const command of harness) {
    if (commands.has(command.name)) continue
    commands.set(command.name, {
      name: command.name,
      description: command.description,
      ...(command.input === undefined ? {} : { argumentHint: command.input.hint }),
    })
  }
  return [...commands.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function formatCommandHelp(commands: readonly SlashCommand[]): string {
  const rows = commands.map(command => ({
    usage: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`,
    description: command.description ?? '',
  }))
  const width = Math.max(0, ...rows.map(row => row.usage.length))
  return `Available slash commands\n\n${rows
    .map(row => `  ${row.usage.padEnd(width)}  ${row.description}`.trimEnd())
    .join('\n')}\n\nType / or press Tab to browse and complete commands.`
}

export function parseInput(input: string): ParsedInput {
  const text = input.trim()
  if (!text.startsWith('/')) return { kind: 'prompt', text }
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text)
  if (match === null) return { kind: 'prompt', text }
  const name = match[1]?.toLowerCase()
  const argument = match[2] ?? ''
  if (name === 'setting') return { kind: 'local', name: 'settings', argument }
  if (name !== undefined && LOCAL_COMMANDS.has(name as LocalCommandName)) {
    return { kind: 'local', name: name as LocalCommandName, argument }
  }
  return { kind: 'harness-command', line: text }
}

export const HELP_TEXT = `Local TUI commands:
  /new                       start a fresh session
  /sessions                  list persisted sessions
  /resume <session-id>       open a persisted session
  /models                    list available models
  /model <provider>/<model>  switch the next model request
  /reasoning <effort>        select model reasoning effort
  /permission <mode>         read-only | workspace-write | danger-full-access
  /busy <queue|steer>        choose plain Enter behavior while busy
  /settings                  open core TUI settings
  /stop                      stop the active turn
  /pause                     stop, flush, print the resume id, and exit
  /steer <text>              steer the nearest agent step
  /queue <text>              queue a separate follow-up turn
  /exit                      flush and exit

Official Harness commands such as /compact, /goal, and /feedback are passed to ctx.commands.`
