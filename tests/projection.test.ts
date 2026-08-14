import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjection, foldSessionEvent } from '../src/projection.js'

test('folds streamed assistant chunks into one live transcript entry', () => {
  let state = createProjection('session-1')
  state = foldSessionEvent(state, {
    seq: 0,
    time: 10,
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hel' } },
  })
  state = foldSessionEvent(state, {
    seq: 1,
    time: 11,
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo' } },
  })

  assert.deepEqual(state.entries, [{
    id: 'assistant:1:1:text:0',
    role: 'assistant',
    kind: 'text',
    text: 'hello',
    streaming: true,
  }])
})

test('resets failed assistant partials on retry and freezes leftovers when a turn ends', () => {
  let state = createProjection('session-1')
  state = foldSessionEvent(state, {
    seq: 1, time: 1, type: 'assistant/chunk',
    data: { turn: 2, step: 3, chunk: { type: 'text-delta', index: 0, text: 'failed attempt' } },
  })
  state = foldSessionEvent(state, {
    seq: 2, time: 2, type: 'llm/retry',
    data: { retryId: 'retry-1', turn: 2, step: 3, provider: 'deepseek', retry: 1, maxRetries: 2, delayMs: 10 },
  })
  assert.equal(state.entries.some(entry => entry.text === 'failed attempt'), false)

  state = foldSessionEvent(state, {
    seq: 3, time: 3, type: 'assistant/chunk',
    data: { turn: 2, step: 3, chunk: { type: 'text-delta', index: 0, text: 'partial' } },
  })
  state = foldSessionEvent(state, {
    seq: 4, time: 4, type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  assert.equal(state.entries.find(entry => entry.text === 'partial')?.streaming, false)
})

test('ignores model-only surface replacements in the human transcript', () => {
  let state = foldSessionEvent(createProjection('session-1'), {
    seq: 1,
    time: 1,
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Original prompt' }] },
  })
  state = foldSessionEvent(state, {
    seq: 2,
    time: 2,
    type: 'user/message',
    surfaceOp: { op: 'replace', start: 1, end: 1 },
    data: { source: { kind: 'compaction' }, content: [{ type: 'text', text: 'Model-only summary' }] },
  })
  assert.deepEqual(state.entries.map(entry => entry.text), ['Original prompt'])
})

test('captures live usage chunks and clears prior-turn todos on turn start', () => {
  let state = foldSessionEvent(createProjection('session-1'), {
    seq: 1, time: 1, type: 'todo/write', data: { todos: [{ content: 'Old turn', status: 'pending' }] },
  })
  state = foldSessionEvent(state, {
    seq: 2,
    time: 2,
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } } },
  })
  assert.deepEqual(state.usage, { inputTokens: 7, outputTokens: 3 })
  state = foldSessionEvent(state, { seq: 3, time: 3, type: 'turn/start', data: { turn: 2 } })
  assert.deepEqual(state.todos, [])
  assert.equal(state.entries.some(entry => entry.id === 'system:todos'), false)
})

test('committed assistant message replaces its streamed preview', () => {
  let state = createProjection('session-1')
  state = foldSessionEvent(state, {
    seq: 0,
    time: 10,
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'draft' } },
  })
  state = foldSessionEvent(state, {
    seq: 1,
    time: 11,
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'final' }] },
    },
  })

  assert.equal(state.entries.length, 1)
  assert.deepEqual(state.entries[0], {
    id: 'assistant:1:1:text:0',
    role: 'assistant',
    kind: 'text',
    text: 'final',
    streaming: false,
  })
})

test('tracks turn and tool lifecycle for the status line', () => {
  let state = createProjection('session-1')
  state = foldSessionEvent(state, { seq: 0, time: 10, type: 'turn/start', data: { turn: 1 } })
  state = foldSessionEvent(state, {
    seq: 1,
    time: 11,
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' },
  })
  assert.equal(state.running, true)
  assert.deepEqual(state.activeTools, [{ id: 'call-1', name: 'bash' }])

  state = foldSessionEvent(state, {
    seq: 2,
    time: 12,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'result-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [],
      },
    },
  })
  state = foldSessionEvent(state, {
    seq: 3,
    time: 13,
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })

  assert.equal(state.running, false)
  assert.deepEqual(state.activeTools, [])
})

