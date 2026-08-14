import test from 'node:test'
import assert from 'node:assert/strict'
import { ControlBar, CtrlCExitGate, StatusLine, createCommandAutocomplete, formatEntry, isSettingsShortcut, renderLaunchBanner, sanitizeTerminalText } from '../src/ui.js'

test('formats reasoning and tool entries distinctly', () => {
  assert.match(formatEntry({
    id: 'r', role: 'assistant', kind: 'reasoning', text: 'checking', streaming: true,
  }), /Thinking.*checking/s)
  assert.match(formatEntry({
    id: 't', role: 'tool', kind: 'tool', text: 'bash', detail: 'ok', streaming: false,
  }), /bash.*ok/s)
  const diff = formatEntry({
    id: 'd', role: 'tool', kind: 'tool', text: 'Edit src/a.ts', streaming: false,
    diffs: [{ path: 'src/a.ts', oldText: 'context\nbefore', newText: 'context\nafter' }],
  })
  assert.match(diff, /```diff/)
  assert.match(diff, /--- src\/a\.ts/)
  assert.match(diff, / context/)
  assert.match(diff, /-before/)
  assert.match(diff, /\+after/)
})

test('strips untrusted terminal control sequences before rendering', () => {
  const unsafe = [
    'before',
    '\u001b]52;c;VEVTVA==\u0007',
    '\u001b[31mred\u001b[0m',
    '\u009d8;;https://evil.invalid\u009c',
    '\u001bPdevice-control\u001b\\',
    '\u001bXstart-of-string\u001b\\',
    '\u001b^privacy-message\u001b\\',
    '\u001b_application-command\u001b\\',
    '\u0090c1-device-control\u009c',
    '\u0000after',
  ].join('')

  assert.equal(sanitizeTerminalText(unsafe), 'beforeredafter')
  assert.equal(sanitizeTerminalText(`safe\u001b]52;c;unterminated`), 'safe')
  assert.equal(sanitizeTerminalText('\u001b]'.repeat(16_000)), '')

  const rendered = formatEntry({
    id: 'unsafe',
    role: 'assistant',
    kind: 'text',
    text: unsafe,
    streaming: false,
  })
  assert.doesNotMatch(rendered, /\u001b\]52|\u0007|\u009d/u)
  assert.match(rendered, /beforeredafter/)
})

test('status line includes session, model, work, and token usage within width', () => {
  const line = new StatusLine()
  line.update({
    sessionId: 'session-1234567890',
    entries: [],
    running: true,
    activeTools: [{ id: '1', name: 'bash' }],
    todos: [],
    compacting: false,
    planMode: false,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    usage: { inputTokens: 100, outputTokens: 25 },
  })

  const rendered = line.render(140)
  assert.equal(rendered.length, 1)
  assert.match(rendered[0]!, /running/)
  assert.match(rendered[0]!, /bash/)
  assert.match(rendered[0]!, /high/)
  assert.match(rendered[0]!, /100→25/)
})

test('renders an always-visible settings control bar', () => {
  const rendered = new ControlBar().render(80)
  assert.equal(rendered.length, 1)
  assert.match(rendered[0]!, /F2 Settings/)
  assert.match(rendered[0]!, /Ctrl\+C Stop/)
  assert.match(rendered[0]!, /×2 Exit/)
})

test('requires two quick Ctrl+C presses to exit', () => {
  const gate = new CtrlCExitGate(1_500)
  assert.equal(gate.press(1_000), 'interrupt')
  assert.equal(gate.press(2_000), 'exit')
  assert.equal(gate.press(5_000), 'interrupt')
  assert.equal(gate.press(7_000), 'interrupt')
  gate.reset()
  assert.equal(gate.press(7_100), 'interrupt')
})

test('recognizes common terminal encodings for the settings key', () => {
  assert.equal(isSettingsShortcut('\u001bOQ'), true)
  assert.equal(isSettingsShortcut('\u001b[12~'), true)
  assert.equal(isSettingsShortcut('s'), false)
})

test('slash autocomplete opens on slash and completes command names', async () => {
  const provider = createCommandAutocomplete([
    { name: 'compact', description: 'Compact context', argumentHint: '[focus]' },
    { name: 'goal', description: 'Set goal', argumentHint: '<goal>' },
  ], '/tmp')
  const suggestions = await provider.getSuggestions(['/'], 0, 1, {
    signal: new AbortController().signal,
  })

  assert.deepEqual(suggestions?.items.map(item => item.value), ['compact', 'goal'])
  assert.equal(suggestions?.prefix, '/')
  const filtered = await provider.getSuggestions(['/co'], 0, 3, {
    signal: new AbortController().signal,
  })
  assert.deepEqual(
    provider.applyCompletion(['/co'], 0, 3, filtered!.items[0]!, filtered!.prefix),
    { lines: ['/compact '], cursorLine: 0, cursorCol: 9 },
  )
})

test('sanitizes autocomplete values and labels from plugins or filenames', async () => {
  const osc = '\u001b]52;c;VEVTVA==\u0007'
  const provider = createCommandAutocomplete([{
    name: 'unsafe',
    description: `description${osc}`,
    argumentHint: '<value>',
    getArgumentCompletions: () => [{
      value: `value${osc}`,
      label: `label${osc}`,
      description: `detail${osc}`,
    }],
  }], '/tmp')
  const suggestions = await provider.getSuggestions(['/unsafe v'], 0, 9, {
    signal: new AbortController().signal,
  })

  assert.deepEqual(suggestions?.items, [{
    value: 'value',
    label: 'label',
    description: 'detail',
  }])
})

test('launch banner uses the official DeepSeek whale and wordmark raster', () => {
  const banner = renderLaunchBanner('session-123', '/work/project')
  assert.match(banner, /\u001b\[38;2;77;107;254m/)
  const plain = banner.replace(/\u001b\[[0-9;]*m/g, '')
  assert.match(plain, /██████████████▄ ▀██████▀/)
  assert.match(plain, /██▀▀▀████████████▄▄██▀▀/)
  assert.doesNotMatch(plain, /D E E P S E E K/)
  assert.match(plain, /DeepSeek Harness TUI/)
  assert.match(banner, /session-123/)
  assert.match(banner, /\/ for commands/)
  assert.match(banner, /F2 settings/)
  assert.match(banner, /\/work\/project/)
  assert.ok(Math.max(...plain.split('\n').map(line => line.length)) <= 88)
})
