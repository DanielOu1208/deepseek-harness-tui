export interface ModelRef {
    provider: string;
    model: string;
}
export declare function reasoningInitialValue(current: (ModelRef & {
    reasoningEffort?: string;
}) | undefined, next: ModelRef): string;
export interface PickerItem {
    value: string;
    label: string;
    description?: string;
    /** Optional text used by searchable pickers without changing the visible row. */
    searchText?: string;
}
export declare const OTHER_ANSWER_VALUE = "answer:other";
export declare function questionPickerItems(options: readonly {
    label: string;
    description?: string;
}[]): PickerItem[];
export declare function questionLabelsFromValues(values: readonly string[], options: readonly {
    label: string;
}[]): string[];
export declare function filterPickerItems(items: readonly PickerItem[], prefix: string): PickerItem[];
export interface ModelPickerSource extends ModelRef {
    name: string;
}
export declare function modelPickerItems(models: readonly ModelPickerSource[]): PickerItem[];
export interface SessionPickerSource {
    id: string;
    title?: string;
    cwd?: string;
    createdAt: number;
    updatedAt?: number;
    parentSession?: string;
    current?: boolean;
    running?: boolean;
    titleUnavailable?: boolean;
}
export declare function sessionPickerItems(sessions: readonly SessionPickerSource[]): PickerItem[];
export declare const PERMISSION_PICKER_ITEMS: readonly PickerItem[];
export declare const GOAL_PICKER_ITEMS: readonly PickerItem[];
export declare const PLAN_PICKER_ITEMS: readonly PickerItem[];
export interface ReasoningPickerSource {
    efforts: ReadonlyArray<{
        id: string;
        name: string;
        description?: string;
    }>;
    defaultEffort?: string;
}
export type ReasoningStepDirection = 'increase' | 'decrease';
export type ReasoningStepResult = {
    kind: 'change';
    effort: string;
} | {
    kind: 'boundary';
    effort: string;
} | {
    kind: 'unavailable';
    reason: 'no-efforts' | 'unknown-default' | 'unknown-current';
};
export declare function stepReasoningEffort(reasoning: ReasoningPickerSource, currentEffort: string | undefined, direction: ReasoningStepDirection): ReasoningStepResult;
export declare function reasoningPickerItems(reasoning: ReasoningPickerSource): PickerItem[];
export declare const BUSY_PICKER_ITEMS: readonly PickerItem[];
export declare const SETTINGS_PICKER_ITEMS: readonly PickerItem[];
export interface SettingsNamespacePickerSource {
    ns: string;
    applies: 'live' | 'restart';
    revision: number;
    secrets?: readonly unknown[];
}
export declare function settingsNamespacePickerItems(descriptors: readonly SettingsNamespacePickerSource[]): PickerItem[];
export declare function parseSettingsPatch(text: string): Record<string, unknown>;
export declare const NESTED_MENU_COMMANDS: Set<string>;
export declare function parseModelRef(value: string): ModelRef | undefined;
