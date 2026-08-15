const LOCAL_COMMAND_DEFINITIONS = [
    { name: 'exit', description: 'Flush the session and exit' },
    { name: 'help', description: 'Show TUI and official Harness commands' },
    { name: 'model', description: 'Switch the model for the next request', argumentHint: '<provider>/<model>' },
    { name: 'models', description: 'List available models' },
    { name: 'reasoning', description: 'Select reasoning effort for the current model', argumentHint: '[default|effort]' },
    { name: 'new', description: 'Start a fresh session' },
    { name: 'session', description: 'Rename, fork, or archive a session', argumentHint: '[session-id]' },
    { name: 'workspaces', description: 'Browse sessions grouped by workspace' },
    { name: 'pause', description: 'Stop, persist, and exit with a resume ID' },
    { name: 'permission', description: 'Set the tool permission mode', argumentHint: '<mode>' },
    { name: 'busy', description: 'Choose what plain Enter does while the agent is busy', argumentHint: '[queue|steer]' },
    { name: 'settings', description: 'Open the core TUI settings menu' },
    { name: 'queue', description: 'Manage queued work or add a follow-up', argumentHint: '[prompt]' },
    { name: 'resume', description: 'Search sessions or open one by ID', argumentHint: '[session-id]' },
    { name: 'sessions', description: 'Search and switch sessions' },
    { name: 'steer', description: 'Steer the nearest active agent step', argumentHint: '<prompt>' },
    { name: 'attach', description: 'Attach an image to the next prompt', argumentHint: '[path]' },
    { name: 'deliverables', description: 'Browse files produced by successful tools' },
    { name: 'inspect', description: 'Inspect steps and tool calls' },
    { name: 'stats', description: 'Show timing and token statistics' },
    { name: 'activity', description: 'Show jobs, workflows, and subagents' },
    { name: 'export', description: 'Export the current session', argumentHint: '[markdown|json]' },
    { name: 'stop', description: 'Stop the active turn' },
];
const LOCAL_COMMANDS = new Set(LOCAL_COMMAND_DEFINITIONS.map(command => command.name));
function isLocalCommandName(name) {
    return LOCAL_COMMANDS.has(name);
}
export const LOCAL_SLASH_COMMANDS = LOCAL_COMMAND_DEFINITIONS;
export function buildSlashCommands(harness) {
    const commands = new Map(LOCAL_SLASH_COMMANDS.map(command => [command.name, { ...command }]));
    for (const command of harness) {
        if (commands.has(command.name))
            continue;
        commands.set(command.name, {
            name: command.name,
            description: command.description,
            ...(command.input === undefined ? {} : { argumentHint: command.input.hint }),
        });
    }
    return [...commands.values()].sort((left, right) => left.name.localeCompare(right.name));
}
export function formatCommandHelp(commands) {
    const rows = commands.map(command => ({
        usage: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`,
        description: command.description ?? '',
    }));
    const width = Math.max(0, ...rows.map(row => row.usage.length));
    return `Available slash commands\n\n${rows
        .map(row => `  ${row.usage.padEnd(width)}  ${row.description}`.trimEnd())
        .join('\n')}\n\nType / or press Tab to browse and complete commands.`;
}
export function parseInput(input) {
    const text = input.trim();
    if (!text.startsWith('/'))
        return { kind: 'prompt', text };
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text);
    if (match === null)
        return { kind: 'prompt', text };
    const name = match[1]?.toLowerCase();
    const argument = match[2] ?? '';
    if (name === 'setting')
        return { kind: 'local', name: 'settings', argument };
    if (name !== undefined && isLocalCommandName(name)) {
        return { kind: 'local', name, argument };
    }
    return { kind: 'harness-command', line: text };
}
