import test from 'node:test'
import assert from 'node:assert/strict'
import { DshTuiRunner } from '../src/index.js'
import type { PromptControllerApi } from '../src/prompt-controller.js'
import { forkSeedEvents } from '../src/session-lifecycle.js'

function header(id: string, createdAt: number, extra: Record<string, unknown> = {}) {
  return { version: 0, id, createdAt, cwd: `/work/${id}`, ...extra }
}

function titleEvent(title: string, seq: number, time: number) {
  return {
    type: 'session/title', seq, time,
    data: { title, messageSeqs: [], source: { kind: 'fallback' } },
  }
}

function runnerWith(ctx: object, ui: object, promptController?: PromptControllerApi): DshTuiRunner {
  return new DshTuiRunner(ctx as never, {}, {
    setComposerLocked: () => {},
    ...ui,
  } as never, undefined, undefined, promptController)
}

function promptControllerWithPendingImage() {
  let pending = true
  const controller: PromptControllerApi = {
    installInteractions: () => {},
    disposeInteractions: () => {},
    scheduleDraftSave: () => {},
    persistCurrentDraft: async () => {},
    restoreCurrentDraft: async () => {},
    flushDrafts: async () => {},
    hasPendingImages: () => pending,
    clearPendingImages: () => { pending = false },
    pasteClipboardImage: async () => {},
    chooseAttachments: async () => {},
    beginPrompt: async () => { throw new Error('not used') },
    promptMessage: async () => { throw new Error('not used') },
    completePrompt: async () => {},
    recoverPrompt: async () => {},
    confirmDiscardPendingImages: async () => true,
  }
  return { controller, hasPendingImage: () => pending }
}

test('loads every top-level session, caches titles by revision, and isolates failures', async () => {
  let snapshots = Array.from({ length: 35 }, (_, index) => ({
    header: header(`session-${String(index)}`, index + 1),
    revision: `revision-${String(index)}-a`,
  }))
  snapshots.push({
    header: header('subagent-hidden', 100, { origin: 'subagent' }),
    revision: 'subagent-revision',
  })
  const calls = new Map<string, number>()
  let active = 0
  let maxActive = 0
  const persistence = {
    listSnapshots: async () => snapshots,
    inspect: async (id: string) => {
      calls.set(id, (calls.get(id) ?? 0) + 1)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => setImmediate(resolve))
      active -= 1
      if (id === 'session-7') throw new Error('broken session')
      const index = Number(id.slice('session-'.length))
      return { meta: header(id, index + 1), events: [titleEvent(`Title ${String(index)}`, 0, index + 100)] }
    },
  }
  const agent = {
    id: 'session-current',
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [], hasPending: false },
    session: { header: header('session-current', 200), events: [] },
  }
  const runner = runnerWith({
    sessionPersistence: persistence,
    workspaceRegistry: { archivedSessionIds: [] },
  }, {})
  const subject = runner as unknown as {
    handle: { agent: typeof agent }
    sessionNavigator: {
      hasCached(id: string): boolean
      loadPickerItems(): Promise<Array<{ value: string; label: string; description?: string; searchText?: string }>>
    }
  }
  subject.handle = { agent }

  const first = await subject.sessionNavigator.loadPickerItems()
  assert.equal(first.length, 36)
  assert.equal(first[0]?.value, 'session-current')
  assert.equal(first.some(item => item.value === 'subagent-hidden'), false)
  assert.equal(first.find(item => item.value === 'session-2')?.label, 'Title 2')
  assert.match(first.find(item => item.value === 'session-2')?.searchText ?? '', /Title 2 session-2 \/work\/session-2/)
  assert.match(first.find(item => item.value === 'session-7')?.description ?? '', /title unavailable/)
  assert.ok(maxActive > 1)
  assert.ok(maxActive <= 8)

  const sessionTwoCalls = calls.get('session-2')
  await subject.sessionNavigator.loadPickerItems()
  assert.equal(calls.get('session-2'), sessionTwoCalls)
  assert.equal(calls.get('session-7'), 2, 'failed inspections should be retried')

  snapshots = snapshots.map(snapshot => snapshot.header.id === 'session-2'
    ? { ...snapshot, revision: 'revision-2-b' }
    : snapshot)
  await subject.sessionNavigator.loadPickerItems()
  assert.equal(calls.get('session-2'), (sessionTwoCalls ?? 0) + 1)

  snapshots = snapshots.filter(snapshot => snapshot.header.id !== 'session-3')
  await subject.sessionNavigator.loadPickerItems()
  assert.equal(subject.sessionNavigator.hasCached('session-3'), false)
})

