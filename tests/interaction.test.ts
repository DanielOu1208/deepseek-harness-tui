import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUSY_PICKER_ITEMS,
  GOAL_PICKER_ITEMS,
  NESTED_MENU_COMMANDS,
  PERMISSION_PICKER_ITEMS,
  PLAN_PICKER_ITEMS,
  SETTINGS_PICKER_ITEMS,
  filterPickerItems,
  modelPickerItems,
  parseModelRef,
  parseMultiAnswer,
  parseSettingsPatch,
  reasoningPickerItems,
  sessionPickerItems,
  settingsNamespacePickerItems,
} from '../src/interaction.js'

test('parses provider/model while preserving slashes in model ids', () => {
  assert.deepEqual(parseModelRef('openai/gpt-5/codex'), { provider: 'openai', model: 'gpt-5/codex' })
  assert.equal(parseModelRef('missing-separator'), undefined)
  assert.equal(parseModelRef('/missing-provider'), undefined)
})

test('splits multi-select labels from custom text', () => {
  assert.deepEqual(parseMultiAnswer('Read files, Run tests, add docs', ['Read files', 'Run tests']), {
    selected: ['Read files', 'Run tests'],
    custom: 'add docs',
  })
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
  assert.deepEqual(sessionPickerItems([
    { id: 'session-new', cwd: '/new', createdAt: 20 },
    { id: 'session-old', cwd: '/old', createdAt: 10 },
  ]), [
    { value: 'session-new', label: 'session-new', description: '/new' },
    { value: 'session-old', label: 'session-old', description: '/old' },
  ])
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
