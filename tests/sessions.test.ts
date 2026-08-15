import test from 'node:test'
import assert from 'node:assert/strict'
import { DshTuiRunner } from '../src/index.js'

function header(id: string, createdAt: number, extra: Record<string, unknown> = {}) {
  return { version: 0, id, createdAt, cwd: `/work/${id}`, ...extra }
}

function titleEvent(title: string, seq: number, time: number) {
  return {
    type: 'session/title', seq, time,
    data: { title, messageSeqs: [], source: { kind: 'fallback' } },
  }
}

function runnerWith(ctx: object, ui: object): DshTuiRunner {
  return new DshTuiRunner(ctx as never, {}, ui as never)
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
  const runner = runnerWith({ sessionPersistence: persistence }, {})
  const subject = runner as unknown as {
    handle: { agent: typeof agent }
    sessionNavigatorCache: Map<string, unknown>
    loadSessionPickerItems(): Promise<Array<{ value: string; label: string; description?: string; searchText?: string }>>
  }
  subject.handle = { agent }

  const first = await subject.loadSessionPickerItems()
  assert.equal(first.length, 36)
  assert.equal(first[0]?.value, 'session-current')
  assert.equal(first.some(item => item.value === 'subagent-hidden'), false)
  assert.equal(first.find(item => item.value === 'session-2')?.label, 'Title 2')
  assert.match(first.find(item => item.value === 'session-2')?.searchText ?? '', /Title 2 session-2 \/work\/session-2/)
  assert.match(first.find(item => item.value === 'session-7')?.description ?? '', /title unavailable/)
  assert.ok(maxActive > 1)
  assert.ok(maxActive <= 8)

  const sessionTwoCalls = calls.get('session-2')
  await subject.loadSessionPickerItems()
  assert.equal(calls.get('session-2'), sessionTwoCalls)
  assert.equal(calls.get('session-7'), 2, 'failed inspections should be retried')

  snapshots = snapshots.map(snapshot => snapshot.header.id === 'session-2'
    ? { ...snapshot, revision: 'revision-2-b' }
    : snapshot)
  await subject.loadSessionPickerItems()
  assert.equal(calls.get('session-2'), (sessionTwoCalls ?? 0) + 1)

  snapshots = snapshots.filter(snapshot => snapshot.header.id !== 'session-3')
  await subject.loadSessionPickerItems()
  assert.equal(subject.sessionNavigatorCache.has('session-3'), false)
})

test('routes both navigator commands while preserving direct resume', async () => {
  const runner = runnerWith({}, {})
  const calls: string[] = []
  const subject = runner as unknown as {
    chooseSession(): Promise<void>
    requestSessionSwitch(id?: string): Promise<void>
  }
  subject.chooseSession = async () => { calls.push('choose') }
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
    chooseSession(): Promise<void>
  }
  subject.handle = { agent }

  const loading = subject.chooseSession()
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
  const runner = runnerWith({}, {
    setStatus: () => {},
    appendNotice: (notice: string) => { notices.push(notice) },
  })
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
})

test('does not publish the target when saving or closing the current session fails', async () => {
  const runner = runnerWith({}, { setStatus: () => {} })
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
  const runner = runnerWith({}, {
    setStatus: () => {},
    appendNotice: (notice: string) => { notices.push(notice) },
  })
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
})
