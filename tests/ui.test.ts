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
  }) ?? '', /Thinking.*checking/s)
  assert.match(formatEntry({
    id: 't', role: 'tool', kind: 'tool', text: 'bash', detail: 'ok', streaming: false,
  }) ?? '', /bash.*ok/s)
  const diff = formatEntry({
    id: 'd', role: 'tool', kind: 'tool', text: 'Edit src/a.ts', streaming: false,
    diffs: [{ path: 'src/a.ts', oldText: 'context\nbefore', newText: 'context\nafter' }],
  }, 'debug') ?? ''
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
  }) ?? ''
  assert.doesNotMatch(rendered, /\u001b\]52|\u0007|\u009d/u)
  assert.match(rendered, /beforeredafter/)

  const context = formatEntry({
    id: 'unsafe-context', role: 'system', kind: 'text', text: 'hidden', streaming: false,
    context: {
      form: 'instructions', sourceKind: 'plugin', label: `plugin${unsafe}`,
      summary: `Plugin context${unsafe}`,
    },
  }, 'debug') ?? ''
  const tool = formatEntry({
    id: 'unsafe-tool', role: 'tool', kind: 'tool', text: `tool${unsafe}`, streaming: false,
    toolPresentation: { card: 'terminal', summary: `exit 0${unsafe}` },
  }, 'normal') ?? ''
  assert.doesNotMatch(`${context}${tool}`, /\u001b\]52|\u0007|\u009d/u)
})

test('applies compact, normal, and debug transcript density rules', () => {
  const completedReasoning = {
    id: 'reasoning', role: 'assistant' as const, kind: 'reasoning' as const,
    text: 'one\ntwo\nthree\nfour', streaming: false,
  }
  assert.match(formatEntry(completedReasoning, 'compact') ?? '', /Thinking · 4 lines/)
  assert.doesNotMatch(formatEntry(completedReasoning, 'normal') ?? '', /one|four/)
  assert.match(formatEntry(completedReasoning, 'debug') ?? '', /one.*four/s)

  const runningReasoning = { ...completedReasoning, streaming: true }
  assert.doesNotMatch(formatEntry(runningReasoning, 'compact') ?? '', /one|four/)
  assert.doesNotMatch(formatEntry(runningReasoning, 'normal') ?? '', /one/)
  assert.match(formatEntry(runningReasoning, 'normal') ?? '', /two.*four/s)

  const tool = {
    id: 'tool', role: 'tool' as const, kind: 'tool' as const,
    text: 'npm test', detail: 'first\nsecond', streaming: false,
    toolPresentation: { card: 'terminal' as const, summary: 'exit 0 · 2 lines' },
  }
  assert.doesNotMatch(formatEntry(tool, 'compact') ?? '', /exit 0|first/)
  assert.match(formatEntry(tool, 'normal') ?? '', /exit 0 · 2 lines/)
  assert.doesNotMatch(formatEntry(tool, 'normal') ?? '', /first/)
  assert.match(formatEntry(tool, 'debug') ?? '', /first.*second/s)

  const runningTool = { ...tool, streaming: true }
  assert.doesNotMatch(formatEntry(runningTool, 'normal') ?? '', /first/)
  assert.match(formatEntry(runningTool, 'debug') ?? '', /first.*second/s)
})

test('summarizes semantic context without parsing its model-facing body', () => {
  const context = {
    id: 'context', role: 'system' as const, kind: 'text' as const,
    text: '<skill_content>secret instructions</skill_content>', streaming: false,
    context: {
      form: 'instructions' as const,
      sourceKind: 'skill-invocation',
      label: 'frontend-design',
      summary: 'Skill loaded · frontend-design',
    },
  }
  assert.match(formatEntry(context, 'normal') ?? '', /Skill loaded · frontend-design/)
  assert.doesNotMatch(formatEntry(context, 'normal') ?? '', /secret instructions/)
  assert.match(formatEntry(context, 'debug') ?? '', /secret instructions/)

  const relay = {
    ...context,
    id: 'relay',
    text: 'The worker found three failures in the parser.',
    context: { form: 'relay' as const, sourceKind: 'subagent-report', label: 'subagent-report', summary: 'Agent message · subagent-report' },
  }
  assert.doesNotMatch(formatEntry(relay, 'compact') ?? '', /three failures/)
  assert.match(formatEntry(relay, 'normal') ?? '', /three failures/)
})