test('settles orphaned running tool cards when the turn ends', () => {
  let state = foldSessionEvent(createProjection('session-1'), {
    seq: 1, time: 1, type: 'tool/call', data: { callId: 'orphan', name: 'bash', arguments: '{}' },
  })
  state = foldSessionEvent(state, {
    seq: 2, time: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } },
  })
  const entry = state.entries.find(candidate => candidate.id === 'tool:orphan')
  assert.equal(entry?.streaming, false)
  assert.equal(entry?.error, true)
  assert.match(entry?.detail ?? '', /without a durable result/i)
})

test('uses Harness tool presentation intents for live calls and completed diffs', () => {
  const presenter = {
    presentCall(name: string, args: unknown) {
      assert.equal(name, 'edit')
      assert.deepEqual(args, { file_path: 'src/a.ts', old: 'before', next: 'after' })
      return {
        card: 'diff' as const,
        title: 'Edit src/a.ts',
        diffs: [{ path: 'src/a.ts', oldText: 'before', newText: 'after' }],
      }
    },
    presentResult(name: string, args: unknown, result: { isError: boolean; meta?: unknown }) {
      assert.equal(name, 'edit')
      assert.deepEqual(args, { file_path: 'src/a.ts', old: 'before', next: 'after' })
      assert.equal(result.isError, false)
      assert.deepEqual(result.meta, { diffs: [{ path: 'src/a.ts', oldText: 'ctx\nbefore', newText: 'ctx\nafter' }] })
      return {
        card: 'diff' as const,
        title: 'Edited src/a.ts',
        diffs: [{ path: 'src/a.ts', oldText: 'ctx\nbefore', newText: 'ctx\nafter' }],
      }
    },
  }
  let state = foldSessionEvent(createProjection('session-1'), {
    seq: 1,
    time: 11,
    type: 'tool/call',
    data: {
      turn: 1,
      step: 1,
      callId: 'call-edit',
      name: 'edit',
      arguments: '{"file_path":"src/a.ts","old":"before","next":"after"}',
    },
  }, presenter)
  assert.equal(state.entries[0]?.streaming, true)
  assert.equal(state.entries[0]?.text, 'Edit src/a.ts')
  assert.deepEqual(state.entries[0]?.diffs, [{ path: 'src/a.ts', oldText: 'before', newText: 'after' }])

  state = foldSessionEvent(state, {
    seq: 2,
    time: 12,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: 'call-edit' },
        content: [{ type: 'tool-result', toolCallId: 'call-edit', isError: false, content: [{ type: 'text', text: 'done' }] }],
      },
      meta: { diffs: [{ path: 'src/a.ts', oldText: 'ctx\nbefore', newText: 'ctx\nafter' }] },
    },
  }, presenter)
  assert.equal(state.entries[0]?.streaming, false)
  assert.equal(state.entries[0]?.text, 'Edited src/a.ts')
  assert.deepEqual(state.entries[0]?.diffs, [{ path: 'src/a.ts', oldText: 'ctx\nbefore', newText: 'ctx\nafter' }])
})

test('detects tool errors from the tool-result block', () => {
  let state = foldSessionEvent(createProjection('session-1'), {
    seq: 1,
    time: 11,
    type: 'tool/call',
    data: { callId: 'bad', name: 'bash', arguments: '{"command":"false"}' },
  })
  state = foldSessionEvent(state, {
    seq: 2,
    time: 12,
    type: 'tool/result',
    data: {
      message: {
        source: { kind: 'tool', callId: 'bad' },
        content: [{ type: 'tool-result', toolCallId: 'bad', isError: true, content: [{ type: 'text', text: 'failed' }] }],
      },
    },
  })
  assert.equal(state.entries[0]?.error, true)
  assert.equal(state.entries[0]?.detail, 'failed')
})

