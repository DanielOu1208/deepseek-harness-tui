import { isTokenDelta } from '@deepseek-ai/dsh-llm';
export const DEFAULT_VISIBILITY_LIMITS = Object.freeze({
    maxTrajectoryRecords: 2_000,
    maxStepRecords: 512,
    maxToolRecords: 1_024,
    maxTextChars: 8_192,
});
class BoundedBuffer {
    capacity;
    slots;
    next = 0;
    size = 0;
    constructor(capacity) {
        this.capacity = capacity;
        this.slots = new Array(capacity);
    }
    add(value) {
        const replaced = this.slots[this.next];
        this.slots[this.next] = value;
        this.next = (this.next + 1) % this.capacity;
        this.size = Math.min(this.size + 1, this.capacity);
        return replaced;
    }
    values() {
        const first = this.size === this.capacity ? this.next : 0;
        const values = [];
        for (let index = 0; index < this.size; index += 1) {
            const value = this.slots[(first + index) % this.capacity];
            if (value !== undefined)
                values.push(value);
        }
        return values;
    }
}
function normalizeLimits(limits) {
    const merged = { ...DEFAULT_VISIBILITY_LIMITS, ...limits };
    for (const [key, value] of Object.entries(merged)) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new RangeError(`${key} must be a positive safe integer`);
        }
    }
    return merged;
}
function boundedText(value, limit) {
    if (value.length <= limit)
        return value;
    return `${value.slice(0, Math.max(0, limit - 1))}…`;
}
function boundedJson(value, limit) {
    if (typeof value === 'string')
        return boundedText(value, limit);
    try {
        const rendered = JSON.stringify(value);
        return boundedText(rendered === undefined ? String(value) : rendered, limit);
    }
    catch {
        return boundedText(String(value), limit);
    }
}
function contentSummary(value, limit) {
    if (!Array.isArray(value))
        return value === undefined ? undefined : boundedJson(value, limit);
    const pieces = [];
    let length = 0;
    for (const block of value) {
        let piece;
        if (typeof block === 'object' && block !== null) {
            const candidate = block;
            if (typeof candidate.text === 'string') {
                piece = candidate.text;
            }
            else if (candidate.type === 'tool-result') {
                const nested = contentSummary(candidate.content, limit);
                if (nested === undefined)
                    continue;
                piece = nested;
            }
            else {
                piece = boundedJson(block, limit);
            }
        }
        else {
            piece = boundedJson(block, limit);
        }
        pieces.push(piece);
        length += piece.length;
        if (length >= limit)
            break;
    }
    return boundedText(pieces.join(''), limit);
}
function zeroTokens() {
    return {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
}
function zeroTiming() {
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
    };
}
function tokenBuckets(usage) {
    return {
        uncachedInputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    };
}
function tokenBucketsEqual(left, right) {
    return left.uncachedInputTokens === right.uncachedInputTokens
        && left.outputTokens === right.outputTokens
        && left.cacheReadTokens === right.cacheReadTokens
        && left.cacheWriteTokens === right.cacheWriteTokens;
}
function replaceTokenSample(totals, previous, next) {
    return {
        uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
        outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
        cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
    };
}
function nonnegativeDuration(end, start) {
    return Math.max(0, end - start);
}
function stepId(turn, step) {
    return `step:${String(turn)}:${String(step)}`;
}
function toolKey(kind, callId) {
    return `${kind}:${callId}`;
}
function turnStatus(reason) {
    if (typeof reason !== 'object' || reason === null)
        return 'unknown';
    const kind = reason.kind;
    if (kind === 'completed')
        return 'completed';
    if (kind === 'aborted')
        return 'aborted';
    if (kind === 'interrupted')
        return 'interrupted';
    if (kind === 'cancelled')
        return 'cancelled';
    if (kind === 'blocked')
        return 'blocked';
    if (kind === 'max-tokens')
        return 'max-tokens';
    if (kind === 'error' || kind === 'failed')
        return 'failed';
    return 'unknown';
}
function updateDuration(record, endSeq, endedAt) {
    record.endSeq = endSeq;
    record.endedAt = endedAt;
    record.durationMs = nonnegativeDuration(endedAt, record.time);
}
function callIdFromToolResult(data) {
    return String(data.message.source.callId);
}
function codeDispatchStart(data, limit) {
    return {
        callId: String(data.subCallId),
        rootCallId: String(data.rootCallId),
        parentCallId: String(data.parentCallId),
        name: data.name,
        argumentsText: boundedJson(data.arguments, limit),
    };
}
class VisibilityAccumulator {
    sessionId;
    limits;
    lastSeq = -1;
    trajectoryBuffer;
    stepBuffer;
    toolBuffer;
    turns = new Map();
    steps = new Map();
    tools = new Map();
    trajectory = new Map();
    activeStep;
    lastClosedTurn;
    usageSample;
    timingTotals = zeroTiming();
    tokenTotals = zeroTokens();
    constructor(sessionId, limits) {
        this.sessionId = sessionId;
        this.limits = Object.freeze(normalizeLimits(limits));
        this.trajectoryBuffer = new BoundedBuffer(this.limits.maxTrajectoryRecords);
        this.stepBuffer = new BoundedBuffer(this.limits.maxStepRecords);
        this.toolBuffer = new BoundedBuffer(this.limits.maxToolRecords);
    }
    append(event) {
        if (event.seq <= this.lastSeq)
            return this;
        this.lastSeq = event.seq;
        this.fold(event);
        return this;
    }
    snapshot() {
        return snapshotVisibility(this);
    }
    readSnapshot() {
        return {
            ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
            lastSeq: this.lastSeq,
            trajectory: this.trajectoryBuffer.values().map(record => ({ ...record })),
            steps: this.stepBuffer.values().map(({ turnEndReason: _turnEndReason, ...record }) => ({ ...record })),
            tools: this.toolBuffer.values().map(record => ({ ...record })),
            timing: { ...this.timingTotals },
            tokens: { ...this.tokenTotals },
        };
    }
    addTrajectory(record) {
        const replaced = this.trajectoryBuffer.add(record);
        if (replaced !== undefined && this.trajectory.get(replaced.id) === replaced) {
            this.trajectory.delete(replaced.id);
        }
        this.trajectory.set(record.id, record);
        return record;
    }
    addStep(step) {
        this.steps.set(step.id, step);
        this.stepBuffer.add(step);
    }
    addTool(tool) {
        if (this.tools.size >= this.limits.maxToolRecords) {
            const oldest = this.tools.entries().next().value;
            if (oldest !== undefined) {
                const [key, dropped] = oldest;
                dropped.status = 'unknown';
                const droppedTrajectory = this.trajectory.get(dropped.id);
                if (droppedTrajectory !== undefined)
                    droppedTrajectory.status = 'unknown';
                this.tools.delete(key);
            }
        }
        this.tools.set(toolKey(tool.kind, tool.callId), tool);
        const replaced = this.toolBuffer.add(tool);
        if (replaced !== undefined && this.tools.get(toolKey(replaced.kind, replaced.callId)) === replaced) {
            replaced.status = 'unknown';
            const replacedTrajectory = this.trajectory.get(replaced.id);
            if (replacedTrajectory !== undefined)
                replacedTrajectory.status = 'unknown';
            this.tools.delete(toolKey(replaced.kind, replaced.callId));
        }
    }
    fold(event) {
        switch (event.type) {
            case 'turn/start': {
                const record = this.addTrajectory({
                    id: `turn:${String(event.data.turn)}`,
                    kind: 'turn',
                    seq: event.seq,
                    time: event.time,
                    turn: event.data.turn,
                    status: 'running',
                });
                this.turns.set(event.data.turn, { record, steps: [] });
                return;
            }
            case 'turn/end': {
                const turn = this.turns.get(event.data.turn);
                const status = turnStatus(event.data.reason);
                if (turn !== undefined) {
                    updateDuration(turn.record, event.seq, event.time);
                    turn.record.status = status;
                    for (const step of turn.steps) {
                        if (step.status === 'running' || step.status === 'completed') {
                            step.status = status === 'completed' ? 'completed' : status;
                        }
                        step.turnEndReason = status;
                        const stepTrajectory = this.trajectory.get(step.id);
                        if (stepTrajectory !== undefined)
                            stepTrajectory.status = step.status;
                    }
                }
                for (const [key, tool] of this.tools) {
                    if (tool.turn !== event.data.turn || tool.status !== 'running')
                        continue;
                    tool.status = 'interrupted';
                    tool.finishedAt = event.time;
                    tool.durationMs = nonnegativeDuration(event.time, tool.startedAt);
                    const toolTrajectory = this.trajectory.get(tool.id);
                    if (toolTrajectory !== undefined) {
                        updateDuration(toolTrajectory, event.seq, event.time);
                        toolTrajectory.status = 'interrupted';
                    }
                    this.tools.delete(key);
                }
                this.turns.delete(event.data.turn);
                return;
            }
            case 'step/start': {
                const step = {
                    id: stepId(event.data.turn, event.data.step),
                    turn: event.data.turn,
                    step: event.data.step,
                    startSeq: event.seq,
                    startedAt: event.time,
                    status: 'running',
                };
                this.addStep(step);
                this.activeStep = step;
                const turn = this.turns.get(event.data.turn);
                if (turn !== undefined) {
                    if (turn.steps.length >= this.limits.maxStepRecords)
                        turn.steps.shift();
                    turn.steps.push(step);
                }
                this.addTrajectory({
                    id: step.id,
                    kind: 'step',
                    seq: event.seq,
                    time: event.time,
                    turn: event.data.turn,
                    step: event.data.step,
                    status: 'running',
                });
                return;
            }
            case 'step/end': {
                const step = this.steps.get(stepId(event.data.turn, event.data.step));
                this.timingTotals.steps += 1;
                if (this.lastClosedTurn !== event.data.turn) {
                    this.timingTotals.turns += 1;
                    this.lastClosedTurn = event.data.turn;
                }
                if (step !== undefined) {
                    step.endSeq = event.seq;
                    step.completedAt = event.time;
                    step.status = step.turnEndReason === undefined || step.turnEndReason === 'completed'
                        ? 'completed'
                        : step.turnEndReason;
                    if (this.activeStep === step)
                        this.activeStep = undefined;
                    const trajectory = this.trajectory.get(step.id);
                    if (trajectory !== undefined) {
                        updateDuration(trajectory, event.seq, event.time);
                        trajectory.status = step.status;
                    }
                    this.steps.delete(step.id);
                }
                return;
            }
            case 'assistant/chunk': {
                if (this.activeStep === undefined
                    || this.activeStep.turn !== event.data.turn
                    || this.activeStep.step !== event.data.step
                    || this.activeStep.firstTokenAt !== undefined
                    || !isTokenDelta(event.data.chunk)) {
                    this.applyUsage(event.data.turn, event.data.step, event.data.chunk);
                    return;
                }
                this.activeStep.firstTokenAt = event.time;
                this.activeStep.ttftMs = nonnegativeDuration(event.time, this.activeStep.startedAt);
                this.applyUsage(event.data.turn, event.data.step, event.data.chunk);
                return;
            }
            case 'assistant/message': {
                const step = this.steps.get(stepId(event.data.turn, event.data.step));
                this.applyUsage(event.data.turn, event.data.step, event.data.usage);
                if (step === undefined || step.completedAt !== undefined)
                    return;
                step.completedAt = event.time;
                step.modelMs = nonnegativeDuration(event.time, step.startedAt);
                if (step.firstTokenAt !== undefined) {
                    step.ttftMs = nonnegativeDuration(step.firstTokenAt, step.startedAt);
                    if (event.data.usage !== undefined && isValidOutputTokens(event.data.usage.outputTokens)) {
                        step.decodeMs = nonnegativeDuration(event.time, step.firstTokenAt);
                        step.outputTokens = event.data.usage.outputTokens;
                    }
                }
                this.timingTotals.llmMs += step.modelMs;
                if (step.ttftMs !== undefined) {
                    this.timingTotals.ttftMs += step.ttftMs;
                    this.timingTotals.ttftSteps += 1;
                }
                if (step.decodeMs !== undefined && step.outputTokens !== undefined) {
                    this.timingTotals.decodeMs += step.decodeMs;
                    this.timingTotals.decodeTokens += step.outputTokens;
                }
                const trajectory = {
                    id: `assistant:${String(event.data.turn)}:${String(event.data.step)}:${String(event.seq)}`,
                    kind: 'assistant',
                    seq: event.seq,
                    time: event.time,
                    turn: event.data.turn,
                    step: event.data.step,
                    summary: contentSummary(event.data.message.content, this.limits.maxTextChars),
                };
                this.addTrajectory(trajectory);
                return;
            }
            case 'user/message': {
                this.addTrajectory({
                    id: `user:${String(event.seq)}`,
                    kind: 'user',
                    seq: event.seq,
                    time: event.time,
                    summary: contentSummary(event.data.content, this.limits.maxTextChars),
                });
                return;
            }
            case 'tool/call': {
                const callId = String(event.data.callId);
                const tool = {
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
                };
                this.addTool(tool);
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
                });
                return;
            }
            case 'tool/result': {
                const callId = callIdFromToolResult(event.data);
                const tool = this.tools.get(toolKey('tool', callId));
                const resultText = contentSummary(event.data.message.content, this.limits.maxTextChars);
                const resultIsError = event.data.message.content.some(block => (typeof block === 'object'
                    && block !== null
                    && block.type === 'tool-result'
                    && block.isError === true)) || event.data.error !== undefined;
                if (tool === undefined) {
                    const orphan = {
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
                    };
                    this.addTool(orphan);
                    this.addTrajectory({
                        id: orphan.id,
                        kind: 'tool',
                        seq: event.seq,
                        time: event.time,
                        callId,
                        name: orphan.name,
                        status: 'orphaned',
                        summary: resultText,
                    });
                    return;
                }
                tool.resultSeq = event.seq;
                tool.finishedAt = event.time;
                tool.durationMs = nonnegativeDuration(event.time, tool.startedAt);
                tool.status = resultIsError ? 'failed' : 'completed';
                tool.resultText = resultText;
                tool.resultMetaText = event.data.meta === undefined
                    ? undefined
                    : boundedJson(event.data.meta, this.limits.maxTextChars);
                tool.resultIsError = resultIsError;
                this.timingTotals.toolMs += tool.durationMs;
                const trajectory = this.trajectory.get(tool.id);
                if (trajectory !== undefined) {
                    updateDuration(trajectory, event.seq, event.time);
                    trajectory.status = tool.status;
                }
                this.tools.delete(toolKey('tool', callId));
                return;
            }
            case 'tool/code-dispatch-start': {
                const start = codeDispatchStart(event.data, this.limits.maxTextChars);
                const tool = {
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
                };
                this.addTool(tool);
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
                });
                return;
            }
            case 'tool/code-dispatch': {
                this.finishSubtool(event, event.data);
                return;
            }
            default:
                return;
        }
    }
    finishSubtool(event, data) {
        const callId = String(data.subCallId);
        const tool = this.tools.get(toolKey('subtool', callId));
        const resultText = contentSummary(data.content, this.limits.maxTextChars);
        if (tool === undefined) {
            const orphan = {
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
            };
            this.addTool(orphan);
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
            });
            return;
        }
        tool.resultSeq = event.seq;
        tool.finishedAt = event.time;
        tool.durationMs = nonnegativeDuration(event.time, tool.startedAt);
        tool.status = data.isError ? 'failed' : 'completed';
        tool.resultText = resultText;
        tool.resultIsError = data.isError;
        this.timingTotals.subtoolMs += tool.durationMs;
        const trajectory = this.trajectory.get(tool.id);
        if (trajectory !== undefined) {
            updateDuration(trajectory, event.seq, event.time);
            trajectory.status = tool.status;
        }
        this.tools.delete(toolKey('subtool', callId));
    }
    applyUsage(turn, step, usageOrChunk) {
        const usage = usageFrom(usageOrChunk);
        if (usage === undefined)
            return;
        const buckets = tokenBuckets(usage);
        const previous = this.usageSample?.turn === turn && this.usageSample.step === step
            ? this.usageSample.buckets
            : undefined;
        if (previous !== undefined && tokenBucketsEqual(previous, buckets))
            return;
        this.tokenTotals = replaceTokenSample(this.tokenTotals, previous, buckets);
        this.usageSample = { turn, step, buckets };
        const current = this.steps.get(stepId(turn, step));
        if (current !== undefined)
            current.usage = { ...buckets };
    }
}
function usageFrom(value) {
    if (isUsageChunk(value))
        return value.usage;
    if (isTokenUsage(value))
        return value;
    return undefined;
}
function isUsageChunk(value) {
    return typeof value === 'object'
        && value !== null
        && value.type === 'usage'
        && isTokenUsage(value.usage);
}
function isTokenUsage(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    return typeof candidate.inputTokens === 'number'
        && Number.isFinite(candidate.inputTokens)
        && candidate.inputTokens >= 0
        && typeof candidate.outputTokens === 'number'
        && Number.isFinite(candidate.outputTokens)
        && candidate.outputTokens >= 0;
}
function isValidOutputTokens(value) {
    return Number.isFinite(value) && value >= 0;
}
/** Create an incremental visibility fold for one session. */
export function createVisibilityProjection(sessionId, limits) {
    return new VisibilityAccumulator(sessionId, limits);
}
/** Append one event in sequence order; duplicate/older sequence numbers are ignored. */
export function foldVisibilityEvent(projection, event) {
    return projection.append(event);
}
/** Replay an event iterable and return an immutable-by-convention snapshot. */
export function projectVisibility(events, sessionId, limits) {
    const projection = createVisibilityProjection(sessionId, limits);
    for (const event of events)
        projection.append(event);
    return projection.snapshot();
}
/** Copy the bounded public view without exposing mutable fold internals. */
export function snapshotVisibility(projection) {
    if (projection instanceof VisibilityAccumulator)
        return projection.readSnapshot();
    return projection.snapshot();
}
