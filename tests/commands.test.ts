import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSlashCommands, formatCommandHelp, parseInput } from '../src/commands.js'

test('parses local lifecycle commands and arguments', () => {
  assert.deepEqual(parseInput('/new'), { kind: 'local', name: 'new', argument: '' })
  assert.deepEqual(parseInput('/resume session-7'), { kind: 'local', name: 'resume', argument: 'session-7' })
  assert.deepEqual(parseInput('/model deepseek-official/deepseek-chat'), {
    kind: 'local', name: 'model', argument: 'deepseek-official/deepseek-chat',
  })
  assert.deepEqual(parseInput('/reasoning high'), { kind: 'local', name: 'reasoning', argument: 'high' })
  assert.deepEqual(parseInput('/busy queue'), { kind: 'local', name: 'busy', argument: 'queue' })
  assert.deepEqual(parseInput('/settings'), { kind: 'local', name: 'settings', argument: '' })
  assert.deepEqual(parseInput('/setting advanced'), { kind: 'local', name: 'settings', argument: 'advanced' })
})

test('passes official harness slash commands through untouched', () => {
  assert.deepEqual(parseInput('/compact now'), { kind: 'harness-command', line: '/compact now' })
  assert.deepEqual(parseInput('/goal ship it'), { kind: 'harness-command', line: '/goal ship it' })
})

test('plain input is a prompt', () => {
  assert.deepEqual(parseInput('fix the tests'), { kind: 'prompt', text: 'fix the tests' })
})

test('builds one discoverable slash-command catalog from local and Harness commands', () => {
  const commands = buildSlashCommands([
    { name: 'compact', description: 'Compact session context', input: { hint: '[focus]' } },
    { name: 'goal', description: 'Set the session goal', input: { hint: '<goal>' } },
    { name: 'permission', description: 'Harness duplicate should not replace the local command' },
  ])

  assert.deepEqual(commands.find(command => command.name === 'compact'), {
    name: 'compact', description: 'Compact session context', argumentHint: '[focus]',
  })
  assert.deepEqual(commands.find(command => command.name === 'goal'), {
    name: 'goal', description: 'Set the session goal', argumentHint: '<goal>',
  })
  assert.equal(commands.filter(command => command.name === 'permission').length, 1)
  assert.match(commands.find(command => command.name === 'permission')?.description ?? '', /permission mode/i)
  assert.ok(commands.some(command => command.name === 'resume'))
  assert.equal(commands.some(command => command.name === 'setting'), false)
  assert.match(commands.find(command => command.name === 'settings')?.description ?? '', /settings menu/i)
  assert.deepEqual(commands.map(command => command.name), [...commands.map(command => command.name)].sort())
})

test('formats the live command catalog for slash help', () => {
  const text = formatCommandHelp([
    { name: 'compact', description: 'Compact session context', argumentHint: '[focus]' },
    { name: 'exit', description: 'Flush and exit' },
  ])
  assert.match(text, /Available slash commands/)
  assert.match(text, /\/compact \[focus\].*Compact session context/)
  assert.match(text, /\/exit.*Flush and exit/)
  assert.match(text, /type \/ or press Tab/i)
})
