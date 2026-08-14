export function createProjection(sessionId) {
    return { sessionId, entries: [], running: false, activeTools: [], todos: [], compacting: false, planMode: false };
}
function replaceEntry(entries, entry) {
    const index = entries.findIndex(candidate => candidate.id === entry.id);
    if (index < 0)
        return [...entries, entry];
    const next = [...entries];
    next[index] = entry;
    return next;
}
function systemEntry(state, id, text, error = false) {
    return replaceEntry(state.entries, {
        id: `system:${id}`,
        role: 'system',
        kind: 'text',
        text,
        streaming: false,
        ...(error ? { error: true } : {}),
    });
}
function textFromBlocks(content) {
    if (!Array.isArray(content))
        return '';
    return content.flatMap((block) => {
        if (typeof block !== 'object' || block === null)
            return [];
        const value = block;
        if ((value.type === 'text' || value.type === 'reasoning') && typeof value.text === 'string')
            return [value.text];
        if (value.type === 'tool-result')
            return [textFromBlocks(value.content)];
        return [];
    }).join('');
}
function parseToolArguments(value) {
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function toolResultBlock(data) {
    const blocks = data?.message?.content;
    return Array.isArray(blocks) ? blocks.find((block) => block?.type === 'tool-result') : undefined;
}
function toolCallIdFromResult(data) {
    const source = data?.message?.source;
    if (source?.kind === 'tool' && typeof source.callId === 'string')
        return source.callId;
    const result = toolResultBlock(data);
    return typeof result?.toolCallId === 'string' ? result.toolCallId : undefined;
}
function safePresentation(project) {
    if (project === undefined)
        return undefined;
    try {
        const value = project();
        return typeof value === 'object' && value !== null ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function validDiffs(value) {
    if (!Array.isArray(value) || value.length === 0)
        return undefined;
    const diffs = [];
    for (const candidate of value) {
        if (typeof candidate !== 'object' || candidate === null)
            return undefined;
        const diff = candidate;
        if (typeof diff.path !== 'string' || (diff.oldText !== null && typeof diff.oldText !== 'string') || typeof diff.newText !== 'string') {
            return undefined;
        }
        diffs.push({ path: diff.path, oldText: diff.oldText, newText: diff.newText });
    }
    return diffs;
}
function blocksText(value) {
    const text = textFromBlocks(value).trim();
    return text === '' ? undefined : text;
}
function pretty(value) {
    if (value === undefined)
        return undefined;
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
function callPresentationDetail(view, argumentsValue) {
    if (view?.card === 'terminal') {
        return [view.description, view.cwd ? `cwd: ${String(view.cwd)}` : undefined].filter(Boolean).join('\n') || undefined;
    }
    if (view?.card === 'generic') {
        return [pretty(view.rawInput), blocksText(view.content)].filter(Boolean).join('\n\n') || undefined;
    }
    return view === undefined ? pretty(argumentsValue) : undefined;
}
function resultPresentationDetail(view, fallback) {
    switch (view?.card) {
        case 'terminal': {
            const status = typeof view.exitCode === 'number'
                ? `exit ${String(view.exitCode)}`
                : typeof view.signal === 'string' ? `signal ${view.signal}` : undefined;
            return [typeof view.output === 'string' ? view.output : undefined, status].filter(Boolean).join('\n') || fallback;
        }
        case 'generic':
            return blocksText(view.content) ?? fallback;
        case 'read': {
            const lines = Array.isArray(view.lines)
                ? view.lines.filter((line) => Number.isInteger(line?.number) && typeof line?.text === 'string')
                    .map((line) => `${String(line.number).padStart(4)}│${line.text}`).join('\n')
                : '';
            return [`${String(view.path ?? 'file')} · ${String(view.totalLines ?? '?')} lines`, lines].filter(Boolean).join('\n') || fallback;
        }
        case 'search':
            if (view.shape === 'paths' && Array.isArray(view.paths)) {
                return [...view.paths.map(String), view.truncated ? `… ${String(view.total)} total` : undefined].filter(Boolean).join('\n') || fallback;
            }
            if (view.shape === 'matches' && Array.isArray(view.files)) {
                const matches = view.files.flatMap((file) => [
                    String(file?.path ?? ''),
                    ...(Array.isArray(file?.matches) ? file.matches.map((match) => `  ${String(match?.lineNumber ?? '?')}│${String(match?.line ?? '')}`) : []),
                ]).join('\n');
                return [matches, view.truncated ? `… ${String(view.total)} total matches` : undefined].filter(Boolean).join('\n') || fallback;
            }
            return fallback;
        case 'web':
            if (view.kind === 'fetch')
                return `${String(view.statusCode ?? '')} ${String(view.url ?? '')}${view.truncated ? ' · truncated' : ''}`.trim() || fallback;
            if (view.kind === 'search') {
                const sources = Array.isArray(view.sources)
                    ? view.sources.map((source) => `- ${String(source?.title ?? source?.url ?? 'source')}${source?.url ? ` · ${String(source.url)}` : ''}`).join('\n')
                    : '';
                return [typeof view.answer === 'string' ? view.answer : undefined, sources].filter(Boolean).join('\n\n') || fallback;
            }
            return fallback;
        default:
            return fallback;
    }
}
function assistantBlockEntries(data) {
    const content = Array.isArray(data?.message?.content) ? data.message.content : [];
    const turn = Number(data?.turn);
    const step = Number(data?.step);
    return content.flatMap((block, index) => {
        if (block?.type !== 'text' && block?.type !== 'reasoning')
            return [];
        return [{
                id: `assistant:${turn}:${step}:${block.type}:${index}`,
                role: 'assistant',
                kind: block.type,
                text: typeof block.text === 'string' ? block.text : '',
                streaming: false,
            }];
    });
}
export function foldSessionEvent(state, event, presenter) {
    const data = event.data;
    if (typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace')
        return state;
    switch (event.type) {
        case 'turn/start':
            return {
                ...state,
                running: true,
                lastError: undefined,
                todos: [],
                entries: state.entries.filter(entry => entry.id !== 'system:todos'),
            };
        case 'turn/end': {
            const reason = data?.reason;
            const lastError = reason?.kind === 'error'
                ? `${String(reason.error?.code ?? 'ERROR')}: ${String(reason.error?.message ?? 'Unknown error')}`
                : reason?.kind === 'max-tokens' ? 'Model reached its output-token limit' : undefined;
            const entries = state.entries.map((entry) => {
                if (!entry.streaming)
                    return entry;
                if (entry.kind !== 'tool')
                    return { ...entry, streaming: false };
                return {
                    ...entry,
                    streaming: false,
                    error: true,
                    detail: [entry.detail, `Turn ended without a durable result (${String(reason?.kind ?? 'unknown')}).`]
                        .filter(Boolean).join('\n\n'),
                };
            });
            return { ...state, entries, running: false, activeTools: [], ...(lastError === undefined ? {} : { lastError }) };
        }
        case 'request/header':
            return {
                ...state,
                retry: undefined,
                provider: data?.header?.config?.provider,
                model: data?.header?.config?.model,
                reasoningEffort: data?.header?.config?.reasoningEffort,
            };
        case 'user/message': {
            const text = textFromBlocks(data?.content);
            if (text === '')
                return state;
            const human = data?.source?.kind === 'user';
            return {
                ...state,
                entries: [...state.entries, {
                        id: `user:${event.seq}`,
                        role: human ? 'user' : 'system',
                        kind: 'text',
                        text,
                        streaming: false,
                    }],
            };
        }
        case 'assistant/chunk': {
            const chunk = data?.chunk;
            if (chunk?.type === 'usage' && chunk.usage !== undefined)
                return { ...state, usage: chunk.usage };
            if (chunk?.type !== 'text-delta' && chunk?.type !== 'reasoning-delta')
                return state;
            const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning';
            const id = `assistant:${String(data.turn)}:${String(data.step)}:${kind}:${String(chunk.index)}`;
            const previous = state.entries.find(entry => entry.id === id);
            const entry = {
                id,
                role: 'assistant',
                kind,
                text: `${previous?.text ?? ''}${String(chunk.text ?? '')}`,
                streaming: true,
            };
            return { ...state, entries: replaceEntry(state.entries, entry) };
        }
        case 'assistant/message': {
            let entries = state.entries.filter(entry => !entry.id.startsWith(`assistant:${String(data?.turn)}:${String(data?.step)}:`));
            for (const entry of assistantBlockEntries(data))
                entries = replaceEntry(entries, entry);
            return { ...state, entries, ...(data?.usage === undefined ? {} : { usage: data.usage }) };
        }
        case 'tool/call': {
            const id = String(data?.callId ?? `call-${event.seq}`);
            const name = String(data?.name ?? 'tool');
            const argumentsValue = parseToolArguments(data?.arguments);
            const view = safePresentation(presenter === undefined ? undefined : () => presenter.presentCall(name, argumentsValue));
            return {
                ...state,
                activeTools: [...state.activeTools.filter(tool => tool.id !== id), { id, name }],
                entries: replaceEntry(state.entries, {
                    id: `tool:${id}`,
                    role: 'tool',
                    kind: 'tool',
                    text: typeof view?.title === 'string' ? view.title : name,
                    detail: callPresentationDetail(view, argumentsValue),
                    diffs: validDiffs(view?.diffs),
                    toolName: name,
                    toolArguments: argumentsValue,
                    streaming: true,
                }),
            };
        }
        case 'tool/result': {
            const id = toolCallIdFromResult(data);
            if (id === undefined)
                return state;
            const prior = state.entries.find(entry => entry.id === `tool:${id}`);
            const block = toolResultBlock(data);
            const content = Array.isArray(block?.content) ? block.content : [];
            const text = textFromBlocks(content);
            const isError = data?.error !== undefined || block?.isError === true;
            const view = prior?.toolName === undefined
                ? undefined
                : safePresentation(presenter === undefined ? undefined : () => presenter.presentResult(prior.toolName, prior.toolArguments, {
                    content,
                    isError,
                    ...(data?.meta === undefined ? {} : { meta: data.meta }),
                }));
            return {
                ...state,
                activeTools: state.activeTools.filter(tool => tool.id !== id),
                entries: replaceEntry(state.entries, {
                    id: `tool:${id}`,
                    role: 'tool',
                    kind: 'tool',
                    text: typeof view?.title === 'string' ? view.title : prior?.text ?? prior?.toolName ?? 'tool',
                    detail: resultPresentationDetail(view, text || data?.error?.message || prior?.detail),
                    diffs: validDiffs(view?.diffs) ?? prior?.diffs,
                    toolName: prior?.toolName,
                    toolArguments: prior?.toolArguments,
                    error: isError,
                    streaming: false,
                }),
            };
        }
        case 'command/run': {
            const id = String(data?.commandId ?? event.seq);
            const name = String(data?.name ?? 'command');
            return {
                ...state,
                entries: replaceEntry(state.entries, {
                    id: `command:${id}`,
                    role: 'system',
                    kind: 'tool',
                    text: `/${name}`,
                    detail: typeof data?.args === 'string' && data.args.trim() !== '' ? data.args.trim() : undefined,
                    streaming: true,
                }),
            };
        }
        case 'command/done': {
            const id = String(data?.commandId ?? event.seq);
            const prior = state.entries.find(entry => entry.id === `command:${id}`);
            return {
                ...state,
                entries: replaceEntry(state.entries, {
                    id: `command:${id}`,
                    role: 'system',
                    kind: 'tool',
                    text: prior?.text ?? '/command',
                    detail: typeof data?.text === 'string' ? data.text : prior?.detail,
                    error: data?.kind === 'error',
                    streaming: false,
                }),
            };
        }
        case 'todo/write': {
            const todos = Array.isArray(data?.todos) ? data.todos : [];
            const lines = todos.map((todo) => `- [${todo?.status === 'completed' ? 'x' : ' '}] ${String(todo?.content ?? '')}`);
            return {
                ...state,
                todos,
                entries: systemEntry(state, 'todos', `Todos\n${lines.join('\n') || 'No active todos.'}`),
            };
        }
        case 'compaction/start':
            return {
                ...state,
                compacting: true,
                entries: systemEntry(state, `compaction:${String(data?.compactionId ?? 'current')}`, 'Compacting context…'),
            };
        case 'compaction/summary':
            return {
                ...state,
                compacting: true,
                entries: systemEntry(state, `compaction:${String(data?.compactionId ?? 'current')}`, `Context summary created · ${String(data?.shadowedTokenCount ?? '?')} tokens compacted`),
            };
        case 'compaction/end':
            return {
                ...state,
                compacting: false,
                ...(typeof data?.error === 'string' ? { lastError: `Compaction failed: ${data.error}` } : {}),
                entries: systemEntry(state, `compaction:${String(data?.compactionId ?? 'current')}`, typeof data?.error === 'string' ? `Compaction failed: ${data.error}` : 'Context compaction complete', typeof data?.error === 'string'),
            };
        case 'compaction/prune':
            return {
                ...state,
                entries: systemEntry(state, `prune:${event.seq}`, `Pruned ${String(data?.shadowedTokenCount ?? '?')} tokens from context`),
            };
        case 'plan/mode':
            return {
                ...state,
                planMode: data?.active === true,
                entries: systemEntry(state, 'plan', `Plan mode ${data?.active === true ? 'enabled' : 'disabled'}`),
            };
        case 'permission/preset':
            return {
                ...state,
                permissionPreset: typeof data?.preset === 'string' ? data.preset : state.permissionPreset,
                entries: systemEntry(state, 'permission', `Permission preset: ${String(data?.preset ?? 'unknown')}`),
            };
        case 'goal/change': {
            if (data?.operation === 'clear') {
                return { ...state, goal: undefined, entries: systemEntry(state, 'goal', 'Goal cleared') };
            }
            const goal = data?.goal;
            if (typeof goal?.objective !== 'string')
                return state;
            const projected = {
                objective: goal.objective,
                phase: String(goal.phase ?? 'active'),
                roundsStarted: Number(data?.roundsStarted ?? 0),
            };
            return {
                ...state,
                goal: projected,
                entries: systemEntry(state, 'goal', `Goal ${String(data?.operation ?? 'updated')} · ${projected.phase}\n${projected.objective}`),
            };
        }
        case 'approval/asked':
            return {
                ...state,
                entries: systemEntry(state, `approval:${String(data?.id ?? event.seq)}`, `Approval requested for ${String(data?.toolName ?? 'tool')}${data?.reason ? `\n${String(data.reason)}` : ''}`),
            };
        case 'approval/decided':
            return {
                ...state,
                entries: systemEntry(state, `approval:${String(data?.id ?? event.seq)}`, `Approval ${String(data?.outcome ?? 'decided')}`),
            };
        case 'llm/retry': {
            const retry = {
                provider: String(data?.provider ?? 'provider'),
                retry: Number(data?.retry ?? 0),
                ...(Number.isFinite(data?.maxRetries) ? { maxRetries: Number(data.maxRetries) } : {}),
                delayMs: Number(data?.delayMs ?? 0),
            };
            return {
                ...state,
                retry,
                entries: systemEntry({ ...state, entries: state.entries.filter(entry => !entry.id.startsWith(`assistant:${String(data?.turn)}:${String(data?.step)}:`)) }, `retry:${String(data?.retryId ?? event.seq)}`, `Retrying ${retry.provider} request ${String(retry.retry)}${retry.maxRetries === undefined ? '' : `/${String(retry.maxRetries)}`} in ${String(retry.delayMs)}ms`),
            };
        }
        default:
            return state;
    }
}
export function projectSession(sessionId, events, presenter) {
    return events.reduce((state, event) => foldSessionEvent(state, event, presenter), createProjection(sessionId));
}
