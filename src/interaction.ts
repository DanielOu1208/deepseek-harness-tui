export interface ModelRef {
  provider: string
  model: string
}

export function reasoningInitialValue(current: (ModelRef & { reasoningEffort?: string }) | undefined, next: ModelRef): string {
  return current?.provider === next.provider && current.model === next.model
    ? current.reasoningEffort ?? 'default'
    : 'default'
}

export interface PickerItem {
  value: string
  label: string
  description?: string
  /** Optional text used by searchable pickers without changing the visible row. */
  searchText?: string
}

export const OTHER_ANSWER_VALUE = 'answer:other'

export function questionPickerItems(
  options: readonly { label: string; description?: string }[],
): PickerItem[] {
  return options.map((option, index) => ({
    value: `answer:${index}`,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }))
}

export function questionLabelsFromValues(
  values: readonly string[],
  options: readonly { label: string }[],
): string[] {
  return values.flatMap(value => {
    if (!value.startsWith('answer:') || value === OTHER_ANSWER_VALUE) return []
    const option = options[Number(value.slice('answer:'.length))]
    return option === undefined ? [] : [option.label]
  })
}

export function filterPickerItems(items: readonly PickerItem[], prefix: string): PickerItem[] {
  const query = prefix.trim().toLocaleLowerCase()
  if (query === '') return [...items]
  return items.filter(item => [item.value, item.label, item.description ?? '']
    .some(field => field.toLocaleLowerCase().includes(query)))
}

export interface ModelPickerSource extends ModelRef {
  name: string
}

export function modelPickerItems(models: readonly ModelPickerSource[]): PickerItem[] {
  return models.map(model => ({
    value: `${model.provider}/${model.model}`,
    label: model.model,
    description: `${model.provider} · ${model.name}`,
  }))
}

export interface SessionPickerSource {
  id: string
  title?: string
  cwd?: string
  createdAt: number
  updatedAt?: number
  parentSession?: string
  current?: boolean
  running?: boolean
  titleUnavailable?: boolean
}

function shortSessionId(id: string): string {
  return id.length <= 16 ? id : `…${id.slice(-12)}`
}

export function sessionPickerItems(sessions: readonly SessionPickerSource[]): PickerItem[] {
  return [...sessions]
    .sort((left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt))
    .map(session => ({
      value: session.id,
      label: session.title ?? 'Untitled session',
      description: [
        session.current ? `Current · ${session.running ? 'running' : 'idle'}` : 'Saved',
        new Date(session.updatedAt ?? session.createdAt).toLocaleString(),
        session.cwd,
        shortSessionId(session.id),
        session.parentSession === undefined ? undefined : `fork of ${shortSessionId(session.parentSession)}`,
        session.titleUnavailable ? 'title unavailable' : undefined,
      ].filter((part): part is string => part !== undefined).join(' · '),
      searchText: [session.title, session.id, session.cwd]
        .filter((part): part is string => part !== undefined).join(' '),
    }))
}

export const PERMISSION_PICKER_ITEMS: readonly PickerItem[] = [
  { value: 'read-only', label: 'Read only', description: 'Inspect files without writing' },
  { value: 'workspace-write', label: 'Workspace write', description: 'Allow edits inside the workspace' },
  { value: 'danger-full-access', label: 'Full access', description: 'Allow unrestricted tool access' },
]

export const GOAL_PICKER_ITEMS: readonly PickerItem[] = [
  { value: 'view', label: 'View current goal', description: 'Show the active goal and state' },
  { value: 'set', label: 'Set objective…', description: 'Create or replace the goal objective' },
  { value: 'edit', label: 'Edit objective…', description: 'Change the current objective' },
  { value: 'clear', label: 'Clear goal', description: 'Remove the current goal' },
  { value: 'pause', label: 'Pause goal', description: 'Pause automatic continuation' },
  { value: 'resume', label: 'Resume goal', description: 'Resume automatic continuation' },
]

export const PLAN_PICKER_ITEMS: readonly PickerItem[] = [
  { value: 'enter', label: 'Enter plan mode', description: 'Plan before making changes' },
  { value: 'message', label: 'Enter with guidance…', description: 'Give plan-mode instructions' },
  { value: 'off', label: 'Leave plan mode', description: 'Return to normal execution' },
]

export interface ReasoningPickerSource {
  efforts: ReadonlyArray<{ id: string; name: string; description?: string }>
  defaultEffort?: string
}

