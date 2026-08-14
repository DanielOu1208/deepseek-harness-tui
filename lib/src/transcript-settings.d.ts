import z from '@deepseek-ai/schemastery';
export declare const TRANSCRIPT_DENSITIES: readonly ["compact", "normal", "debug"];
export type TranscriptDensity = typeof TRANSCRIPT_DENSITIES[number];
export declare const DEFAULT_TRANSCRIPT_DENSITY: TranscriptDensity;
export declare const TRANSCRIPT_DENSITY_PICKER_ITEMS: readonly [{
    readonly value: "compact";
    readonly label: "Compact";
    readonly description: "Show a concise transcript";
}, {
    readonly value: "normal";
    readonly label: "Normal";
    readonly description: "Show standard transcript detail";
}, {
    readonly value: "debug";
    readonly label: "Debug";
    readonly description: "Show the most transcript detail";
}];
export declare const TRANSCRIPT_SETTINGS_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
export interface TranscriptSettings {
    transcriptDensity: TranscriptDensity;
}
export declare const TRANSCRIPT_SETTINGS_SCHEMA: z<TranscriptSettings>;