test('keeps errors useful and bounds normal and debug detail', () => {
  const detail = Array.from({ length: 450 }, (_, index) => `line ${String(index + 1)}`).join('\n')
  const failed = {
    id: 'failed', role: 'tool' as const, kind: 'tool' as const,
    text: 'failing command', detail, streaming: false, error: true,
  }
  const normal = formatEntry(failed, 'normal') ?? ''
  assert.match(normal, /earlier lines omitted/)
  assert.doesNotMatch(normal, /line 1\b/)
  assert.match(normal, /line 450/)

  const debug = formatEntry({ ...failed, error: false }, 'debug') ?? ''
  assert.match(debug, /lines omitted/)
  assert.match(debug, /line 1\b/)
  assert.match(debug, /line 450/)

  const systemFailure = {
    id: 'system-failure', role: 'system' as const, kind: 'text' as const,
    text: detail, streaming: false, error: true,
  }
  assert.doesNotMatch(formatEntry(systemFailure, 'normal') ?? '', /line 1\b/)
  assert.match(formatEntry(systemFailure, 'normal') ?? '', /line 450/)
  assert.match(formatEntry(systemFailure, 'debug') ?? '', /line 1\b/)
})

test('bounds debug diffs by source size, file count, and final rendered detail', () => {
  const huge = `${'a'.repeat(20_000)}\n${'b'.repeat(20_000)}`
  const diffs = Array.from({ length: 25 }, (_, index) => ({
    path: `src/file-${String(index)}.ts`,
    oldText: huge,
    newText: `${huge}changed`,
  }))
  const rendered = formatEntry({
    id: 'large-diff', role: 'tool', kind: 'tool', text: 'Edit files', detail: huge, streaming: false, diffs,
    toolPresentation: { card: 'diff' },
  }, 'debug') ?? ''

  assert.match(rendered, /files omitted/)
  assert.match(rendered, /source omitted/)
  assert.ok(rendered.length < 41_000)
})

test('hides routine state outside debug and compacts todo state in normal', () => {
  const routine = {
    id: 'routine', role: 'system' as const, kind: 'text' as const,
    text: 'Plan mode enabled', streaming: false, systemKind: 'routine' as const,
  }
  assert.equal(formatEntry(routine, 'compact'), undefined)
  assert.equal(formatEntry(routine, 'normal'), undefined)
  assert.match(formatEntry(routine, 'debug') ?? '', /Plan mode enabled/)

  const todo = {
    id: 'todo', role: 'system' as const, kind: 'text' as const,
    text: 'Todos\n- [ ] Test', streaming: false, systemKind: 'todo' as const,
    systemSummary: 'Todos · 1 active',
  }
  assert.equal(formatEntry(todo, 'compact'), undefined)
  assert.match(formatEntry(todo, 'normal') ?? '', /Todos · 1 active/)
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
    contextWindow: { usedTokens: 42_000, capacityTokens: 1_000_000 },
    usage: { inputTokens: 100, outputTokens: 25 },
  })

  const rendered = line.render(140)
  assert.equal(rendered.length, 1)
  assert.match(rendered[0]!, /running/)
  assert.match(rendered[0]!, /bash/)
  assert.match(rendered[0]!, /high/)
  assert.match(rendered[0]!, /ctx ~42K\/1M \(4%\)/)
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
    contextWindow: { usedTokens: 42_000, capacityTokens: 1_000_000 },
  })

  const narrow = line.render(55)[0] ?? ''
  assert.match(narrow, /deepseek-v4-flash/)
  assert.match(narrow, /r:high/)
  assert.match(narrow, /plan/)
  assert.match(narrow, /W/)
  assert.match(narrow, /c:~42K\/1M/)
  assert.match(narrow, /End↑/)
  const veryNarrow = line.render(40)[0] ?? ''
  assert.doesNotMatch(veryNarrow, /c:/)
  assert.match(veryNarrow, /r:high/)
  assert.match(veryNarrow, /plan/)
  assert.match(veryNarrow, /W/)
  assert.match(veryNarrow, /run/)
  assert.match(veryNarrow, /End↑/)
  const wide = line.render(140)[0] ?? ''
  assert.match(wide, / │ /)
  assert.match(wide, /history ↑ · End to latest/)
})