test('routes both navigator commands while preserving direct resume', async () => {
  const runner = runnerWith({}, {})
  const calls: string[] = []
  const subject = runner as unknown as {
    sessionNavigator: { chooseSession(): Promise<void> }
    requestSessionSwitch(id?: string): Promise<void>
  }
  subject.sessionNavigator.chooseSession = async () => { calls.push('choose') }
  subject.requestSessionSwitch = async id => { calls.push(id ?? 'new') }

  await runner.submit('/sessions')
  await runner.submit('/resume')
  await runner.submit('/resume session-known')
  await runner.submit('/new')

  assert.deepEqual(calls, ['choose', 'choose', 'session-known', 'new'])
})

test('cancels a slow session scan through the normal interrupt path', async () => {
  let scanStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { scanStarted = resolve })
  let aborted = false
  let pickerOpened = false
  const statuses: string[] = []
  const agent = {
    id: 'current', status: 'idle',
    inbox: { nextTurn: [], nextStep: [], hasPending: false },
    session: { header: header('current', 1), events: [] },
  }
  const runner = runnerWith({
    sessionPersistence: {
      listSnapshots: async (signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
        scanStarted?.()
        signal.addEventListener('abort', () => {
          aborted = true
          reject(signal.reason)
        }, { once: true })
      }),
    },
  }, {
    setStatus: (status: string) => { statuses.push(status) },
    chooseSearchable: async () => { pickerOpened = true; return undefined },
  })
  const subject = runner as unknown as {
    handle: { agent: typeof agent }
    sessionNavigator: { chooseSession(): Promise<void> }
  }
  subject.handle = { agent }

  const loading = subject.sessionNavigator.chooseSession()
  await started
  runner.interrupt()
  await loading

  assert.equal(aborted, true)
  assert.equal(pickerOpened, false)
  assert.ok(statuses.includes('session loading cancelled'))
})

test('keeps queued work safe and confirms before stopping a running turn', async () => {
  const statuses: string[] = []
  const flashes: string[] = []
  let choice: 'stay' | 'switch' = 'stay'
  let pending = false
  const switched: Array<string | undefined> = []
  const agent = {
    id: 'current', status: 'running',
    inbox: {
      nextTurn: [] as unknown[], nextStep: [] as unknown[],
      get hasPending() { return pending },
    },
    session: { header: header('current', 1), events: [] },
  }
  const runner = runnerWith({
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
    sessionPersistence: { inspect: async (id: string) => ({ meta: header(id, 2), events: [] }) },
  }, {
    setStatus: (status: string) => { statuses.push(status) },
    flashStatus: (status: string) => { flashes.push(status) },
    choose: async () => ({ value: choice }),
  })
  const subject = runner as unknown as {
    handle: { agent: typeof agent }
    switchSession(id?: string): Promise<void>
    requestSessionSwitch(id?: string): Promise<void>
  }
  subject.handle = { agent }
  subject.switchSession = async id => { switched.push(id) }

  pending = true
  agent.inbox.nextTurn = [{}]
  await subject.requestSessionSwitch('queued-target')
  assert.deepEqual(switched, [])
  assert.match(statuses.at(-1) ?? '', /wait for 1 queued message/)
  assert.equal(flashes.at(-1), statuses.at(-1))

  pending = false
  agent.inbox.nextTurn = []
  await subject.requestSessionSwitch('stay-target')
  assert.deepEqual(switched, [])

  choice = 'switch'
  await subject.requestSessionSwitch('switch-target')
  assert.deepEqual(switched, ['switch-target'])

  agent.status = 'idle'
  await subject.requestSessionSwitch('idle-target')
  assert.deepEqual(switched, ['switch-target', 'idle-target'])
})

