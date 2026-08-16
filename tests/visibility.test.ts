import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createVisibilityProjection,
  projectVisibility,
  snapshotVisibility,
} from '../src/visibility.js'

function event(type: string, seq: number, time: number, data: unknown): any {
  return { type, seq, time, data }
}

function assistantMessage(usage?: Record<string, number>) {
  return {
    turn: 1,
    step: 1,
    message: {
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'deepseek', model: 'test' },
    },
    ...(usage === undefined ? {} : { usage }),
  }
}

function timingEvents() {
  return [
    event('turn/start', 0, 900, { turn: 1 }),
    event('step/start', 1, 1_000, { turn: 1, step: 1 }),
    event('assistant/chunk', 2, 1_200, {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'first' },
    }),
    event('tool/call', 3, 1_300, {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'bash',
      arguments: '{"command":"pwd"}',
    }),
    event('tool/result', 4, 1_700, {
      turn: 1,
      step: 1,
      message: {
        id: 'result-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: '/work' }],
          isError: false,
        }],
      },
      meta: { exitCode: 0 },
    }),
    event('assistant/message', 5, 1_800, assistantMessage({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    })),
    event('step/end', 6, 1_900, { turn: 1, step: 1 }),
    event('turn/end', 7, 2_000, { turn: 1, reason: { kind: 'completed' } }),
  ]
}

test('folds exact rc.6 step, TTFT, decode, tool, and token totals', () => {
  const snapshot = projectVisibility(timingEvents(), 'session-1')

  assert.equal(snapshot.timing.llmMs, 800)
  assert.equal(snapshot.timing.ttftMs, 200)
  assert.equal(snapshot.timing.ttftSteps, 1)
  assert.equal(snapshot.timing.decodeMs, 600)
  assert.equal(snapshot.timing.decodeTokens, 7)
  assert.equal(snapshot.timing.toolMs, 400)
  assert.equal(snapshot.timing.subtoolMs, 0)
  assert.deepEqual(snapshot.tokens, {
    uncachedInputTokens: 10,
    outputTokens: 7,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
  })
  assert.deepEqual(snapshot.steps, [{
    id: 'step:1:1',
    turn: 1,
    step: 1,
    startSeq: 1,
    startedAt: 1_000,
    endSeq: 6,
    completedAt: 1_900,
    firstTokenAt: 1_200,
    modelMs: 800,
    ttftMs: 200,
    decodeMs: 600,
    outputTokens: 7,
    usage: {
      uncachedInputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    },
    status: 'completed',
  }])
  assert.deepEqual(snapshot.tools, [{
    id: 'tool:call-1',
    kind: 'tool',
    callId: 'call-1',
    turn: 1,
    step: 1,
    name: 'bash',
    startSeq: 3,
    startedAt: 1_300,
    resultSeq: 4,
    finishedAt: 1_700,
    durationMs: 400,
    status: 'completed',
    argumentsText: '{"command":"pwd"}',
    resultText: '/work',
    resultMetaText: '{"exitCode":0}',
    resultIsError: false,
  }])
})

test('replaces an early usage sample with the final same-step sample', () => {
  const snapshot = projectVisibility([
    event('step/start', 0, 1_000, { turn: 1, step: 1 }),
    event('assistant/chunk', 1, 1_100, {
      turn: 1,
      step: 1,
      chunk: {
        type: 'usage',
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      },
    }),
    event('assistant/message', 2, 1_200, assistantMessage({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
    })),
  ])

  assert.deepEqual(snapshot.tokens, {
    uncachedInputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
  })
})

test('pairs nested Code Mode dispatches and keeps their timing separate from root calls', () => {
  const snapshot = projectVisibility([
    event('step/start', 0, 1_000, { turn: 1, step: 1 }),
    event('tool/code-dispatch-start', 1, 1_100, {
      rootCallId: 'root',
      parentCallId: 'root',
      subCallId: 'root:code:0',
      name: 'read',
      arguments: { path: 'README.md' },
    }),
    event('tool/code-dispatch', 2, 1_350, {
      rootCallId: 'root',
      parentCallId: 'root',
      subCallId: 'root:code:0',
      name: 'read',
      arguments: { path: 'README.md' },
      isError: false,
      content: [{ type: 'text', text: 'hello' }],
    }),
  ])

  assert.equal(snapshot.timing.toolMs, 0)
  assert.equal(snapshot.timing.subtoolMs, 250)
  assert.deepEqual(snapshot.tools, [{
    id: 'subtool:root:code:0',
    kind: 'subtool',
    callId: 'root:code:0',
    turn: 1,
    step: 1,
    name: 'read',
    startSeq: 1,
    startedAt: 1_100,
    resultSeq: 2,
    finishedAt: 1_350,
    durationMs: 250,
    status: 'completed',
    parentCallId: 'root',
    rootCallId: 'root',
    argumentsText: '{"path":"README.md"}',
    resultText: 'hello',
    resultIsError: false,
  }])
})

test('incremental append and cold replay agree, while duplicate seq is idempotent', () => {
  const events = timingEvents()
  const replay = projectVisibility(events)
  const projection = createVisibilityProjection()
  for (const item of events) projection.append(item)
  const before = snapshotVisibility(projection)
  projection.append(events[events.length - 1]!)

  assert.deepEqual(snapshotVisibility(projection), before)
  assert.deepEqual(before, replay)
  assert.equal(before.lastSeq, 7)
})

test('excludes cancelled partial streams and bounds inspector payloads', () => {
  const projection = createVisibilityProjection(undefined, {
    maxTrajectoryRecords: 2,
    maxStepRecords: 1,
    maxToolRecords: 1,
    maxTextChars: 8,
  })
  for (const item of [
    event('turn/start', 0, 1_000, { turn: 1 }),
    event('step/start', 1, 1_001, { turn: 1, step: 1 }),
    event('assistant/chunk', 2, 1_002, {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'partial' },
    }),
    event('tool/call', 3, 1_003, {
      turn: 1,
      step: 1,
      callId: 'long-call',
      name: 'bash',
      arguments: '1234567890',
    }),
    event('turn/end', 4, 1_010, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    event('step/end', 5, 1_011, { turn: 1, step: 1 }),
  ]) projection.append(item)

  const snapshot = projection.snapshot()
  assert.deepEqual(snapshot.timing, {
    turns: 1,
    steps: 1,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    subtoolMs: 0,
  })
  assert.equal(snapshot.steps[0]?.status, 'aborted')
  assert.equal(snapshot.tools[0]?.status, 'interrupted')
  assert.equal(snapshot.tools[0]?.argumentsText, '1234567…')
  assert.ok(snapshot.trajectory.length <= 2)
})
