import test from 'node:test'
import assert from 'node:assert/strict'
import { DshTuiRunner } from '../src/index.js'
import {
  DEFAULT_TRANSCRIPT_DENSITY,
  TRANSCRIPT_DENSITIES,
  TRANSCRIPT_DENSITY_PICKER_ITEMS,
  TRANSCRIPT_SETTINGS_NAMESPACE,
  TRANSCRIPT_SETTINGS_SCHEMA,
  type TranscriptSettings,
} from '../src/transcript-settings.js'

test('defines the persistent transcript-density settings contract', () => {
  assert.equal(String(TRANSCRIPT_SETTINGS_NAMESPACE), 'dsh-tui')
  assert.deepEqual(TRANSCRIPT_DENSITIES, ['compact', 'normal', 'debug'])
  assert.equal(DEFAULT_TRANSCRIPT_DENSITY, 'normal')
  assert.deepEqual(
    TRANSCRIPT_DENSITY_PICKER_ITEMS.map(item => ({ value: item.value, label: item.label })),
    [
      { value: 'compact', label: 'Compact' },
      { value: 'normal', label: 'Normal' },
      { value: 'debug', label: 'Debug' },
    ],
  )
})

test('defaults transcript density to normal and rejects unknown values', () => {
  assert.deepEqual(TRANSCRIPT_SETTINGS_SCHEMA({}), { transcriptDensity: 'normal' })
  assert.deepEqual(TRANSCRIPT_SETTINGS_SCHEMA({ transcriptDensity: 'debug' }), { transcriptDensity: 'debug' })
  assert.throws(() => TRANSCRIPT_SETTINGS_SCHEMA({ transcriptDensity: 'verbose' }))
})

test('runner applies the stored value and committed live changes, then disposes its watcher', async () => {
  let current: TranscriptSettings = { transcriptDensity: 'normal' }
  let watcher: ((next: TranscriptSettings) => void) | undefined
  let disposed = false
  const applied: string[] = []
  const scope = {
    get: () => current,
    watch: (callback: typeof watcher) => {
      watcher = callback
      return () => { disposed = true; watcher = undefined }
    },
    update: async () => {},
    replace: async () => {},
  }
  const ui = { setTranscriptDensity: (density: string) => applied.push(density) }
  const runner = new DshTuiRunner({} as never, {}, ui as never, scope as never)

  current = { transcriptDensity: 'debug' }
  watcher?.(current)
  await runner.shutdown(false)

  assert.deepEqual(applied, ['normal', 'debug'])
  assert.equal(disposed, true)
})

test('density selection waits for a successful settings update and relies on the watcher to apply it', async () => {
  let watcher: ((next: TranscriptSettings) => void) | undefined
  const applied: string[] = []
  const scope = {
    get: () => ({ transcriptDensity: 'normal' as const }),
    watch: (callback: typeof watcher) => {
      watcher = callback
      return () => { watcher = undefined }
    },
    update: async (patch: { transcriptDensity?: string }) => {
      watcher?.({ transcriptDensity: patch.transcriptDensity as 'compact' })
    },
    replace: async () => {},
  }
  const ui = {
    setTranscriptDensity: (density: string) => applied.push(density),
    choose: async () => ({ value: 'compact', label: 'Compact' }),
    appendNotice: () => {},
  }
  const runner = new DshTuiRunner({} as never, {}, ui as never, scope as never)

  await (runner as unknown as { selectTranscriptDensity(): Promise<void> }).selectTranscriptDensity()

  assert.deepEqual(applied, ['normal', 'compact'])
})
