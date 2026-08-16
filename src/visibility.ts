import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isTokenDelta } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  CodeDispatchEventData,
  CodeDispatchStartEventData,
} from '@deepseek-ai/dsh-tools/types'

/** The four disjoint provider usage buckets used by the official token meter. */
export interface VisibilityTokenTotals {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Whole-log timing figures with the same semantics as rc.6 session-stats. */
export interface VisibilityTimingTotals {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  /** Nested Code Mode dispatch time, kept separate from official toolMs. */
  subtoolMs: number
}

export type VisibilityStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'aborted'
  | 'blocked'
  | 'interrupted'
  | 'max-tokens'
  | 'orphaned'
  | 'unknown'

export type VisibilityTrajectoryKind =
  | 'turn'
  | 'step'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'subtool'

/** A compact, renderer-neutral event/object row for a trajectory inspector. */
export interface VisibilityTrajectoryRecord {
  id: string
  kind: VisibilityTrajectoryKind
  seq: number
  time: number
  turn?: number
  step?: number
  endSeq?: number
  endedAt?: number
  durationMs?: number
  status?: VisibilityStatus
  callId?: string
  parentCallId?: string
  rootCallId?: string
  name?: string
  summary?: string
}

/** One model step and its independently inspectable timing facts. */
export interface VisibilityStepRecord {
  id: string
  turn: number
  step: number
  startSeq: number
  startedAt: number
  endSeq?: number
  completedAt?: number
  firstTokenAt?: number
  modelMs?: number
  ttftMs?: number
  decodeMs?: number
  outputTokens?: number
  usage?: VisibilityTokenTotals
  status: VisibilityStatus
}

/** One root tool call or nested Code Mode dispatch paired by its call id. */
export interface VisibilityToolRecord {
  id: string
  kind: 'tool' | 'subtool'
  callId: string
  turn?: number
  step?: number
  name: string
  startSeq: number
  startedAt: number
  resultSeq?: number
  finishedAt?: number
  durationMs?: number
  status: VisibilityStatus
  parentCallId?: string
  rootCallId?: string
  argumentsText?: string
  resultText?: string
  resultMetaText?: string
  resultIsError?: boolean
}

export interface VisibilitySnapshot {
  sessionId?: string
  lastSeq: number
  trajectory: readonly VisibilityTrajectoryRecord[]
  steps: readonly VisibilityStepRecord[]
  tools: readonly VisibilityToolRecord[]
  timing: VisibilityTimingTotals
  tokens: VisibilityTokenTotals
}

/** Per-record and collection limits. All limits are enforced by the fold. */
export interface VisibilityLimits {
  maxTrajectoryRecords: number
  maxStepRecords: number
  maxToolRecords: number
  maxTextChars: number
}

export const DEFAULT_VISIBILITY_LIMITS: Readonly<VisibilityLimits> = Object.freeze({
  maxTrajectoryRecords: 2_000,
  maxStepRecords: 512,
  maxToolRecords: 1_024,
  maxTextChars: 8_192,
})

interface MutableStep extends VisibilityStepRecord {
  turnEndReason?: string
}

type MutableTool = VisibilityToolRecord

interface MutableTurn {
  record: VisibilityTrajectoryRecord
  steps: MutableStep[]
}

interface UsageSample {
  turn: number
  step: number
  buckets: VisibilityTokenTotals
}

class BoundedBuffer<T> {
  private readonly slots: Array<T | undefined>
  private next = 0
  private size = 0

  constructor(private readonly capacity: number) {
    this.slots = new Array<T | undefined>(capacity)
  }

  add(value: T): T | undefined {
    const replaced = this.slots[this.next]
    this.slots[this.next] = value
    this.next = (this.next + 1) % this.capacity
    this.size = Math.min(this.size + 1, this.capacity)
    return replaced
  }

