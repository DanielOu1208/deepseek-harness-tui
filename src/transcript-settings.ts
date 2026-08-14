import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const TRANSCRIPT_DENSITIES = ['compact', 'normal', 'debug'] as const

export type TranscriptDensity = typeof TRANSCRIPT_DENSITIES[number]

export const DEFAULT_TRANSCRIPT_DENSITY: TranscriptDensity = 'normal'

export const TRANSCRIPT_DENSITY_PICKER_ITEMS = [
  { value: 'compact', label: 'Compact', description: 'Show a concise transcript' },
  { value: 'normal', label: 'Normal', description: 'Show standard transcript detail' },
  { value: 'debug', label: 'Debug', description: 'Show the most transcript detail' },
] as const satisfies ReadonlyArray<{
  value: TranscriptDensity
  label: string
  description: string
}>

export const TRANSCRIPT_SETTINGS_NAMESPACE = settingsNamespace('dsh-tui')

export interface TranscriptSettings {
  transcriptDensity: TranscriptDensity
}

export const TRANSCRIPT_SETTINGS_SCHEMA: z<TranscriptSettings> = z.object({
  transcriptDensity: z.union([...TRANSCRIPT_DENSITIES]).default(DEFAULT_TRANSCRIPT_DENSITY),
})