export type ReasoningStepDirection = 'increase' | 'decrease'

export type ReasoningStepResult =
  | { kind: 'change'; effort: string }
  | { kind: 'boundary'; effort: string }
  | { kind: 'unavailable'; reason: 'no-efforts' | 'unknown-default' | 'unknown-current' }

export function stepReasoningEffort(
  reasoning: ReasoningPickerSource,
  currentEffort: string | undefined,
  direction: ReasoningStepDirection,
): ReasoningStepResult {
  if (reasoning.efforts.length === 0) return { kind: 'unavailable', reason: 'no-efforts' }
  const effective = currentEffort ?? reasoning.defaultEffort
  if (effective === undefined) return { kind: 'unavailable', reason: 'unknown-default' }
  const currentIndex = reasoning.efforts.findIndex(effort => effort.id === effective)
  if (currentIndex < 0) {
    const reason = currentEffort === undefined ? 'unknown-default' : 'unknown-current'
    return { kind: 'unavailable', reason }
  }
  const delta = direction === 'increase' ? 1 : -1
  const nextIndex = Math.max(0, Math.min(reasoning.efforts.length - 1, currentIndex + delta))
  const effort = reasoning.efforts[nextIndex]!.id
  return nextIndex === currentIndex ? { kind: 'boundary', effort } : { kind: 'change', effort }
}

export function reasoningPickerItems(reasoning: ReasoningPickerSource): PickerItem[] {
  const defaultName = reasoning.efforts.find(effort => effort.id === reasoning.defaultEffort)?.name
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
  ]
}

export const BUSY_PICKER_ITEMS: readonly PickerItem[] = [
  { value: 'queue', label: 'Queue', description: 'Send after the active turn finishes' },
  { value: 'steer', label: 'Steer', description: 'Inject into the nearest active agent step' },
]

export const SETTINGS_PICKER_ITEMS: readonly PickerItem[] = [
  { value: 'summary', label: 'Current settings', description: 'Show active session and default values' },
  { value: 'transcript-density', label: 'Transcript detail', description: 'Choose how much transcript detail to show' },
  { value: 'model', label: 'Model', description: 'Switch provider and model' },
  { value: 'reasoning', label: 'Reasoning effort', description: 'Select effort for the current model' },
  { value: 'permission', label: 'Permission', description: 'Set this session’s tool-access preset' },
  { value: 'busy', label: 'Busy Enter', description: 'Choose queue or steer while running' },
  { value: 'save-model-default', label: 'Save model as default', description: 'Use this model and effort for future sessions' },
  { value: 'save-permission-default', label: 'Save permission as default', description: 'Use this permission preset for future sessions' },
  { value: 'providers', label: 'Providers', description: 'Inspect configured routes, models, and input capabilities' },
  { value: 'runtime', label: 'Runtime', description: 'Inspect mounted Host plugins and configuration paths' },
  { value: 'support', label: 'Support and feedback', description: 'Review disclosure and send Harness feedback' },
  { value: 'advanced', label: 'Advanced runtime settings', description: 'Browse and patch registered Harness settings namespaces' },
]

export interface SettingsNamespacePickerSource {
  ns: string
  applies: 'live' | 'restart'
  revision: number
  secrets?: readonly unknown[]
}

export function settingsNamespacePickerItems(
  descriptors: readonly SettingsNamespacePickerSource[],
): PickerItem[] {
  return descriptors.map(descriptor => ({
    value: descriptor.ns,
    label: descriptor.ns,
    description: [
      descriptor.applies === 'live' ? 'Live' : 'Restart required',
      `revision ${descriptor.revision}`,
      descriptor.secrets?.length ? 'contains hidden secrets' : undefined,
    ].filter((part): part is string => part !== undefined).join(' · '),
  }))
}

export function parseSettingsPatch(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('settings patch must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export const NESTED_MENU_COMMANDS = new Set([
  'busy', 'goal', 'model', 'permission', 'plan', 'reasoning', 'resume', 'settings',
])

export function parseModelRef(value: string): ModelRef | undefined {
  const normalized = value.trim()
  const separator = normalized.indexOf('/')
  if (separator <= 0 || separator === normalized.length - 1) return undefined
  return { provider: normalized.slice(0, separator), model: normalized.slice(separator + 1) }
}