test('shows model capacity before the first usage sample and caps displayed occupancy at 100 percent', () => {
  const line = new StatusLine()
  const base = {
    sessionId: 'session-1', entries: [], running: false, activeTools: [], todos: [], compacting: false,
    planMode: false, provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
    permissionPreset: 'workspace-write',
  }
  line.update({ ...base, contextWindow: { capacityTokens: 1_000_000 } })
  assert.match(line.render(140)[0] ?? '', /ctx —\/1M/)

  line.update({ ...base, contextWindow: { usedTokens: 1_500_000, capacityTokens: 1_000_000 } })
  assert.match(line.render(140)[0] ?? '', /ctx ~1\.5M\/1M \(100%\)/)
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

test('reveals hidden rows in their original position when density changes', () => {
  const ui = new DeepSeekTui(new FakeTerminal())
  ui.appendLaunchBanner('session-1', '/work')
  const routine = {
    id: 'system:plan:1', role: 'system' as const, kind: 'text' as const,
    text: 'Plan mode enabled', streaming: false, systemKind: 'routine' as const,
  }
  ui.renderProjection({
    sessionId: 'session-1',
    entries: [routine, { id: 'assistant:1', role: 'assistant', kind: 'text', text: 'first', streaming: false }],
    running: false, activeTools: [], todos: [], compacting: false, planMode: true,
  })
  ui.appendNotice('local result')
  ui.renderProjection({
    sessionId: 'session-1',
    entries: [
      routine,
      { id: 'assistant:1', role: 'assistant', kind: 'text', text: 'first', streaming: false },
      { id: 'assistant:2', role: 'assistant', kind: 'text', text: 'second', streaming: false },
    ],
    running: false, activeTools: [], todos: [], compacting: false, planMode: true,
  })

  const children = (ui as unknown as { transcript: { children: Component[] } }).transcript.children
  assert.equal(children[1]?.render(100).length, 0)
  ui.setTranscriptDensity('debug')
  const debug = children.map(child => child.render(100).join('\n'))
  assert.match(debug[1] ?? '', /Plan mode enabled/)
  assert.match(debug[2] ?? '', /first/)
  assert.match(debug[3] ?? '', /local result/)
  assert.match(debug[4] ?? '', /second/)
  ui.setTranscriptDensity('normal')
  assert.equal(children[1]?.render(100).length, 0)
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

test('routes mode and reasoning shortcuts without changing the composer draft', async () => {
  const terminal = new FakeTerminal()
  const ui = new DeepSeekTui(terminal)
  const actions: string[] = []
  ui.start({
    onPrompt: () => {},
    onSettings: () => {},
    onTogglePlanMode: () => { actions.push('plan') },
    onReasoningStep: direction => { actions.push(direction) },
    onInterrupt: () => {},
    onExit: () => {},
  })
  ui.editor.setText('keep this draft')

  terminal.send('\u001b[Z')
  terminal.send('\u001b[1;2A')
  terminal.send('\u001b[b')
  terminal.send('\u001b[1;2:3A')

  assert.deepEqual(actions, ['plan', 'increase', 'decrease'])
  assert.equal(ui.editor.getText(), 'keep this draft')
  ui.stop()
})

test('locks composer edits and submissions during a session transition while preserving Ctrl+C', () => {
  const terminal = new FakeTerminal()
  const ui = new DeepSeekTui(terminal)
  const prompts: string[] = []
  let interrupts = 0
  ui.start({
    onPrompt: text => { prompts.push(text) },
    onSettings: () => {},
    onInterrupt: () => { interrupts += 1 },
    onExit: () => {},
  })
  ui.editor.setText('draft for current session')
  ui.setComposerLocked(true)

  for (const character of ' unsafe') terminal.send(character)
  terminal.send('\r')
  assert.equal(ui.getComposerText(), 'draft for current session')
  assert.deepEqual(prompts, [])

  terminal.send('\u0003')
  assert.equal(interrupts, 1)
  ui.setComposerLocked(false)
  terminal.send('!')
  assert.equal(ui.getComposerText(), 'draft for current session!')
  ui.stop()
})

test('routes image paste without changing the draft and blocks it during dialogs', async () => {
  const terminal = new FakeTerminal()
  const ui = new DeepSeekTui(terminal)
  let pastes = 0
  ui.start({
    onPrompt: () => {},
    onSettings: () => {},
    onPasteImage: () => { pastes += 1 },
    onInterrupt: () => {},
    onExit: () => {},
  })
  ui.editor.setText('keep this draft')
  terminal.send('\u0016')
  assert.equal(pastes, 1)
  assert.equal(ui.editor.getText(), 'keep this draft')

  const dialog = ui.choose('Current dialog', [{ value: 'a', label: 'A' }])
  terminal.send('\u0016')
  assert.equal(pastes, 1)
  terminal.send('\u001b')
  assert.equal(await dialog, undefined)
  ui.stop()
})

test('blocks mode and reasoning shortcuts while a dialog is active', async () => {
  const terminal = new FakeTerminal()
  const ui = new DeepSeekTui(terminal)
  let actions = 0
  ui.start({
    onPrompt: () => {},
    onSettings: () => {},
    onTogglePlanMode: () => { actions += 1 },
    onReasoningStep: () => { actions += 1 },
    onInterrupt: () => {},
    onExit: () => {},
  })
  const dialog = ui.choose('Current dialog', [{ value: 'a', label: 'A' }])

  terminal.send('\u001b[Z')
  terminal.send('\u001b[1;2A')
  assert.equal(actions, 0)

  terminal.send('\u001b')
  assert.equal(await dialog, undefined)
  ui.stop()
})

test('searches picker metadata without changing the composer draft', async () => {
  const terminal = new FakeTerminal()
  const ui = new DeepSeekTui(terminal)
  ui.start({
    onPrompt: () => {},
    onSettings: () => {},
    onInterrupt: () => {},
    onExit: () => {},
  })
  ui.editor.setText('keep this draft')

  const pending = ui.chooseSearchable('Sessions', [
    { value: 'session-current', label: 'Current work', searchText: 'Current work session-current /work/current' },
    { value: 'session-old', label: 'Refactor parser', searchText: 'Refactor parser session-old /work/compiler' },
  ], undefined, { initialValue: 'session-current' })
  for (const character of 'compiler') terminal.send(character)
  terminal.send('\r')

  assert.equal((await pending)?.value, 'session-old')
  assert.equal(ui.editor.getText(), 'keep this draft')

  const titleSearch = ui.chooseSearchable('Sessions', [
    { value: 'session-current', label: 'Current work', searchText: 'Current work session-current /work/current' },
    { value: 'session-old', label: 'Refactor parser', searchText: 'Refactor parser session-old /work/compiler' },
  ])
  for (const character of 'refactor') terminal.send(character)
  terminal.send('\r')
  assert.equal((await titleSearch)?.value, 'session-old')
  ui.stop()
})

test('preselects the current searchable item and sanitizes untrusted rows', async () => {
  const terminal = new FakeTerminal()
  const ui = new DeepSeekTui(terminal)
  ui.start({
    onPrompt: () => {},
    onSettings: () => {},
    onInterrupt: () => {},
    onExit: () => {},
  })
  const unsafe = '\u001b]52;c;VEVTVA==\u0007'
  const pending = ui.chooseSearchable('Sessions', [
    { value: 'other', label: `Other${unsafe}`, description: `unsafe${unsafe}` },
    { value: 'current', label: `Current${unsafe}`, searchText: `current${unsafe}` },
  ], undefined, { initialValue: 'current' })
  const rendered = ui.tui.getFocusedComponent()?.render(80).join('\n') ?? ''
  assert.doesNotMatch(rendered, /\u001b\]52|VEVTVA/u)
  terminal.send('\r')
  assert.equal((await pending)?.value, 'current')
  ui.stop()
})

test('keeps a searchable picker open on no matches and lets Escape cancel it', async () => {
  const terminal = new FakeTerminal()
  const ui = new DeepSeekTui(terminal)
  ui.start({
    onPrompt: () => {},
    onSettings: () => {},
    onInterrupt: () => {},
    onExit: () => {},
  })
  const pending = ui.chooseSearchable('Sessions', [
    { value: 'session-one', label: 'One session' },
  ], undefined, { emptyText: 'No matching sessions' })
  for (const character of 'missing') terminal.send(character)
  const rendered = ui.tui.getFocusedComponent()?.render(80).join('\n') ?? ''
  assert.match(rendered, /No matching sessions/)
  terminal.send('\r')
  terminal.send('\u001b')
  assert.equal(await pending, undefined)
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

test('text dialogs preserve expanded large-paste drafts without publishing an empty draft', async () => {
  const terminal = new FakeTerminal()
  const ui = new DeepSeekTui(terminal)
  const draftChanges: string[] = []
  ui.start({
    onPrompt: () => {},
    onDraftChange: text => { draftChanges.push(text) },
    onSettings: () => {},
    onInterrupt: () => {},
    onExit: () => {},
  })
  const pasted = Array.from({ length: 12 }, (_, index) => `line ${String(index + 1)}`).join('\n')
  terminal.send(`\u001b[200~${pasted}\u001b[201~`)
  assert.match(ui.editor.getText(), /^\[paste #1 /u)
  assert.equal(ui.getComposerText(), pasted)
  assert.equal(draftChanges.at(-1), pasted)

  const changesBeforeDialog = draftChanges.length
  const prompt = ui.promptText('Temporary answer')
  assert.equal(draftChanges.length, changesBeforeDialog)
  terminal.send('\u001b')
  assert.equal(await prompt, undefined)
  assert.equal(ui.getComposerText(), pasted)
  assert.equal(draftChanges.length, changesBeforeDialog)
  assert.equal(draftChanges.includes(''), false)
  ui.stop()
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
  assert.match(banner, /Shift\+Tab plan\/build/)
  assert.match(banner, /Shift\+↑\/↓ reasoning/)
  assert.match(banner, /\/work\/project/)
  assert.ok(Math.max(...plain.split('\n').map(line => line.length)) <= 88)
})
