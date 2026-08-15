import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUSY_PICKER_ITEMS,
  GOAL_PICKER_ITEMS,
  NESTED_MENU_COMMANDS,
  OTHER_ANSWER_VALUE,
  PERMISSION_PICKER_ITEMS,
  PLAN_PICKER_ITEMS,
  SETTINGS_PICKER_ITEMS,
  filterPickerItems,
  modelPickerItems,
  parseModelRef,
  parseSettingsPatch,
  questionLabelsFromValues,
  questionPickerItems,
  reasoningInitialValue,
  reasoningPickerItems,
  sessionPickerItems,
  settingsNamespacePickerItems,
  stepReasoningEffort,
} from '../src/interaction.js'

test('parses provider/model while preserving slashes in model ids', () => {
  assert.deepEqual(parseModelRef('openai/gpt-5/codex'), { provider: 'openai', model: 'gpt-5/codex' })
  assert.equal(parseModelRef('missing-separator'), undefined)
  assert.equal(parseModelRef('/missing-provider'), undefined)
})

test('preserves the current reasoning effort only when reselecting the same model', () => {
  const current = { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' }
  assert.equal(reasoningInitialValue(current, { provider: 'deepseek', model: 'v4' }), 'high')
  assert.equal(reasoningInitialValue(current, { provider: 'deepseek', model: 'v5' }), 'default')
})

test('uses internal question IDs so duplicate and sentinel-like labels stay independent', () => {
  const options = [{ label: '__other__' }, { label: 'Same' }, { label: 'Same' }]
  const items = questionPickerItems(options)
  assert.deepEqual(items.map(item => item.value), ['answer:0', 'answer:1', 'answer:2'])
  assert.equal(items.some(item => item.value === OTHER_ANSWER_VALUE), false)
  assert.deepEqual(questionLabelsFromValues(['answer:0', 'answer:2', OTHER_ANSWER_VALUE], options), [
    '__other__',
    'Same',
  ])
})

test('builds nested model picker items with provider-qualified values', () => {
  assert.deepEqual(modelPickerItems([
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', name: 'V4 Flash' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', name: 'V4 Pro' },
  ]), [
    { value: 'deepseek-official/deepseek-v4-flash', label: 'deepseek-v4-flash', description: 'deepseek-official · V4 Flash' },
    { value: 'deepseek-official/deepseek-v4-pro', label: 'deepseek-v4-pro', description: 'deepseek-official · V4 Pro' },
  ])
})

test('builds resume and permission picker items', () => {
  const sessions = sessionPickerItems([
    { id: 'session-new', title: 'New work', cwd: '/new', createdAt: 20, updatedAt: 30, current: true, running: false },
    { id: 'session-old', cwd: '/old', createdAt: 10, parentSession: 'session-parent' },
  ])
  assert.deepEqual(sessions.map(item => ({ value: item.value, label: item.label, searchText: item.searchText })), [
    { value: 'session-new', label: 'New work', searchText: 'New work session-new /new' },
    { value: 'session-old', label: 'Untitled session', searchText: 'session-old /old' },
  ])
  assert.match(sessions[0]?.description ?? '', /^Current · idle · .* · \/new · session-new$/)
  assert.match(sessions[1]?.description ?? '', /^Saved · .* · \/old · session-old · fork of session-parent$/)
  assert.deepEqual(PERMISSION_PICKER_ITEMS.map(item => item.value), [
    'read-only', 'workspace-write', 'danger-full-access',
  ])
})

test('accounts for every command with finite nested choices', () => {
  assert.deepEqual([...NESTED_MENU_COMMANDS].sort(), [
    'busy', 'goal', 'model', 'permission', 'plan', 'reasoning', 'resume', 'settings',
  ])
  assert.deepEqual(GOAL_PICKER_ITEMS.map(item => item.value), [
    'view', 'set', 'edit', 'clear', 'pause', 'resume',
  ])
  assert.deepEqual(PLAN_PICKER_ITEMS.map(item => item.value), [
    'enter', 'message', 'off',
  ])
})