test('rechecks the inbox after a running-turn confirmation', async () => {
  let pending = false
  let switched = false
  const agent = {
    id: 'current', status: 'running',
    inbox: {
      nextTurn: [] as unknown[], nextStep: [] as unknown[],
      get hasPending() { return pending },
    },
    session: { header: header('current', 1), events: [] },
  }
  const runner = runnerWith({
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
    sessionPersistence: { inspect: async (id: string) => ({ meta: header(id, 2), events: [] }) },
  }, {
    setStatus: () => {}, flashStatus: () => {},
    choose: async () => {
      pending = true
      agent.inbox.nextStep = [{}]
      return { value: 'switch' }
    },
  })
  const subject = runner as unknown as {
    handle: { agent: typeof agent }
    switchSession(): Promise<void>
    requestSessionSwitch(id?: string): Promise<void>
  }
  subject.handle = { agent }
  subject.switchSession = async () => { switched = true }

  await subject.requestSessionSwitch('target')
  assert.equal(switched, false)
})

test('serializes terminal submissions across a session transition', async () => {
  const runner = runnerWith({}, {})
  const order: string[] = []
  let releaseTransition: (() => void) | undefined
  let transitionStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { transitionStarted = resolve })
  const subject = runner as unknown as {
    processSubmission(raw: string): Promise<void>
  }
  subject.processSubmission = async raw => {
    order.push(`start:${raw}`)
    if (raw === '/new') {
      transitionStarted?.()
      await new Promise<void>(resolve => { releaseTransition = resolve })
    }
    order.push(`end:${raw}`)
  }

  const transition = runner.submit('/new')
  await started
  const prompt = runner.submit('message for the replacement')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['start:/new'])
  releaseTransition?.()
  await Promise.all([transition, prompt])
  assert.deepEqual(order, [
    'start:/new',
    'end:/new',
    'start:message for the replacement',
    'end:message for the replacement',
  ])
})

test('restores the previous session when opening a replacement fails', async () => {
  const notices: string[] = []
  const prompt = promptControllerWithPendingImage()
  const runner = runnerWith({}, {
    setStatus: () => {},
    appendNotice: (notice: string) => { notices.push(notice) },
  }, prompt.controller)
  const order: string[] = []
  const subject = runner as unknown as {
    handle: { agent: { id: string } }
    selection: { current: { provider: string; model: string } }
    detachCurrent(): Promise<void>
    open(id?: string): Promise<void>
    refresh(): void
    switchSession(): Promise<void>
  }
  subject.handle = { agent: { id: 'previous' } }
  subject.selection = { current: { provider: 'deepseek', model: 'v4' } }
  subject.detachCurrent = async () => { order.push('detach') }
  subject.open = async id => {
    order.push(`open:${id ?? 'new'}`)
    if (id === undefined) throw new Error('replacement failed')
  }
  subject.refresh = () => { order.push('refresh') }

  await assert.rejects(subject.switchSession(), /replacement failed/)
  assert.deepEqual(order, ['detach', 'open:new', 'open:previous', 'refresh'])
  assert.deepEqual(notices, ['Session change failed; restored previous'])
  assert.equal(prompt.hasPendingImage(), true, 'a failed switch must retain unsent images on the restored session')
})

test('does not publish the target when saving or closing the current session fails', async () => {
  const prompt = promptControllerWithPendingImage()
  prompt.controller.persistCurrentDraft = async () => {}
  const runner = runnerWith({}, { setStatus: () => {} }, prompt.controller)
  const order: string[] = []
  const subject = runner as unknown as {
    handle: { agent: { id: string } }
    selection: { current: { provider: string; model: string } }
    detachCurrent(): Promise<void>
    open(): Promise<void>
    switchSession(): Promise<void>
  }
  subject.handle = { agent: { id: 'previous' } }
  subject.selection = { current: { provider: 'deepseek', model: 'v4' } }
  subject.detachCurrent = async () => {
    order.push('detach')
    throw new Error('flush failed')
  }
  subject.open = async () => { order.push('open target') }

  await assert.rejects(subject.switchSession(), /flush failed/)
  assert.deepEqual(order, ['detach'])
})

