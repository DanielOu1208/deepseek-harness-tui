import test from 'node:test'
import assert from 'node:assert/strict'
import { DshTuiRunner } from '../src/index.js'
import type { ProjectionState } from '../src/projection.js'

function runnerWith(ctx: object, ui: object): DshTuiRunner {
  return new DshTuiRunner(ctx as never, {}, ui as never)
}

test('plan shortcut toggles against committed and pending Harness state', async () => {
  let state: { active: boolean; pending?: boolean } = { active: false }
  const commands: string[] = []
  const statuses: string[] = []
  const runner = runnerWith({ planMode: { get: () => state } }, {
    setStatus: (status: string) => { statuses.push(status) },
  })
  const subject = runner as unknown as {
    handle: object
    enqueueShortcut(action: () => Promise<void>): Promise<void>
    runHarnessCommand(line: string): Promise<void>
    togglePlanMode(): Promise<void>
  }
  subject.handle = { agent: {} }
  subject.runHarnessCommand = async (line) => {
    commands.push(line)
    state = line === '/plan' ? { active: false, pending: true } : { active: false }
  }

  const first = subject.enqueueShortcut(() => subject.togglePlanMode())
  const second = subject.enqueueShortcut(() => subject.togglePlanMode())
  await Promise.all([first, second])

  assert.deepEqual(commands, ['/plan', '/plan off'])
  assert.deepEqual(statuses, [
    'plan mode queued for the next step',
    'build mode',
  ])
})

test('serialized reasoning shortcuts advance through actual model levels', async () => {
  const statuses: string[] = []
  const flashes: string[] = []
  const selection = { current: { provider: 'deepseek', model: 'v4', reasoningEffort: 'off' }, assembled: undefined }
  const runner = runnerWith({
    llm: {
      resolveModelInfo: async () => ({
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High' },
            { id: 'max', name: 'Max' },
          ],
          defaultEffort: 'high',
        },
      }),
    },
  }, {
    setStatus: (status: string) => { statuses.push(status) },
    flashStatus: (status: string) => { flashes.push(status) },
  })
  const subject = runner as unknown as {
    handle: object
    selection: typeof selection
    refresh(): void
    enqueueShortcut(action: () => Promise<void>): Promise<void>
    stepReasoning(direction: 'increase' | 'decrease'): Promise<void>
  }
  subject.handle = { agent: {} }
  subject.selection = selection
  subject.refresh = () => {}

  const first = subject.enqueueShortcut(() => subject.stepReasoning('increase'))
  const second = subject.enqueueShortcut(() => subject.stepReasoning('increase'))
  await Promise.all([first, second])
  await subject.enqueueShortcut(() => subject.stepReasoning('increase'))

  assert.equal(selection.current.reasoningEffort, 'max')
  assert.deepEqual(statuses, [
    'reasoning high · next request',
    'reasoning max · next request',
    'reasoning is already at max',
  ])
  assert.deepEqual(flashes, ['reasoning is already at max'])
})

test('runner waits for new-route usage before combining it with model capacity', () => {
  let rendered: ProjectionState | undefined
  let pressure = { projectedTokens: 42_000, pressureTokens: 40_000, contextWindow: 1_000_000 }
  const events: any[] = [{
    seq: 0,
    time: 1,
    type: 'request/context',
    data: { provider: 'deepseek', model: 'v4', contextWindow: 1_000_000 },
  }, {
    seq: 1,
    time: 2,
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 40_000, outputTokens: 1_000 } } },
  }]
  const agent = { id: 'agent-1', status: 'idle', session: { events } }
  const selection = { current: { provider: 'deepseek', model: 'v4' }, assembled: undefined }
  const runner = runnerWith({
    tools: { get: () => undefined },
    sessionProjections: {
      snapshot: () => ({
        asOfSeq: events.at(-1)?.seq ?? -1,
        values: { contextPressure: pressure },
      }),
    },
  }, { renderProjection: (state: ProjectionState) => { rendered = state } })
  const subject = runner as unknown as {
    handle: { agent: typeof agent }
    selection: typeof selection
    selectedContextWindow?: number
    refresh(): void
  }
  subject.handle = { agent }
  subject.selection = selection
  subject.selectedContextWindow = 1_000_000

  subject.refresh()
  assert.deepEqual(rendered?.contextWindow, { capacityTokens: 1_000_000, usedTokens: 42_000 })

  selection.current = { provider: 'custom', model: 'new-model' }
  subject.selectedContextWindow = 200_000
  subject.refresh()
  assert.deepEqual(rendered?.contextWindow, { capacityTokens: 200_000 })

  events.push({
    seq: 2,
    time: 3,
    type: 'request/context',
    data: { provider: 'custom', model: 'new-model', contextWindow: 200_000 },
  })
  subject.refresh()
  assert.deepEqual(rendered?.contextWindow, { capacityTokens: 200_000 })

  pressure = { projectedTokens: 20_000, pressureTokens: 18_000, contextWindow: 200_000 }
  events.push({
    seq: 3,
    time: 4,
    type: 'assistant/message',
    data: { turn: 2, step: 1, message: { content: [] }, usage: { inputTokens: 18_000, outputTokens: 500 } },
  })
  subject.refresh()
  assert.deepEqual(rendered?.contextWindow, { capacityTokens: 200_000, usedTokens: 20_000 })
})

