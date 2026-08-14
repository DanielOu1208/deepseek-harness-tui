import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
export const TRANSCRIPT_DENSITIES = ['compact', 'normal', 'debug'];
export const DEFAULT_TRANSCRIPT_DENSITY = 'normal';
export const TRANSCRIPT_DENSITY_PICKER_ITEMS = [
    { value: 'compact', label: 'Compact', description: 'Show a concise transcript' },
    { value: 'normal', label: 'Normal', description: 'Show standard transcript detail' },
    { value: 'debug', label: 'Debug', description: 'Show the most transcript detail' },
];
export const TRANSCRIPT_SETTINGS_NAMESPACE = settingsNamespace('dsh-tui');
export const TRANSCRIPT_SETTINGS_SCHEMA = z.object({
    transcriptDensity: z.union([...TRANSCRIPT_DENSITIES]).default(DEFAULT_TRANSCRIPT_DENSITY),
});