test('opens a fresh fallback when a failed switch cannot restore an unpersisted session', async () => {
  const notices: string[] = []
  const prompt = promptControllerWithPendingImage()
  const runner = runnerWith({}, {
    setStatus: () => {},
    appendNotice: (notice: string) => { notices.push(notice) },
  }, prompt.controller)
  const order: string[] = []
  const subject = runner as unknown as {
    handle: { agent: { id: string } }
    selection: { current: { provider: string; model: string } }
    detachCurrent(): Promise<void>
    open(id?: string): Promise<void>
    refresh(): void
    switchSession(): Promise<void>
  }
  subject.handle = { agent: { id: 'blank-previous' } }
  subject.selection = { current: { provider: 'deepseek', model: 'v4' } }
  subject.detachCurrent = async () => { order.push('detach') }
  let newAttempts = 0
  subject.open = async id => {
    order.push(`open:${id ?? 'new'}`)
    if (id === undefined && newAttempts++ === 0) throw new Error('replacement failed')
    if (id === 'blank-previous') throw new Error('not persisted')
  }
  subject.refresh = () => { order.push('refresh') }

  await assert.rejects(subject.switchSession(), /replacement failed/)
  assert.deepEqual(order, ['detach', 'open:new', 'open:blank-previous', 'open:new', 'refresh'])
  assert.deepEqual(notices, [
    'Session change failed; opened a fresh session because the previous session could not be restored.',
  ])
  assert.equal(prompt.hasPendingImage(), false, 'a fresh fallback must not inherit another session’s unsent images')
})

test('keeps out-of-band title and injection records at a completed fork boundary', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: 'completed' } },
    titleEvent('Inherited title', 2, 3),
    { type: 'context/inject', seq: 3, time: 4, data: { source: 'test' } },
    { type: 'turn/start', seq: 4, time: 5, data: { turn: 2 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 2, reason: 'completed' } },
  ]

  assert.deepEqual(forkSeedEvents(events as never, 1).map(event => event.seq), [0, 1, 2, 3])
  assert.deepEqual(forkSeedEvents(events as never, -1), [])
})

test('keeps the composer locked through session activation and draft restoration', async () => {
  const order: string[] = []
  const prompt = promptControllerWithPendingImage()
  prompt.controller.persistCurrentDraft = async () => { order.push('persist') }
  prompt.controller.restoreCurrentDraft = async () => { order.push('restore') }
  const runner = runnerWith({}, {
    setComposerLocked: (locked: boolean) => { order.push(`lock:${String(locked)}`) },
    setStatus: () => {},
    appendLaunchBanner: () => { order.push('banner') },
    appendNotice: () => { order.push('notice') },
  }, prompt.controller)
  const subject = runner as unknown as {
    handle: { agent: { id: string; session: { header: { cwd: string } } } }
    selection: { current: { provider: string; model: string } }
    detachCurrent(): Promise<void>
    open(): Promise<void>
    refresh(): void
    switchSession(): Promise<void>
  }
  subject.handle = { agent: { id: 'previous', session: { header: { cwd: '/work/previous' } } } }
  subject.selection = { current: { provider: 'deepseek', model: 'v4' } }
  subject.detachCurrent = async () => { order.push('detach') }
  subject.open = async () => { order.push('open') }
  subject.refresh = () => { order.push('refresh') }

  await subject.switchSession()

  assert.deepEqual(order, [
    'lock:true', 'persist', 'detach', 'open', 'banner', 'restore', 'notice', 'refresh', 'lock:false',
  ])
})

test('interrupts direct resume validation before changing the current session', async () => {
  let validationStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { validationStarted = resolve })
  let receivedSignal: AbortSignal | undefined
  const statuses: string[] = []
  const agent = {
    id: 'current', status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    session: { header: header('current', 1), events: [] },
  }
  const runner = runnerWith({
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
    sessionPersistence: {
      inspect: async (_id: string, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
        receivedSignal = signal
        validationStarted?.()
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    },
  }, {
    setStatus: (status: string) => { statuses.push(status) },
    flashStatus: () => {},
  })
  const subject = runner as unknown as {
    handle: { agent: typeof agent }
    requestSessionSwitch(id: string): Promise<void>
  }
  subject.handle = { agent }

  const switching = subject.requestSessionSwitch('target')
  await started
  runner.interrupt()
  await switching

  assert.equal(receivedSignal?.aborted, true)
  assert.ok(statuses.includes('session change cancelled'))
  assert.equal(String(subject.handle.agent.id), 'current')
})