test('captures usage, todos, and turn failures', () => {
  let state = createProjection('session-1')
  state = foldSessionEvent(state, {
    seq: 0,
    time: 10,
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { id: 'a1', role: 'assistant', content: [] },
      usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 10 },
    },
  })
  state = foldSessionEvent(state, {
    seq: 1,
    time: 11,
    type: 'todo/write',
    data: { todos: [{ content: 'Run tests', status: 'in_progress' }] },
  })
  state = foldSessionEvent(state, {
    seq: 2,
    time: 12,
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: 'bad key' } } },
  })

  assert.deepEqual(state.usage, { inputTokens: 100, outputTokens: 25, cacheReadTokens: 10 })
  assert.deepEqual(state.todos, [{ content: 'Run tests', status: 'in_progress' }])
  assert.equal(state.lastError, 'AUTH: bad key')
  assert.match(state.entries.find(entry => entry.id === 'system:todos')?.text ?? '', /Run tests/)
})

test('projects durable command lifecycle rows', () => {
  let state = foldSessionEvent(createProjection('session-1'), {
    seq: 1,
    time: 1,
    type: 'command/run',
    data: { commandId: 'cmd-1', name: 'compact', args: 'now', source: { kind: 'user' } },
  })
  assert.equal(state.entries[0]?.streaming, true)
  state = foldSessionEvent(state, {
    seq: 2,
    time: 2,
    type: 'command/done',
    data: { commandId: 'cmd-1', kind: 'success', text: 'Compacted' },
  })
  assert.equal(state.entries[0]?.streaming, false)
  assert.match(state.entries[0]?.text ?? '', /compact/)
  assert.match(state.entries[0]?.detail ?? '', /Compacted/)
})

test('projects mounted Harness runtime state and synthetic context distinctly', () => {
  let state = createProjection('session-1')
  state = foldSessionEvent(state, {
    seq: 1, time: 1, type: 'plan/mode', data: { active: true },
  })
  state = foldSessionEvent(state, {
    seq: 2, time: 2, type: 'permission/preset', data: { preset: 'workspace-write' },
  })
  state = foldSessionEvent(state, {
    seq: 3,
    time: 3,
    type: 'goal/change',
    data: {
      operation: 'create',
      goal: { objective: 'Ship it', phase: 'active' },
      roundsStarted: 2,
    },
  })
  state = foldSessionEvent(state, {
    seq: 4, time: 4, type: 'compaction/start', data: { compactionId: 'compact-1' },
  })
  state = foldSessionEvent(state, {
    seq: 5,
    time: 5,
    type: 'user/message',
    data: { source: { kind: 'skill-invocation' }, content: [{ type: 'text', text: 'Injected instructions' }] },
  })

  assert.equal(state.planMode, true)
  assert.equal(state.permissionPreset, 'workspace-write')
  assert.deepEqual(state.goal, { objective: 'Ship it', phase: 'active', roundsStarted: 2 })
  assert.equal(state.compacting, true)
  assert.equal(state.entries.at(-1)?.role, 'system')
})

test('projects structured context metadata into semantic transcript summaries', () => {
  const cases = [
    {
      source: { kind: 'skill-invocation', form: 'instructions', name: 'frontend-design' },
      form: 'instructions', summary: 'Skill loaded · frontend-design',
    },
    {
      source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'a' }, { name: 'b' }] },
      form: 'catalog', summary: 'Skills available · 2',
    },
    {
      source: { kind: 'agent-instructions', form: 'instructions', baseline: true, changes: [{ path: 'AGENTS.md' }] },
      form: 'instructions', summary: 'Workspace instructions loaded · AGENTS.md',
    },
    {
      source: { kind: 'session-reference', form: 'recall', references: [{ label: 'Prior work' }] },
      form: 'recall', summary: 'Session context recalled · Prior work',
    },
    {
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Worker completed' },
      form: 'notice', summary: 'Worker completed',
    },
    {
      source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'Background job finished' },
      form: 'notice', summary: 'Background job finished',
    },
    {
      source: { kind: 'future-plugin', form: 'future-form' },
      form: 'opaque', summary: 'Context · future-plugin',
    },
  ] as const

  let state = createProjection('session-1')
  for (const [index, candidate] of cases.entries()) {
    state = foldSessionEvent(state, {
      seq: index + 1,
      time: index + 1,
      type: 'user/message',
      data: { source: candidate.source, content: [{ type: 'text', text: `body-${String(index)}` }] },
    })
    assert.equal(state.entries[index]?.context?.form, candidate.form)
    assert.equal(state.entries[index]?.context?.summary, candidate.summary)
  }
})

