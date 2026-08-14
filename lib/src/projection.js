import { diffLines } from 'diff';
const DIFF_SUMMARY_MAX_FILES = 100;
const DIFF_SUMMARY_MAX_CHARS_PER_FILE = 20_000;
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
function systemEntry(state, id, text, systemKind = 'important', error = false, systemSummary) {
    return replaceEntry(state.entries, {
        id: `system:${id}`,
        role: 'system',
        kind: 'text',
        text,
        streaming: false,
        systemKind,
        ...(systemSummary === undefined ? {} : { systemSummary }),
        ...(error ? { error: true } : {}),
    });
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function stringField(record, field) {
    const value = record?.[field];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function arrayField(record, field) {
    const value = record?.[field];
    return Array.isArray(value) ? value : [];
}
function joinedFields(values, field) {
    const labels = values.flatMap(value => {
        const label = stringField(asRecord(value), field);
        return label === undefined ? [] : [label];
    });
    return labels.length === 0 ? undefined : labels.join(', ');
}
function knownContextForm(value) {
    switch (value) {
        case 'instructions':
        case 'catalog':
        case 'snapshot':
        case 'notice':
        case 'relay':
        case 'recall':
            return value;
        default:
            return 'opaque';
    }
}
function contextPresentation(source) {
    const record = asRecord(source);
    const sourceKind = stringField(record, 'kind') ?? 'unknown';
    const form = knownContextForm(record?.form);
    if (sourceKind === 'skill-invocation') {
        const name = stringField(record, 'name') ?? 'unknown';
        return { form, sourceKind, label: name, summary: `Skill loaded · ${name}` };
    }
    if (sourceKind === 'skill-catalog') {
        const count = arrayField(record, 'entries').length;
        const action = record?.update === true ? 'updated' : 'available';
        return { form, sourceKind, label: 'skills', summary: `Skills ${action} · ${String(count)}` };
    }
    if (sourceKind === 'agent-instructions') {
        const changes = arrayField(record, 'changes');
        const paths = joinedFields(changes, 'path');
        const action = record?.baseline === true ? 'loaded' : 'updated';
        const suffix = paths ?? `${String(changes.length)} file${changes.length === 1 ? '' : 's'}`;
        return { form, sourceKind, label: paths ?? 'workspace', summary: `Workspace instructions ${action} · ${suffix}` };
    }
    if (sourceKind === 'session-reference') {
        const references = arrayField(record, 'references');
        const labels = joinedFields(references, 'label');
        const suffix = labels ?? `${String(references.length)} session${references.length === 1 ? '' : 's'}`;
        return { form, sourceKind, label: labels ?? 'sessions', summary: `Session context recalled · ${suffix}` };
    }
    const label = sourceKind;
    if (form === 'notice') {
        return { form, sourceKind, label, summary: stringField(record, 'summary') ?? `Notice · ${label}` };
    }
    if (form === 'snapshot') {
        const sections = joinedFields(arrayField(record, 'sections'), 'name');
        return { form, sourceKind, label, summary: `Context snapshot${sections === undefined ? '' : ` · ${sections}`}` };
    }
    if (form === 'instructions')
        return { form, sourceKind, label, summary: `Instructions · ${label}` };
    if (form === 'catalog')
        return { form, sourceKind, label, summary: `Catalog · ${label}` };
    if (form === 'relay')
        return { form, sourceKind, label, summary: `Agent message · ${label}` };
    if (form === 'recall')
        return { form, sourceKind, label, summary: `Recalled context · ${label}` };
    if (sourceKind === 'plugin') {
        const plugin = stringField(record, 'plugin') ?? 'plugin';
        return { form, sourceKind, label: plugin, summary: `Plugin context · ${plugin}` };
    }
    return { form, sourceKind, label, summary: `Context · ${label}` };
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
            let status;
            if (typeof view.exitCode === 'number')
                status = `exit ${String(view.exitCode)}`;
            else if (typeof view.signal === 'string')
                status = `signal ${view.signal}`;
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
function toolErrorIdentity(error) {
    const record = asRecord(error);
    const name = stringField(record, 'name');
    const code = stringField(record, 'code');
    return [name, code].filter(Boolean).join(' · ') || undefined;
}
function appendErrorIdentity(detail, identity) {
    if (identity === undefined || detail?.includes(identity))
        return detail;
    return detail === undefined || detail === '' ? identity : `${detail}\n${identity}`;
}
function presentationCard(view) {
    switch (view?.card) {
        case 'terminal':
        case 'generic':
        case 'diff':
        case 'read':
        case 'search':
        case 'web':
            return view.card;
        default:
            return 'unknown';
    }
}
function contentLineCount(value) {
    if (value === undefined)
        return 0;
    let end = value.length;
    while (end > 0 && (value[end - 1] === '\n' || value[end - 1] === '\r'))
        end -= 1;
    if (end === 0)
        return 0;
    let lines = 1;
    let hasContent = false;
    for (let index = 0; index < end; index += 1) {
        const character = value[index];
        if (character === '\n')
            lines += 1;
        else if (character !== ' ' && character !== '\t' && character !== '\r')
            hasContent = true;
    }
    return hasContent ? lines : 0;
}
function diffLineCounts(diff) {
    const changes = diffLines(diff.oldText ?? '', diff.newText);
    return changes.reduce((total, change) => ({
        added: total.added + (change.added ? change.count ?? 0 : 0),
        removed: total.removed + (change.removed ? change.count ?? 0 : 0),
    }), { added: 0, removed: 0 });
}
function diffSummary(diffs) {
    if (diffs === undefined || diffs.length === 0)
        return undefined;
    const fileLabel = `${String(diffs.length)} file${diffs.length === 1 ? '' : 's'}`;
    const isBounded = diffs.length <= DIFF_SUMMARY_MAX_FILES && diffs.every(diff => (diff.oldText?.length ?? 0) + diff.newText.length <= DIFF_SUMMARY_MAX_CHARS_PER_FILE);
    if (!isBounded)
        return `${fileLabel} changed`;
    const counts = diffs.reduce((total, diff) => {
        const next = diffLineCounts(diff);
        return { added: total.added + next.added, removed: total.removed + next.removed };
    }, { added: 0, removed: 0 });
    return `${fileLabel} · +${String(counts.added)} −${String(counts.removed)}`;
}
function resultPresentationSummary(view, detail, diffs) {
    switch (view?.card) {
        case 'terminal': {
            let status;
            if (typeof view.exitCode === 'number') {
                status = `exit ${String(view.exitCode)}`;
            }
            else if (typeof view.signal === 'string') {
                status = `signal ${view.signal}`;
            }
            const lines = contentLineCount(typeof view.output === 'string' ? view.output : detail);
            return [status, lines > 0 ? `${String(lines)} line${lines === 1 ? '' : 's'}` : undefined]
                .filter(Boolean).join(' · ') || undefined;
        }
        case 'read': {
            const path = typeof view.path === 'string' ? view.path : undefined;
            const total = Number.isInteger(view.totalLines) ? `${String(view.totalLines)} lines` : undefined;
            return [path, total].filter(Boolean).join(' · ') || undefined;
        }
        case 'search': {
            const total = Number.isInteger(view.total) ? Number(view.total) : undefined;
            if (total === undefined)
                return undefined;
            const unit = view.shape === 'paths' ? 'path' : 'match';
            let plural = '';
            if (total !== 1)
                plural = unit === 'path' ? 's' : 'es';
            return `${String(total)} ${unit}${plural}${view.truncated ? ' · truncated' : ''}`;
        }
        case 'web':
            if (view.kind === 'fetch') {
                return [
                    Number.isInteger(view.statusCode) ? String(view.statusCode) : undefined,
                    typeof view.url === 'string' ? view.url : undefined,
                    view.truncated ? 'truncated' : undefined,
                ]
                    .filter(Boolean).join(' · ') || undefined;
            }
            if (view.kind === 'search' && Array.isArray(view.sources)) {
                return `${String(view.sources.length)} source${view.sources.length === 1 ? '' : 's'}${view.truncated ? ' · truncated' : ''}`;
            }
            return undefined;
        case 'diff':
            return diffSummary(diffs);
        default: {
            const lines = contentLineCount(detail);
            return lines > 1 ? `${String(lines)} lines` : undefined;
        }
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
        case 'request/context': {
            if (typeof data?.provider !== 'string' || typeof data?.model !== 'string')
                return state;
            const contextWindow = Number(data.contextWindow);
            const routeChanged = state.requestContext === undefined
                || state.requestContext.provider !== data.provider
                || state.requestContext.model !== data.model;
            return {
                ...state,
                requestContext: {
                    provider: data.provider,
                    model: data.model,
                    ...(Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
                },
                ...(routeChanged ? { contextUsageReady: false } : {}),
            };
        }
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
                        ...(human ? {} : { context: contextPresentation(data?.source) }),
                    }],
            };
        }
        case 'assistant/chunk': {
            const chunk = data?.chunk;
            if (chunk?.type === 'usage' && chunk.usage !== undefined) {
                return { ...state, usage: chunk.usage, contextUsageReady: true };
            }
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
            return {
                ...state,
                entries,
                ...(data?.usage === undefined
                    ? {}
                    : { usage: data.usage, contextUsageReady: true }),
            };
        }
        case 'tool/call': {
            const id = String(data?.callId ?? `call-${event.seq}`);
            const name = String(data?.name ?? 'tool');
            const argumentsValue = parseToolArguments(data?.arguments);
            if (name === 'ask_user_question') {
                return {
                    ...state,
                    activeTools: [...state.activeTools.filter(tool => tool.id !== id), { id, name }],
                };
            }
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
                    toolPresentation: { card: presentationCard(view) },
                    streaming: true,
                }),
            };
        }
        case 'tool/result': {
            const id = toolCallIdFromResult(data);
            if (id === undefined)
                return state;
            const prior = state.entries.find(entry => entry.id === `tool:${id}`);
            const active = state.activeTools.find(tool => tool.id === id);
            const block = toolResultBlock(data);
            const content = Array.isArray(block?.content) ? block.content : [];
            const text = textFromBlocks(content);
            const isError = data?.error !== undefined || block?.isError === true;
            if (prior === undefined && active?.name === 'ask_user_question') {
                const errorIdentity = toolErrorIdentity(data?.error);
                return {
                    ...state,
                    activeTools: state.activeTools.filter(tool => tool.id !== id),
                    entries: [...state.entries, {
                            id: `tool:${id}:result:${event.seq}`,
                            role: 'tool',
                            kind: 'tool',
                            text: isError ? 'User question failed' : 'User answered question',
                            detail: appendErrorIdentity(text || undefined, errorIdentity),
                            toolName: active.name,
                            error: isError,
                            streaming: false,
                        }],
                };
            }
            const view = prior?.toolName === undefined
                ? undefined
                : safePresentation(presenter === undefined ? undefined : () => presenter.presentResult(prior.toolName, prior.toolArguments, {
                    content,
                    isError,
                    ...(data?.meta === undefined ? {} : { meta: data.meta }),
                }));
            const errorIdentity = toolErrorIdentity(data?.error);
            const fallback = text || (isError ? errorIdentity : prior?.detail);
            const presentedDetail = resultPresentationDetail(view, fallback);
            const detail = isError ? appendErrorIdentity(presentedDetail, errorIdentity) : presentedDetail;
            const diffs = validDiffs(view?.diffs) ?? prior?.diffs;
            const card = view === undefined ? prior?.toolPresentation?.card ?? 'unknown' : presentationCard(view);
            return {
                ...state,
                activeTools: state.activeTools.filter(tool => tool.id !== id),
                entries: replaceEntry(state.entries, {
                    id: `tool:${id}`,
                    role: 'tool',
                    kind: 'tool',
                    text: typeof view?.title === 'string' ? view.title : prior?.text ?? prior?.toolName ?? 'tool',
                    detail,
                    diffs,
                    toolName: prior?.toolName,
                    toolArguments: prior?.toolArguments,
                    toolPresentation: {
                        card,
                        summary: resultPresentationSummary(view, detail, diffs) ?? prior?.toolPresentation?.summary,
                    },
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
            const active = todos.filter((todo) => todo?.status !== 'completed').length;
            return {
                ...state,
                todos,
                entries: systemEntry(state, 'todos', `Todos\n${lines.join('\n') || 'No active todos.'}`, 'todo', false, `Todos · ${String(active)} active`),
            };
        }
        case 'compaction/start':
            return {
                ...state,
                compacting: true,
                entries: systemEntry(state, `compaction:${String(data?.compactionId ?? 'current')}`, 'Compacting context…', 'routine'),
            };
        case 'compaction/summary':
            return {
                ...state,
                compacting: true,
                entries: systemEntry(state, `compaction:${String(data?.compactionId ?? 'current')}`, `Context summary created · ${String(data?.shadowedTokenCount ?? '?')} tokens compacted`, 'routine'),
            };
        case 'compaction/end':
            return {
                ...state,
                compacting: false,
                ...(typeof data?.error === 'string' ? { lastError: `Compaction failed: ${data.error}` } : {}),
                entries: systemEntry(state, `compaction:${String(data?.compactionId ?? 'current')}`, typeof data?.error === 'string' ? `Compaction failed: ${data.error}` : 'Context compaction complete', typeof data?.error === 'string' ? 'important' : 'routine', typeof data?.error === 'string'),
            };
        case 'compaction/prune':
            return {
                ...state,
                entries: systemEntry(state, `prune:${event.seq}`, `Pruned ${String(data?.shadowedTokenCount ?? '?')} tokens from context`, 'routine'),
            };
        case 'plan/mode':
            return {
                ...state,
                planMode: data?.active === true,
                entries: systemEntry(state, `plan:${event.seq}`, `Plan mode ${data?.active === true ? 'enabled' : 'disabled'}`, 'routine'),
            };
        case 'permission/preset':
            return {
                ...state,
                permissionPreset: typeof data?.preset === 'string' ? data.preset : state.permissionPreset,
                entries: systemEntry(state, `permission:${event.seq}`, `Permission preset: ${String(data?.preset ?? 'unknown')}`, 'routine'),
            };
        case 'goal/change': {
            if (data?.operation === 'clear') {
                return { ...state, goal: undefined, entries: systemEntry(state, `goal:${event.seq}`, 'Goal cleared', 'goal') };
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
                entries: systemEntry(state, `goal:${event.seq}`, `Goal ${String(data?.operation ?? 'updated')} · ${projected.phase}\n${projected.objective}`, 'goal'),
            };
        }
        case 'approval/asked':
            return state;
        case 'approval/decided':
            return {
                ...state,
                entries: systemEntry(state, `approval:${String(data?.id ?? 'unknown')}:${event.seq}`, `Approval ${String(data?.outcome ?? 'decided')}`, 'approval'),
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
                entries: systemEntry({ ...state, entries: state.entries.filter(entry => !entry.id.startsWith(`assistant:${String(data?.turn)}:${String(data?.step)}:`)) }, `retry:${String(data?.retryId ?? event.seq)}`, `Retrying ${retry.provider} request ${String(retry.retry)}${retry.maxRetries === undefined ? '' : `/${String(retry.maxRetries)}`} in ${String(retry.delayMs)}ms`, 'retry'),
            };
        }
        default:
            return state;
    }
}
export function projectSession(sessionId, events, presenter) {
    return events.reduce((state, event) => foldSessionEvent(state, event, presenter), createProjection(sessionId));
}