test('a failed fork restores or replaces the source and retains boundary metadata', async () => {
  const notices: string[] = []
  const locks: boolean[] = []
  const prompt = promptControllerWithPendingImage()
  let capturedSeed: Array<{ seq: number }> = []
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: 'completed' } },
    titleEvent('Fork title', 2, 3),
  ]
  const runner = runnerWith({
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 128_000 } }) },
    agents: {
      create: async ({ seed }: { seed: Array<{ seq: number }> }) => {
        capturedSeed = seed
        throw new Error('child create failed')
      },
    },
  }, {
    setComposerLocked: (locked: boolean) => { locks.push(locked) },
    appendNotice: (notice: string) => { notices.push(notice) },
  }, prompt.controller)
  const source = {
    id: 'source', status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    session: { id: 'source', header: header('source', 1), events },
  }
  const opened: string[] = []
  const subject = runner as unknown as {
    handle: { agent: typeof source }
    selection: { current: { provider: string; model: string } }
    detachCurrent(): Promise<void>
    open(id?: string): Promise<void>
    refresh(): void
    forkCurrentSession(boundary: number): Promise<void>
  }
  subject.handle = { agent: source }
  subject.selection = { current: { provider: 'deepseek', model: 'v4' } }
  subject.detachCurrent = async () => {}
  subject.open = async id => {
    opened.push(id ?? 'fresh')
    if (id === 'source') throw new Error('source was never persisted')
  }
  subject.refresh = () => {}

  await assert.rejects(subject.forkCurrentSession(1), /child create failed/)

  assert.deepEqual(capturedSeed.map(event => event.seq), [0, 1, 2])
  assert.deepEqual(opened, ['source', 'fresh'])
  assert.deepEqual(locks, [true, false])
  assert.equal(prompt.hasPendingImage(), false)
  assert.deepEqual(notices, [
    'Session change failed; opened a fresh session because the previous session could not be restored.',
  ])
})

test('shutdown aborts a late startup handle before the TUI can start', async () => {
  let createStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { createStarted = resolve })
  let releaseCreate: ((handle: object) => void) | undefined
  let disposed = 0
  let uiStarted = false
  const lateHandle = {
    agent: {},
    dispose: async () => { disposed += 1 },
  }
  const prompt = promptControllerWithPendingImage().controller
  const runner = runnerWith({
    get: () => undefined,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 128_000 } }) },
    agents: {
      create: async () => await new Promise<object>(resolve => {
        releaseCreate = resolve
        createStarted?.()
      }),
    },
  }, {
    start: () => { uiStarted = true },
  }, prompt)

  const starting = runner.start()
  await started
  const stopping = runner.shutdown(false)
  releaseCreate?.(lateHandle)
  await starting
  await stopping

  assert.equal(disposed, 1)
  assert.equal(uiStarted, false)
})

test('shutdown waits for an aborted session transition and never reopens a session', async () => {
  const order: string[] = []
  const prompt = promptControllerWithPendingImage().controller
  prompt.persistCurrentDraft = async () => { order.push('persist') }
  prompt.flushDrafts = async () => { order.push('flush') }
  let targetOpenStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { targetOpenStarted = resolve })
  const agent = {
    id: 'current', status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    session: { header: header('current', 1), events: [] },
  }
  const runner = runnerWith({
    get: () => undefined,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
    sessionPersistence: { inspect: async () => ({ meta: header('target', 2), events: [] }) },
  }, {
    setStatus: () => {},
    flashStatus: () => {},
  }, prompt)
  const subject = runner as unknown as {
    handle?: { agent: typeof agent }
    selection: { current: { provider: string; model: string } }
    detachCurrent(): Promise<void>
    open(id?: string, fallback?: unknown, signal?: AbortSignal): Promise<void>
    requestSessionSwitch(id: string): Promise<void>
  }
  subject.handle = { agent }
  subject.selection = { current: { provider: 'deepseek', model: 'v4' } }
  subject.detachCurrent = async () => {
    order.push(subject.handle === undefined ? 'shutdown-detach' : 'transition-detach')
    subject.handle = undefined
  }
  subject.open = async (_id, _fallback, signal) => {
    if (signal === undefined) {
      order.push('unexpected-reopen')
      return
    }
    order.push('target-open')
    targetOpenStarted?.()
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        order.push('target-aborted')
        reject(signal.reason)
      }, { once: true })
    })
  }

  const switching = subject.requestSessionSwitch('target')
  await started
  const stopping = runner.shutdown(false)
  await assert.rejects(switching, /shutting down/)
  await stopping

  assert.equal(order.includes('unexpected-reopen'), false)
  assert.ok(order.indexOf('target-aborted') < order.lastIndexOf('persist'))
  assert.deepEqual(order.slice(-3), ['persist', 'flush', 'shutdown-detach'])
})