test('retains structured tool outcome summaries from Harness presentation views', () => {
  const resultViews: Record<string, unknown> = {
    terminal: { card: 'terminal', output: 'one\ntwo', exitCode: 0 },
    read: { card: 'read', path: 'src/a.ts', totalLines: 90, lines: [] },
    search: { card: 'search', shape: 'matches', files: [], total: 12, truncated: true },
    web: { card: 'web', kind: 'search', sources: [{ title: 'A' }, { title: 'B' }], truncated: false },
    web_fetch: { card: 'web', kind: 'fetch', statusCode: 200, url: 'https://example.com', truncated: true },
    diff: { card: 'diff', diffs: [{ path: 'src/a.ts', oldText: 'a\nb', newText: 'a\nc\nd' }] },
    diff_separated: { card: 'diff', diffs: [{ path: 'src/b.ts', oldText: 'a\nkeep\nb', newText: 'x\nkeep\ny' }] },
    diff_large: { card: 'diff', diffs: [{ path: 'src/large.ts', oldText: 'a'.repeat(20_001), newText: 'b'.repeat(20_001) }] },
    generic: { card: 'generic', content: [{ type: 'text', text: 'one\ntwo\nthree' }] },
  }
  const expected = new Map([
    ['terminal', 'exit 0 · 2 lines'],
    ['read', 'src/a.ts · 90 lines'],
    ['search', '12 matches · truncated'],
    ['web', '2 sources'],
    ['web_fetch', '200 · https://example.com · truncated'],
    ['diff', '1 file · +2 −1'],
    ['diff_separated', '1 file · +2 −2'],
    ['diff_large', '1 file changed'],
    ['generic', '3 lines'],
  ])
  const presenter = {
    presentCall(name: string) {
      return { card: name === 'terminal' ? 'terminal' : 'generic', title: name }
    },
    presentResult(name: string) {
      return resultViews[name]
    },
  }

  for (const [index, name] of [...expected.keys()].entries()) {
    let state = foldSessionEvent(createProjection('session-1'), {
      seq: index * 2 + 1,
      time: index * 2 + 1,
      type: 'tool/call',
      data: { callId: name, name, arguments: '{}' },
    }, presenter)
    state = foldSessionEvent(state, {
      seq: index * 2 + 2,
      time: index * 2 + 2,
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: name },
          content: [{ type: 'tool-result', toolCallId: name, isError: false, content: [{ type: 'text', text: 'fallback' }] }],
        },
      },
    }, presenter)
    assert.equal(state.entries[0]?.toolPresentation?.summary, expected.get(name))
  }
})

test('uses rc.6 error identity instead of stale call arguments for empty tool failures', () => {
  let state = foldSessionEvent(createProjection('session-1'), {
    seq: 1,
    time: 1,
    type: 'tool/call',
    data: { callId: 'broken', name: 'x', arguments: '{}' },
  })
  state = foldSessionEvent(state, {
    seq: 2,
    time: 2,
    type: 'tool/result',
    data: {
      error: { name: 'HarnessError', code: 'BROKEN' },
      message: {
        source: { kind: 'tool', callId: 'broken' },
        content: [{ type: 'tool-result', toolCallId: 'broken', isError: true, content: [] }],
      },
    },
  })

  assert.equal(state.entries[0]?.detail, 'HarnessError · BROKEN')
  assert.equal(state.entries[0]?.error, true)
})

test('classifies routine, todo, goal, approval, and retry system entries', () => {
  let state = createProjection('session-1')
  state = foldSessionEvent(state, { seq: 1, time: 1, type: 'plan/mode', data: { active: true } })
  state = foldSessionEvent(state, { seq: 2, time: 2, type: 'todo/write', data: { todos: [{ content: 'Test', status: 'pending' }] } })
  state = foldSessionEvent(state, {
    seq: 3, time: 3, type: 'goal/change',
    data: { operation: 'create', goal: { objective: 'Ship', phase: 'active' } },
  })
  state = foldSessionEvent(state, { seq: 4, time: 4, type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } })
  state = foldSessionEvent(state, {
    seq: 5, time: 5, type: 'llm/retry',
    data: { retryId: 'r', turn: 1, step: 1, provider: 'deepseek', retry: 1, delayMs: 100 },
  })

  assert.deepEqual(state.entries.map(entry => entry.systemKind), ['routine', 'todo', 'goal', 'approval', 'retry'])
  assert.equal(state.entries[1]?.systemSummary, 'Todos · 1 active')
})