test('filters nested autocomplete choices by value, label, or description', () => {
  const items = modelPickerItems([
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', name: 'V4 Flash' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', name: 'V4 Pro' },
  ])
  assert.deepEqual(filterPickerItems(items, 'pro').map(item => item.value), [
    'deepseek-official/deepseek-v4-pro',
  ])
  assert.equal(filterPickerItems(items, '').length, 2)
})

test('builds reasoning and busy-behavior picker choices', () => {
  assert.deepEqual(reasoningPickerItems({
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High', description: 'Think harder' },
    ],
    defaultEffort: 'low',
  }), [
    { value: 'default', label: 'Model default', description: 'Currently Low' },
    { value: 'low', label: 'Low', description: 'Model default' },
    { value: 'high', label: 'High', description: 'Think harder' },
  ])
  assert.deepEqual(BUSY_PICKER_ITEMS.map(item => item.value), ['queue', 'steer'])
  assert.ok(SETTINGS_PICKER_ITEMS.some(item => item.value === 'advanced'))
  assert.deepEqual(
    SETTINGS_PICKER_ITEMS.filter(item => ['providers', 'runtime', 'support'].includes(item.value)).map(item => item.value),
    ['providers', 'runtime', 'support'],
  )
  assert.deepEqual(
    SETTINGS_PICKER_ITEMS.find(item => item.value === 'transcript-density'),
    { value: 'transcript-density', label: 'Transcript detail', description: 'Choose how much transcript detail to show' },
  )
})

test('steps through actual reasoning levels from the effective model default and stops at boundaries', () => {
  const reasoning = {
    efforts: [
      { id: 'off', name: 'Off' },
      { id: 'high', name: 'High' },
      { id: 'max', name: 'Max' },
    ],
    defaultEffort: 'high',
  }
  assert.deepEqual(stepReasoningEffort(reasoning, undefined, 'increase'), { kind: 'change', effort: 'max' })
  assert.deepEqual(stepReasoningEffort(reasoning, undefined, 'decrease'), { kind: 'change', effort: 'off' })
  assert.deepEqual(stepReasoningEffort(reasoning, 'max', 'increase'), { kind: 'boundary', effort: 'max' })
  assert.deepEqual(stepReasoningEffort(reasoning, 'off', 'decrease'), { kind: 'boundary', effort: 'off' })
})

test('does not guess when reasoning capabilities omit the current effective level', () => {
  assert.deepEqual(stepReasoningEffort({ efforts: [] }, undefined, 'increase'), {
    kind: 'unavailable', reason: 'no-efforts',
  })
  assert.deepEqual(stepReasoningEffort({ efforts: [{ id: 'high', name: 'High' }] }, undefined, 'increase'), {
    kind: 'unavailable', reason: 'unknown-default',
  })
  assert.deepEqual(stepReasoningEffort({
    efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
  }, 'legacy', 'decrease'), {
    kind: 'unavailable', reason: 'unknown-current',
  })
})

test('builds redaction-safe advanced settings choices', () => {
  assert.deepEqual(settingsNamespacePickerItems([
    { ns: 'agent-loop', applies: 'live', revision: 2 },
    { ns: 'shell', applies: 'restart', revision: 7, secrets: [{ path: ['token'], set: true }] },
  ]), [
    { value: 'agent-loop', label: 'agent-loop', description: 'Live · revision 2' },
    { value: 'shell', label: 'shell', description: 'Restart required · revision 7 · contains hidden secrets' },
  ])
})

test('accepts only JSON objects as settings patches', () => {
  assert.deepEqual(parseSettingsPatch('{"maxParallelToolCalls":4}'), { maxParallelToolCalls: 4 })
  assert.throws(() => parseSettingsPatch('[1,2]'), /JSON object/)
  assert.throws(() => parseSettingsPatch('null'), /JSON object/)
})