test('Ctrl+C and shutdown cancel and await official Harness commands', async () => {
  const signals: AbortSignal[] = []
  let commandStarted: (() => void) | undefined
  let started = new Promise<void>(resolve => { commandStarted = resolve })
  const prompt = promptControllerWithPendingImage().controller
  const agent = {
    id: 'current', status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    session: { header: header('current', 1), events: [] },
  }
  const runner = runnerWith({
    get: () => undefined,
    commands: {
      execute: async (_agent: unknown, _line: string, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
        signals.push(signal)
        commandStarted?.()
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    },
  }, { setStatus: () => {} }, prompt)
  const subject = runner as unknown as {
    handle: { agent: typeof agent }
    detachCurrent(): Promise<void>
    runHarnessCommand(line: string): Promise<void>
  }
  subject.handle = { agent }
  subject.detachCurrent = async () => {}

  const interrupted = subject.runHarnessCommand('/compact')
  await started
  runner.interrupt()
  await interrupted
  assert.equal(signals[0]?.aborted, true)

  started = new Promise<void>(resolve => { commandStarted = resolve })
  const shuttingDown = subject.runHarnessCommand('/compact')
  await started
  const stopping = runner.shutdown(false)
  await Promise.all([shuttingDown, stopping])
  assert.equal(signals[1]?.aborted, true)
})

test('external shutdown lets an active prompt action settle before detaching', async () => {
  const order: string[] = []
  let beginStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { beginStarted = resolve })
  let releaseBegin: (() => void) | undefined
  const prompt = promptControllerWithPendingImage().controller
  prompt.beginPrompt = async () => {
    order.push('begin')
    beginStarted?.()
    await new Promise<void>(resolve => { releaseBegin = resolve })
    order.push('begin-complete')
    return 'current'
  }
  prompt.promptMessage = async () => ({ content: [] }) as never
  prompt.completePrompt = async () => { order.push('prompt-complete') }
  prompt.persistCurrentDraft = async () => { order.push('persist') }
  prompt.flushDrafts = async () => { order.push('flush') }
  const agent = {
    id: 'current', status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    session: { header: header('current', 1), events: [] },
    followup: () => { order.push('followup') },
  }
  const runner = runnerWith({ get: () => undefined }, {}, prompt)
  const subject = runner as unknown as {
    handle: { agent: typeof agent }
    detachCurrent(): Promise<void>
  }
  subject.handle = { agent }
  subject.detachCurrent = async () => { order.push('detach') }

  const submitting = runner.submit('finish this prompt')
  await started
  const stopping = runner.shutdown(false)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(order.includes('detach'), false)
  releaseBegin?.()
  await Promise.all([submitting, stopping])

  assert.deepEqual(order, [
    'begin', 'begin-complete', 'followup', 'prompt-complete', 'persist', 'flush', 'detach',
  ])
})

test('external shutdown closes an open action dialog before awaiting the queue', async () => {
  const order: string[] = []
  let dialogOpened: (() => void) | undefined
  const opened = new Promise<void>(resolve => { dialogOpened = resolve })
  let closeDialog: (() => void) | undefined
  const prompt = promptControllerWithPendingImage().controller
  const ui = {
    setComposerLocked: () => {},
    choose: async () => await new Promise<void>(resolve => {
      closeDialog = resolve
      dialogOpened?.()
    }),
    stop: () => {
      order.push('stop-ui')
      closeDialog?.()
    },
  }
  const runner = runnerWith({ get: () => undefined }, ui, prompt)
  const subject = runner as unknown as {
    started: boolean
    enqueueAction(action: () => Promise<void>): Promise<void>
    detachCurrent(): Promise<void>
  }
  subject.started = true
  subject.detachCurrent = async () => { order.push('detach') }

  const action = subject.enqueueAction(async () => {
    await ui.choose()
    order.push('dialog-closed')
  })
  await opened
  const stopping = runner.shutdown(false)
  await Promise.all([action, stopping])

  assert.deepEqual(order, ['stop-ui', 'dialog-closed', 'detach'])
})