test('captures the complete model selection for status and settings', () => {
  const state = foldSessionEvent(createProjection('session-1'), {
    seq: 0,
    time: 10,
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'high' } } },
  })
  assert.deepEqual(
    { provider: state.provider, model: state.model, reasoningEffort: state.reasoningEffort },
    { provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'high' },
  )
})

test('tracks the latest model route and advertised context capacity', () => {
  let state = createProjection('s')
  state = foldSessionEvent(state, {
    seq: 1,
    time: 1,
    type: 'request/context',
    data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1_000_000 },
  })
  assert.deepEqual(state.requestContext, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    contextWindow: 1_000_000,
  })

  state = foldSessionEvent(state, {
    seq: 2,
    time: 2,
    type: 'request/context',
    data: { provider: 'custom', model: 'unknown-capacity' },
  })
  assert.deepEqual(state.requestContext, { provider: 'custom', model: 'unknown-capacity' })
})

test('keeps repeated plan, permission, and goal changes in chronological history', () => {
  let state = createProjection('session-1')
  state = foldSessionEvent(state, { seq: 1, time: 1, type: 'plan/mode', data: { active: true } })
  state = foldSessionEvent(state, { seq: 2, time: 2, type: 'plan/mode', data: { active: false } })
  state = foldSessionEvent(state, { seq: 3, time: 3, type: 'permission/preset', data: { preset: 'read-only' } })
  state = foldSessionEvent(state, { seq: 4, time: 4, type: 'permission/preset', data: { preset: 'workspace-write' } })
  state = foldSessionEvent(state, {
    seq: 5,
    time: 5,
    type: 'goal/change',
    data: { operation: 'create', goal: { objective: 'First', phase: 'active' } },
  })
  state = foldSessionEvent(state, { seq: 6, time: 6, type: 'goal/change', data: { operation: 'clear' } })

  assert.deepEqual(state.entries.map(entry => entry.id), [
    'system:plan:1',
    'system:plan:2',
    'system:permission:3',
    'system:permission:4',
    'system:goal:5',
    'system:goal:6',
  ])
})

test('keeps approval prompts out of history and appends only the decision result', () => {
  let state = foldSessionEvent(createProjection('session-1'), {
    seq: 1,
    time: 1,
    type: 'approval/asked',
    data: { id: 'approval-1', toolName: 'bash', reason: 'Needs access' },
  })
  assert.deepEqual(state.entries, [])
  state = foldSessionEvent(state, {
    seq: 2,
    time: 2,
    type: 'approval/decided',
    data: { id: 'approval-1', outcome: 'rejected' },
  })
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0]?.id, 'system:approval:approval-1:2')
  assert.match(state.entries[0]?.text ?? '', /rejected/)
})

test('keeps ask-user prompts out of history and appends only the answer result', () => {
  let state = foldSessionEvent(createProjection('session-1'), {
    seq: 1,
    time: 1,
    type: 'tool/call',
    data: {
      callId: 'question-1',
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ question: 'Secret prompt?' }] }),
    },
  })
  assert.deepEqual(state.entries, [])
  assert.deepEqual(state.activeTools, [{ id: 'question-1', name: 'ask_user_question' }])
  state = foldSessionEvent(state, {
    seq: 2,
    time: 2,
    type: 'tool/result',
    data: {
      message: {
        source: { kind: 'tool', callId: 'question-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'question-1',
          isError: false,
          content: [{ type: 'text', text: '{"answers":[{"selected":["A"]}]}' }],
        }],
      },
    },
  })
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0]?.text, 'User answered question')
  assert.match(state.entries[0]?.detail ?? '', /answers/)
})