test('runner falls back to provider pressure when projected context is unavailable', () => {
  let rendered: ProjectionState | undefined
  const events: any[] = [{
    seq: 0,
    time: 1,
    type: 'request/context',
    data: { provider: 'deepseek', model: 'v4', contextWindow: 1_000_000 },
  }, {
    seq: 1,
    time: 2,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [] }, usage: { inputTokens: 39_000, outputTokens: 500 } },
  }]
  const agent = { id: 'agent-1', status: 'idle', session: { events } }
  const runner = runnerWith({
    tools: { get: () => undefined },
    sessionProjections: {
      snapshot: () => ({ asOfSeq: 1, values: { contextPressure: { pressureTokens: 39_000 } } }),
    },
  }, { renderProjection: (state: ProjectionState) => { rendered = state } })
  const subject = runner as unknown as {
    handle: { agent: typeof agent }
    selection: { current: { provider: string; model: string }; assembled: undefined }
    selectedContextWindow?: number
    refresh(): void
  }
  subject.handle = { agent }
  subject.selection = { current: { provider: 'deepseek', model: 'v4' }, assembled: undefined }
  subject.selectedContextWindow = 1_000_000

  subject.refresh()

  assert.deepEqual(rendered?.contextWindow, { capacityTokens: 1_000_000, usedTokens: 39_000 })
})

test('in-flight shortcuts do not update a replacement session', async () => {
  let resolveInfo: ((value: any) => void) | undefined
  let finishPlan: (() => void) | undefined
  const statuses: string[] = []
  const oldAgent = {}
  const newAgent = {}
  const oldSelection = { current: { provider: 'old', model: 'model', reasoningEffort: 'off' }, assembled: undefined }
  const newSelection = { current: { provider: 'new', model: 'model', reasoningEffort: 'high' }, assembled: undefined }
  const runner = runnerWith({
    llm: {
      resolveModelInfo: () => new Promise(resolve => { resolveInfo = resolve }),
    },
    planMode: { get: () => ({ active: false }) },
  }, {
    setStatus: (status: string) => { statuses.push(status) },
    flashStatus: () => {},
  })
  const subject = runner as unknown as {
    handle: { agent: object }
    selection: typeof oldSelection | typeof newSelection
    sessionGeneration: number
    refresh(): void
    runHarnessCommand(line: string, agent?: object): Promise<void>
    stepReasoning(direction: 'increase' | 'decrease'): Promise<void>
    togglePlanMode(): Promise<void>
  }
  subject.handle = { agent: oldAgent }
  subject.selection = oldSelection
  subject.refresh = () => {}
  subject.runHarnessCommand = () => new Promise(resolve => { finishPlan = resolve })

  const reasoning = subject.stepReasoning('increase')
  const plan = subject.togglePlanMode()
  subject.sessionGeneration += 1
  subject.handle = { agent: newAgent }
  subject.selection = newSelection
  resolveInfo?.({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }], defaultEffort: 'off' } })
  finishPlan?.()
  await Promise.all([reasoning, plan])

  assert.equal(oldSelection.current.reasoningEffort, 'off')
  assert.equal(newSelection.current.reasoningEffort, 'high')
  assert.deepEqual(statuses, [])
})
