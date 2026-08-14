export interface ModelRef {
    provider: string;
    model: string;
}
export interface PickerItem {
    value: string;
    label: string;
    description?: string;
}
export declare function filterPickerItems(items: readonly PickerItem[], prefix: string): PickerItem[];
export interface ModelPickerSource extends ModelRef {
    name: string;
}
export declare function modelPickerItems(models: readonly ModelPickerSource[]): PickerItem[];
export interface SessionPickerSource {
    id: string;
    cwd?: string;
    createdAt: number;
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
export interface MultiAnswer {
    selected: string[];
    custom?: string;
}
export declare function parseMultiAnswer(value: string, labels: readonly string[]): MultiAnswer;