  values(): T[] {
    const first = this.size === this.capacity ? this.next : 0
    const values: T[] = []
    for (let index = 0; index < this.size; index += 1) {
      const value = this.slots[(first + index) % this.capacity]
      if (value !== undefined) values.push(value)
    }
    return values
  }
}

function normalizeLimits(limits?: Partial<VisibilityLimits>): VisibilityLimits {
  const merged = { ...DEFAULT_VISIBILITY_LIMITS, ...limits }
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${key} must be a positive safe integer`)
    }
  }
  return merged
}

function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

function boundedJson(value: unknown, limit: number): string {
  if (typeof value === 'string') return boundedText(value, limit)
  try {
    const rendered = JSON.stringify(value)
    return boundedText(rendered === undefined ? String(value) : rendered, limit)
  } catch {
    return boundedText(String(value), limit)
  }
}

function contentSummary(value: unknown, limit: number): string | undefined {
  if (!Array.isArray(value)) return value === undefined ? undefined : boundedJson(value, limit)
  const pieces: string[] = []
  let length = 0
  for (const block of value) {
    let piece: string
    if (typeof block === 'object' && block !== null) {
      const candidate = block as Record<string, unknown>
      if (typeof candidate.text === 'string') {
        piece = candidate.text
      } else if (candidate.type === 'tool-result') {
        const nested = contentSummary(candidate.content, limit)
        if (nested === undefined) continue
        piece = nested
      } else {
        piece = boundedJson(block, limit)
      }
    } else {
      piece = boundedJson(block, limit)
    }
    pieces.push(piece)
    length += piece.length
    if (length >= limit) break
  }
  return boundedText(pieces.join(''), limit)
}

function zeroTokens(): VisibilityTokenTotals {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

function zeroTiming(): VisibilityTimingTotals {
  return {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    subtoolMs: 0,
  }
}

function tokenBuckets(usage: TokenUsage): VisibilityTokenTotals {
  return {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

function tokenBucketsEqual(left: VisibilityTokenTotals, right: VisibilityTokenTotals): boolean {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
}

function replaceTokenSample(
  totals: VisibilityTokenTotals,
  previous: VisibilityTokenTotals | undefined,
  next: VisibilityTokenTotals,
): VisibilityTokenTotals {
  return {
    uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
    outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
  }
}

function nonnegativeDuration(end: number, start: number): number {
  return Math.max(0, end - start)
}

function stepId(turn: number, step: number): string {
  return `step:${String(turn)}:${String(step)}`
}

function toolKey(kind: VisibilityToolRecord['kind'], callId: string): string {
  return `${kind}:${callId}`
}

function turnStatus(reason: unknown): VisibilityStatus {
  if (typeof reason !== 'object' || reason === null) return 'unknown'
  const kind = (reason as Record<string, unknown>).kind
  if (kind === 'completed') return 'completed'
  if (kind === 'aborted') return 'aborted'
  if (kind === 'interrupted') return 'interrupted'
  if (kind === 'cancelled') return 'cancelled'
  if (kind === 'blocked') return 'blocked'
  if (kind === 'max-tokens') return 'max-tokens'
  if (kind === 'error' || kind === 'failed') return 'failed'
  return 'unknown'
}

function updateDuration(record: VisibilityTrajectoryRecord, endSeq: number, endedAt: number): void {
  record.endSeq = endSeq
  record.endedAt = endedAt
  record.durationMs = nonnegativeDuration(endedAt, record.time)
}

function callIdFromToolResult(data: { message: { source: { callId: unknown } } }): string {
  return String(data.message.source.callId)
}

function codeDispatchStart(data: CodeDispatchStartEventData, limit: number): {
  callId: string
  rootCallId: string
  parentCallId: string
  name: string
  argumentsText: string
} {
  return {
    callId: String(data.subCallId),
    rootCallId: String(data.rootCallId),
    parentCallId: String(data.parentCallId),
    name: data.name,
    argumentsText: boundedJson(data.arguments, limit),
  }
}

/** Mutable, O(1)-per-event accumulator. Call {@link snapshotVisibility} for a safe view. */
export interface VisibilityProjection {
  readonly sessionId?: string
  readonly limits: Readonly<VisibilityLimits>
  lastSeq: number
  append(event: VisibilityEvent): VisibilityProjection
  snapshot(): VisibilitySnapshot
}

interface VisibilityEventEnvelope<Type extends string, Data> {
  type: Type
  seq: number
  time: number
  data: Data
  ignorable?: true
}

/** rc.6 session events, including the public Code Mode event extension. */
export type VisibilityEvent = SessionEvent
  | VisibilityEventEnvelope<'tool/code-dispatch-start', CodeDispatchStartEventData>
  | VisibilityEventEnvelope<'tool/code-dispatch', CodeDispatchEventData>

class VisibilityAccumulator implements VisibilityProjection {
  readonly sessionId?: string
  readonly limits: Readonly<VisibilityLimits>
  lastSeq = -1

  private readonly trajectoryBuffer: BoundedBuffer<VisibilityTrajectoryRecord>
  private readonly stepBuffer: BoundedBuffer<MutableStep>
  private readonly toolBuffer: BoundedBuffer<MutableTool>
  private readonly turns = new Map<number, MutableTurn>()
  private readonly steps = new Map<string, MutableStep>()
  private readonly tools = new Map<string, MutableTool>()
  private readonly trajectory = new Map<string, VisibilityTrajectoryRecord>()
  private activeStep: MutableStep | undefined
  private lastClosedTurn: number | undefined
  private usageSample: UsageSample | undefined
  private timingTotals = zeroTiming()
  private tokenTotals = zeroTokens()

  constructor(sessionId: string | undefined, limits?: Partial<VisibilityLimits>) {
    this.sessionId = sessionId
    this.limits = Object.freeze(normalizeLimits(limits))
    this.trajectoryBuffer = new BoundedBuffer(this.limits.maxTrajectoryRecords)
    this.stepBuffer = new BoundedBuffer(this.limits.maxStepRecords)
    this.toolBuffer = new BoundedBuffer(this.limits.maxToolRecords)
  }

  append(event: VisibilityEvent): VisibilityProjection {
    if (event.seq <= this.lastSeq) return this
    this.lastSeq = event.seq
    this.fold(event)
    return this
  }

  snapshot(): VisibilitySnapshot {
    return snapshotVisibility(this)
  }

  readSnapshot(): VisibilitySnapshot {
    return {
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      lastSeq: this.lastSeq,
      trajectory: this.trajectoryBuffer.values().map(record => ({ ...record })),
      steps: this.stepBuffer.values().map(({ turnEndReason: _turnEndReason, ...record }) => ({ ...record })),
      tools: this.toolBuffer.values().map(record => ({ ...record })),
      timing: { ...this.timingTotals },
      tokens: { ...this.tokenTotals },
    }
  }

  private addTrajectory(record: VisibilityTrajectoryRecord): VisibilityTrajectoryRecord {
    const replaced = this.trajectoryBuffer.add(record)
    if (replaced !== undefined && this.trajectory.get(replaced.id) === replaced) {
      this.trajectory.delete(replaced.id)
    }
    this.trajectory.set(record.id, record)
    return record
  }

  private addStep(step: MutableStep): void {
    this.steps.set(step.id, step)
    this.stepBuffer.add(step)
  }

  private addTool(tool: MutableTool): void {
    if (this.tools.size >= this.limits.maxToolRecords) {
      const oldest = this.tools.entries().next().value as [string, MutableTool] | undefined
      if (oldest !== undefined) {
        const [key, dropped] = oldest
        dropped.status = 'unknown'
        const droppedTrajectory = this.trajectory.get(dropped.id)
        if (droppedTrajectory !== undefined) droppedTrajectory.status = 'unknown'
        this.tools.delete(key)
      }
    }
    this.tools.set(toolKey(tool.kind, tool.callId), tool)
    const replaced = this.toolBuffer.add(tool)
    if (replaced !== undefined && this.tools.get(toolKey(replaced.kind, replaced.callId)) === replaced) {
      replaced.status = 'unknown'
      const replacedTrajectory = this.trajectory.get(replaced.id)
      if (replacedTrajectory !== undefined) replacedTrajectory.status = 'unknown'
      this.tools.delete(toolKey(replaced.kind, replaced.callId))
    }
  }

  private fold(event: VisibilityEvent): void {
    switch (event.type) {
      case 'turn/start': {
        const record = this.addTrajectory({
          id: `turn:${String(event.data.turn)}`,
          kind: 'turn',
          seq: event.seq,
          time: event.time,
          turn: event.data.turn,
          status: 'running',
        })
        this.turns.set(event.data.turn, { record, steps: [] })
        return
      }
      case 'turn/end': {
        const turn = this.turns.get(event.data.turn)
        const status = turnStatus(event.data.reason)
        if (turn !== undefined) {
          updateDuration(turn.record, event.seq, event.time)
          turn.record.status = status
          for (const step of turn.steps) {
            if (step.status === 'running' || step.status === 'completed') {
              step.status = status === 'completed' ? 'completed' : status
            }
            step.turnEndReason = status
            const stepTrajectory = this.trajectory.get(step.id)
            if (stepTrajectory !== undefined) stepTrajectory.status = step.status
          }
        }
        for (const [key, tool] of this.tools) {
          if (tool.turn !== event.data.turn || tool.status !== 'running') continue
          tool.status = 'interrupted'
          tool.finishedAt = event.time
          tool.durationMs = nonnegativeDuration(event.time, tool.startedAt)
          const toolTrajectory = this.trajectory.get(tool.id)
          if (toolTrajectory !== undefined) {
            updateDuration(toolTrajectory, event.seq, event.time)
            toolTrajectory.status = 'interrupted'
          }
          this.tools.delete(key)
        }
        this.turns.delete(event.data.turn)
        return
      }
      case 'step/start': {
        const step: MutableStep = {
          id: stepId(event.data.turn, event.data.step),
          turn: event.data.turn,
          step: event.data.step,
          startSeq: event.seq,
          startedAt: event.time,
          status: 'running',
        }
        this.addStep(step)
        this.activeStep = step
        const turn = this.turns.get(event.data.turn)
        if (turn !== undefined) {
          if (turn.steps.length >= this.limits.maxStepRecords) turn.steps.shift()
          turn.steps.push(step)
        }
        this.addTrajectory({
          id: step.id,
          kind: 'step',
          seq: event.seq,
          time: event.time,
          turn: event.data.turn,
          step: event.data.step,
          status: 'running',
        })
        return
      }
      case 'step/end': {
        const step = this.steps.get(stepId(event.data.turn, event.data.step))
        this.timingTotals.steps += 1
        if (this.lastClosedTurn !== event.data.turn) {
          this.timingTotals.turns += 1
          this.lastClosedTurn = event.data.turn
        }
        if (step !== undefined) {
          step.endSeq = event.seq
          step.completedAt = event.time
          step.status = step.turnEndReason === undefined || step.turnEndReason === 'completed'
            ? 'completed'
            : step.turnEndReason as VisibilityStatus
          if (this.activeStep === step) this.activeStep = undefined
          const trajectory = this.trajectory.get(step.id)
          if (trajectory !== undefined) {
            updateDuration(trajectory, event.seq, event.time)
            trajectory.status = step.status
          }
          this.steps.delete(step.id)
        }
        return
      }
      case 'assistant/chunk': {
        if (this.activeStep === undefined
          || this.activeStep.turn !== event.data.turn
          || this.activeStep.step !== event.data.step
          || this.activeStep.firstTokenAt !== undefined
          || !isTokenDelta(event.data.chunk)) {
          this.applyUsage(event.data.turn, event.data.step, event.data.chunk)
          return
        }
        this.activeStep.firstTokenAt = event.time
        this.activeStep.ttftMs = nonnegativeDuration(event.time, this.activeStep.startedAt)
        this.applyUsage(event.data.turn, event.data.step, event.data.chunk)
        return
      }
      case 'assistant/message': {
        const step = this.steps.get(stepId(event.data.turn, event.data.step))
        this.applyUsage(event.data.turn, event.data.step, event.data.usage)
        if (step === undefined || step.completedAt !== undefined) return
        step.completedAt = event.time
        step.modelMs = nonnegativeDuration(event.time, step.startedAt)
        if (step.firstTokenAt !== undefined) {
          step.ttftMs = nonnegativeDuration(step.firstTokenAt, step.startedAt)
          if (event.data.usage !== undefined && isValidOutputTokens(event.data.usage.outputTokens)) {
            step.decodeMs = nonnegativeDuration(event.time, step.firstTokenAt)
            step.outputTokens = event.data.usage.outputTokens
          }
        }
        this.timingTotals.llmMs += step.modelMs
        if (step.ttftMs !== undefined) {
          this.timingTotals.ttftMs += step.ttftMs
          this.timingTotals.ttftSteps += 1
        }
        if (step.decodeMs !== undefined && step.outputTokens !== undefined) {
          this.timingTotals.decodeMs += step.decodeMs
          this.timingTotals.decodeTokens += step.outputTokens
        }
        const trajectory: VisibilityTrajectoryRecord = {
          id: `assistant:${String(event.data.turn)}:${String(event.data.step)}:${String(event.seq)}`,
          kind: 'assistant',
          seq: event.seq,
          time: event.time,
          turn: event.data.turn,
          step: event.data.step,
          summary: contentSummary(event.data.message.content, this.limits.maxTextChars),
        }
        this.addTrajectory(trajectory)
        return
      }
      case 'user/message': {
        this.addTrajectory({
          id: `user:${String(event.seq)}`,
          kind: 'user',
          seq: event.seq,
          time: event.time,
          summary: contentSummary(event.data.content, this.limits.maxTextChars),
        })
        return
      }
      case 'tool/call': {
        const callId = String(event.data.callId)
        const tool: MutableTool = {
          id: `tool:${callId}`,
          kind: 'tool',
          callId,
          turn: event.data.turn,
          step: event.data.step,
          name: event.data.name,
          startSeq: event.seq,
          startedAt: event.time,
          status: 'running',
          argumentsText: boundedText(event.data.arguments, this.limits.maxTextChars),
        }
        this.addTool(tool)
        this.addTrajectory({
          id: tool.id,
          kind: 'tool',
          seq: event.seq,
          time: event.time,
          turn: event.data.turn,
          step: event.data.step,
          callId,
          name: event.data.name,
          status: 'running',
        })
        return
      }
      case 'tool/result': {
        const callId = callIdFromToolResult(event.data)
        const tool = this.tools.get(toolKey('tool', callId))
        const resultText = contentSummary(event.data.message.content, this.limits.maxTextChars)
        const resultIsError = event.data.message.content.some(block => (
          typeof block === 'object'
          && block !== null
          && (block as unknown as Record<string, unknown>).type === 'tool-result'
          && (block as unknown as Record<string, unknown>).isError === true
        )) || event.data.error !== undefined
        if (tool === undefined) {
          const orphan: MutableTool = {
            id: `tool:${callId}`,
            kind: 'tool',
            callId,
            name: 'unknown',
            startSeq: event.seq,
            startedAt: event.time,
            resultSeq: event.seq,
            finishedAt: event.time,
            durationMs: 0,
            status: 'orphaned',
            resultText,
            resultMetaText: event.data.meta === undefined
              ? undefined
              : boundedJson(event.data.meta, this.limits.maxTextChars),
            resultIsError,
          }
          this.addTool(orphan)
          this.addTrajectory({
            id: orphan.id,
            kind: 'tool',
            seq: event.seq,
            time: event.time,
            callId,
            name: orphan.name,
            status: 'orphaned',
            summary: resultText,
          })
          return
        }
        tool.resultSeq = event.seq
        tool.finishedAt = event.time
        tool.durationMs = nonnegativeDuration(event.time, tool.startedAt)
        tool.status = resultIsError ? 'failed' : 'completed'
        tool.resultText = resultText
        tool.resultMetaText = event.data.meta === undefined
          ? undefined
          : boundedJson(event.data.meta, this.limits.maxTextChars)
        tool.resultIsError = resultIsError
        this.timingTotals.toolMs += tool.durationMs
        const trajectory = this.trajectory.get(tool.id)
        if (trajectory !== undefined) {
          updateDuration(trajectory, event.seq, event.time)
          trajectory.status = tool.status
        }
        this.tools.delete(toolKey('tool', callId))
        return
      }
      case 'tool/code-dispatch-start': {
        const start = codeDispatchStart(event.data, this.limits.maxTextChars)
        const tool: MutableTool = {
          id: `subtool:${start.callId}`,
          kind: 'subtool',
          callId: start.callId,
          turn: this.activeStep?.turn,
          step: this.activeStep?.step,
          name: start.name,
          startSeq: event.seq,
          startedAt: event.time,
          status: 'running',
          parentCallId: start.parentCallId,
          rootCallId: start.rootCallId,
          argumentsText: boundedText(start.argumentsText, this.limits.maxTextChars),
        }
        this.addTool(tool)
        this.addTrajectory({
          id: tool.id,
          kind: 'subtool',
          seq: event.seq,
          time: event.time,
          turn: tool.turn,
          step: tool.step,
          callId: start.callId,
          parentCallId: start.parentCallId,
          rootCallId: start.rootCallId,
          name: start.name,
          status: 'running',
        })
        return
      }
      case 'tool/code-dispatch': {
        this.finishSubtool(event, event.data)
        return
      }
      default:
        return
    }
  }

  private finishSubtool(event: VisibilityEvent, data: CodeDispatchEventData): void {
    const callId = String(data.subCallId)
    const tool = this.tools.get(toolKey('subtool', callId))
    const resultText = contentSummary(data.content, this.limits.maxTextChars)
    if (tool === undefined) {
      const orphan: MutableTool = {
        id: `subtool:${callId}`,
        kind: 'subtool',
        callId,
        name: data.name,
        startSeq: event.seq,
        startedAt: event.time,
        resultSeq: event.seq,
        finishedAt: event.time,
        durationMs: 0,
        status: 'orphaned',
        parentCallId: String(data.parentCallId),
        rootCallId: String(data.rootCallId),
        argumentsText: boundedJson(data.arguments, this.limits.maxTextChars),
        resultText,
        resultIsError: data.isError,
      }
      this.addTool(orphan)
      this.addTrajectory({
        id: orphan.id,
        kind: 'subtool',
        seq: event.seq,
        time: event.time,
        callId,
        parentCallId: orphan.parentCallId,
        rootCallId: orphan.rootCallId,
        name: orphan.name,
        status: 'orphaned',
        summary: resultText,
      })
      return
    }
    tool.resultSeq = event.seq
    tool.finishedAt = event.time
    tool.durationMs = nonnegativeDuration(event.time, tool.startedAt)
    tool.status = data.isError ? 'failed' : 'completed'
    tool.resultText = resultText
    tool.resultIsError = data.isError
    this.timingTotals.subtoolMs += tool.durationMs
    const trajectory = this.trajectory.get(tool.id)
    if (trajectory !== undefined) {
      updateDuration(trajectory, event.seq, event.time)
      trajectory.status = tool.status
    }
    this.tools.delete(toolKey('subtool', callId))
  }

  private applyUsage(turn: number, step: number, usageOrChunk: unknown): void {
    const usage = usageFrom(usageOrChunk)
    if (usage === undefined) return
    const buckets = tokenBuckets(usage)
    const previous = this.usageSample?.turn === turn && this.usageSample.step === step
      ? this.usageSample.buckets
      : undefined
    if (previous !== undefined && tokenBucketsEqual(previous, buckets)) return
    this.tokenTotals = replaceTokenSample(this.tokenTotals, previous, buckets)
    this.usageSample = { turn, step, buckets }
    const current = this.steps.get(stepId(turn, step))
    if (current !== undefined) current.usage = { ...buckets }
  }
}

function usageFrom(value: unknown): TokenUsage | undefined {
  if (isUsageChunk(value)) return value.usage
  if (isTokenUsage(value)) return value
  return undefined
}

function isUsageChunk(value: unknown): value is { type: 'usage'; usage: TokenUsage } {
  return typeof value === 'object'
    && value !== null
    && (value as Record<string, unknown>).type === 'usage'
    && isTokenUsage((value as Record<string, unknown>).usage)
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.inputTokens === 'number'
    && Number.isFinite(candidate.inputTokens)
    && candidate.inputTokens >= 0
    && typeof candidate.outputTokens === 'number'
    && Number.isFinite(candidate.outputTokens)
    && candidate.outputTokens >= 0
}

function isValidOutputTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

/** Create an incremental visibility fold for one session. */
export function createVisibilityProjection(
  sessionId?: string,
  limits?: Partial<VisibilityLimits>,
): VisibilityProjection {
  return new VisibilityAccumulator(sessionId, limits)
}

/** Append one event in sequence order; duplicate/older sequence numbers are ignored. */
export function foldVisibilityEvent(
  projection: VisibilityProjection,
  event: VisibilityEvent,
): VisibilityProjection {
  return projection.append(event)
}

/** Replay an event iterable and return an immutable-by-convention snapshot. */
export function projectVisibility(
  events: Iterable<VisibilityEvent>,
  sessionId?: string,
  limits?: Partial<VisibilityLimits>,
): VisibilitySnapshot {
  const projection = createVisibilityProjection(sessionId, limits)
  for (const event of events) projection.append(event)
  return projection.snapshot()
}

/** Copy the bounded public view without exposing mutable fold internals. */
export function snapshotVisibility(projection: VisibilityProjection): VisibilitySnapshot {
  if (projection instanceof VisibilityAccumulator) return projection.readSnapshot()
  return projection.snapshot()
}
