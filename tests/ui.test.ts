import test from 'node:test'
import assert from 'node:assert/strict'
import type { Component, Terminal } from '@earendil-works/pi-tui'
import { CtrlCExitGate, DeepSeekTui, StatusLine, createCommandAutocomplete, formatEntry, isSettingsShortcut, renderLaunchBanner, sanitizeTerminalText } from '../src/ui.js'

class FakeTerminal implements Terminal {
  columns = 100
  rows = 30
  kittyProtocolActive = false
  private onInput?: (data: string) => void
  start(onInput: (data: string) => void): void { this.onInput = onInput }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void { this.onInput?.(data) }
}

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

test('status line keeps agent configuration distinct at narrow widths and shows paused history', () => {
  const line = new StatusLine()
  line.setFollowingOutputProvider(() => false)
  line.update({
    sessionId: 'session-1234567890',
    entries: [],
    running: true,
    activeTools: [],
    todos: [],
    compacting: false,
    planMode: true,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    permissionPreset: 'workspace-write',
  })

  const narrow = line.render(55)[0] ?? ''
  assert.match(narrow, /deepseek-v4-flash/)
  assert.match(narrow, /r:high/)
  assert.match(narrow, /plan/)
  assert.match(narrow, /W/)
  assert.match(narrow, /End↑/)
  const wide = line.render(140)[0] ?? ''
  assert.match(wide, / │ /)
  assert.match(wide, /history ↑ · End to latest/)
})

test('status line bounds long model IDs so required narrow segments remain visible', () => {
  const line = new StatusLine()
  line.setFollowingOutputProvider(() => false)
  line.update({
    sessionId: 'session-1',
    entries: [],
    running: true,
    activeTools: [],
    todos: [],
    compacting: false,
    planMode: true,
    provider: 'deepseek-official',
    model: `model-${'x'.repeat(80)}`,
    reasoningEffort: 'high',
    permissionPreset: 'workspace-write',
  })
  const rendered = line.render(55)[0] ?? ''
  assert.match(rendered, /r:high/)
  assert.match(rendered, /plan/)
  assert.match(rendered, /W/)
  assert.match(rendered, /End↑/)
})

