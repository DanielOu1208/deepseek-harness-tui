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
