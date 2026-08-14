export function filterPickerItems(items, prefix) {
    const query = prefix.trim().toLocaleLowerCase();
    if (query === '')
        return [...items];
    return items.filter(item => [item.value, item.label, item.description ?? '']
        .some(field => field.toLocaleLowerCase().includes(query)));
}
export function modelPickerItems(models) {
    return models.map(model => ({
        value: `${model.provider}/${model.model}`,
        label: model.model,
        description: `${model.provider} · ${model.name}`,
    }));
}
export function sessionPickerItems(sessions) {
    return [...sessions]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(session => ({
        value: session.id,
        label: session.id,
        description: session.cwd ?? 'Persisted session',
    }));
}
export const PERMISSION_PICKER_ITEMS = [
    { value: 'read-only', label: 'Read only', description: 'Inspect files without writing' },
    { value: 'workspace-write', label: 'Workspace write', description: 'Allow edits inside the workspace' },
    { value: 'danger-full-access', label: 'Full access', description: 'Allow unrestricted tool access' },
];
export const GOAL_PICKER_ITEMS = [
    { value: 'view', label: 'View current goal', description: 'Show the active goal and state' },
    { value: 'set', label: 'Set objective…', description: 'Create or replace the goal objective' },
    { value: 'edit', label: 'Edit objective…', description: 'Change the current objective' },
    { value: 'clear', label: 'Clear goal', description: 'Remove the current goal' },
    { value: 'pause', label: 'Pause goal', description: 'Pause automatic continuation' },
    { value: 'resume', label: 'Resume goal', description: 'Resume automatic continuation' },
];
export const PLAN_PICKER_ITEMS = [
    { value: 'enter', label: 'Enter plan mode', description: 'Plan before making changes' },
    { value: 'message', label: 'Enter with guidance…', description: 'Give plan-mode instructions' },
    { value: 'off', label: 'Leave plan mode', description: 'Return to normal execution' },
];
export function reasoningPickerItems(reasoning) {
    const defaultName = reasoning.efforts.find(effort => effort.id === reasoning.defaultEffort)?.name;
    return [
        {
            value: 'default',
            label: 'Model default',
            ...(defaultName === undefined ? {} : { description: `Currently ${defaultName}` }),
        },
        ...reasoning.efforts.map(effort => ({
            value: effort.id,
            label: effort.name,
            ...(effort.description !== undefined
                ? { description: effort.description }
                : effort.id === reasoning.defaultEffort ? { description: 'Model default' } : {}),
        })),
    ];
}
export const BUSY_PICKER_ITEMS = [
    { value: 'queue', label: 'Queue', description: 'Send after the active turn finishes' },
    { value: 'steer', label: 'Steer', description: 'Inject into the nearest active agent step' },
];
export const SETTINGS_PICKER_ITEMS = [
    { value: 'summary', label: 'Current settings', description: 'Show active session and default values' },
    { value: 'model', label: 'Model', description: 'Switch provider and model' },
    { value: 'reasoning', label: 'Reasoning effort', description: 'Select effort for the current model' },
    { value: 'permission', label: 'Permission', description: 'Set this session’s tool-access preset' },
    { value: 'busy', label: 'Busy Enter', description: 'Choose queue or steer while running' },
    { value: 'save-model-default', label: 'Save model as default', description: 'Use this model and effort for future sessions' },
    { value: 'save-permission-default', label: 'Save permission as default', description: 'Use this permission preset for future sessions' },
    { value: 'advanced', label: 'Advanced runtime settings', description: 'Browse and patch registered Harness settings namespaces' },
];
export function settingsNamespacePickerItems(descriptors) {
    return descriptors.map(descriptor => ({
        value: descriptor.ns,
        label: descriptor.ns,
        description: [
            descriptor.applies === 'live' ? 'Live' : 'Restart required',
            `revision ${descriptor.revision}`,
            descriptor.secrets?.length ? 'contains hidden secrets' : undefined,
        ].filter((part) => part !== undefined).join(' · '),
    }));
}
export function parseSettingsPatch(text) {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('settings patch must be a JSON object');
    }
    return parsed;
}
export const NESTED_MENU_COMMANDS = new Set([
    'busy', 'goal', 'model', 'permission', 'plan', 'reasoning', 'resume', 'settings',
]);
export function parseModelRef(value) {
    const normalized = value.trim();
    const separator = normalized.indexOf('/');
    if (separator <= 0 || separator === normalized.length - 1)
        return undefined;
    return { provider: normalized.slice(0, separator), model: normalized.slice(separator + 1) };
}
export function parseMultiAnswer(value, labels) {
    const parts = value.split(',').map(part => part.trim()).filter(Boolean);
    const byLower = new Map(labels.map(label => [label.toLocaleLowerCase(), label]));
    const selected = [];
    const custom = [];
    for (const part of parts) {
        const known = byLower.get(part.toLocaleLowerCase());
        if (known === undefined)
            custom.push(part);
        else if (!selected.includes(known))
            selected.push(known);
    }
    return { selected, ...(custom.length === 0 ? {} : { custom: custom.join(', ') }) };
}