test('status line bounds custom permission names so the narrow End cue remains visible', () => {
  const line = new StatusLine()
  line.setFollowingOutputProvider(() => false)
  line.update({
    sessionId: 'session-1',
    entries: [],
    running: true,
    activeTools: [],
    todos: [],
    compacting: false,
    planMode: true,
    provider: 'deepseek-official',
    model: 'm',
    reasoningEffort: 'high',
    permissionPreset: `custom-permission-${'x'.repeat(60)}`,
  })
  const rendered = line.render(55)[0] ?? ''
  assert.match(rendered, /C/)
  assert.match(rendered, /End↑/)
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

test('keeps launch header, projected entries, and local results in arrival order', () => {
  const ui = new DeepSeekTui(new FakeTerminal())
  ui.appendLaunchBanner('session-1', '/work')
  ui.renderProjection({
    sessionId: 'session-1', entries: [{
      id: 'assistant:1', role: 'assistant', kind: 'text', text: 'first', streaming: true,
    }], running: true, activeTools: [], todos: [], compacting: false, planMode: false,
  })
  ui.appendNotice('local result')
  ui.renderProjection({
    sessionId: 'session-1', entries: [
      { id: 'assistant:1', role: 'assistant', kind: 'text', text: 'first done', streaming: false },
      { id: 'assistant:2', role: 'assistant', kind: 'text', text: 'second', streaming: true },
    ], running: true, activeTools: [], todos: [], compacting: false, planMode: false,
  })

  const children = (ui as unknown as { transcript: { children: Component[] } }).transcript.children
  const text = children.map(child => child.render(100).join('\n'))
  assert.match(text[0] ?? '', /DeepSeek Harness TUI/)
  assert.match(text[1] ?? '', /first done/)
  assert.match(text[2] ?? '', /local result/)
  assert.match(text[3] ?? '', /second/)
})

test('renders choices above the composer without adding their prompt to history', async () => {
  const ui = new DeepSeekTui(new FakeTerminal())
  ui.appendLaunchBanner('session-1', '/work')
  const before = (ui as unknown as { transcript: { children: Component[] } }).transcript.children.length
  const pending = ui.choose('Choose a model', [{ value: 'a', label: 'A' }])
  const panel = (ui as unknown as { interactionHost: { children: Component[] } }).interactionHost.children
  assert.ok(panel.length >= 2)
  assert.match(panel[0]?.render(80).join('\n') ?? '', /Choose a model/)
  assert.equal((ui as unknown as { transcript: { children: Component[] } }).transcript.children.length, before)
  ;(ui as unknown as { activeInteraction: { cancel(): void } }).activeInteraction.cancel()
  assert.equal(await pending, undefined)
})

test('checkbox choices toggle with Space and submit with Enter', async () => {
  const ui = new DeepSeekTui(new FakeTerminal())
  const pending = ui.chooseMany('Choose several', [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ])
  const focused = ui.tui.getFocusedComponent()
  focused?.handleInput?.(' ')
  focused?.handleInput?.('\u001b[B')
  focused?.handleInput?.(' ')
  focused?.handleInput?.('\r')
  assert.deepEqual((await pending)?.map(item => item.value), ['a', 'b'])
})

test('Pi settings list shows current values and reopens on the previous row', async () => {
  const ui = new DeepSeekTui(new FakeTerminal())
  const pending = ui.chooseSetting('Core settings', [
    { id: 'model', label: 'Model', currentValue: 'deepseek-v4' },
    { id: 'busy', label: 'Busy Enter', currentValue: 'queue' },
  ], undefined, 'busy')
  const focused = ui.tui.getFocusedComponent()
  const rendered = focused?.render(80).join('\n') ?? ''
  assert.match(rendered, /Busy Enter/)
  assert.match(rendered, /queue/)
  focused?.handleInput?.('\r')
  assert.equal(await pending, 'busy')
})

test('routes Escape to the panel and Ctrl+C to both panel cancellation and agent interruption', async () => {
  const terminal = new FakeTerminal()
  const ui = new DeepSeekTui(terminal)
  let interrupts = 0
  let exits = 0
  ui.start({
    onPrompt: () => {},
    onSettings: () => {},
    onInterrupt: () => { interrupts += 1 },
    onExit: () => { exits += 1 },
  })

  const escaped = ui.choose('Optional menu', [{ value: 'a', label: 'A' }])
  terminal.send('\u001b')
  assert.equal(await escaped, undefined)
  assert.equal(interrupts, 0)

  const interrupted = ui.choose('Optional menu', [{ value: 'a', label: 'A' }])
  terminal.send('\u0003')
  assert.equal(await interrupted, undefined)
  assert.equal(interrupts, 1)
  assert.equal(exits, 0)
  terminal.send('\u0003')
  assert.equal(exits, 1)
  ui.stop()
})

test('required prompts replace optional input and restore the original composer draft', async () => {
  const ui = new DeepSeekTui(new FakeTerminal())
  ui.editor.setText('composer draft')
  const optional = ui.promptText('Optional command input')
  ui.editor.setText('unfinished optional answer')
  const required = ui.choose('Required approval', [
    { value: 'reject', label: 'Reject' },
    { value: 'allow', label: 'Allow' },
  ], undefined, { priority: 'required', initialValue: 'reject' })

  assert.equal(await optional, undefined)
  assert.equal(ui.editor.getText(), 'composer draft')
  ;(ui as unknown as { activeInteraction: { cancel(): void } }).activeInteraction.cancel()
  assert.equal(await required, undefined)
  assert.equal(ui.editor.getText(), 'composer draft')
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
  assert.match(banner, /\/ commands/)
  assert.match(banner, /F2 settings/)
  assert.match(banner, /\/work\/project/)
  assert.ok(Math.max(...plain.split('\n').map(line => line.length)) <= 88)
})
