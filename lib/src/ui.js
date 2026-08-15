import { CombinedAutocompleteProvider, Container, Editor, Input, Key, Markdown, ProcessTerminal, ScrollView, SelectList, SettingsList, Text, TuiAltScreen, VStack, fuzzyFilter, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, } from '@earendil-works/pi-tui';
const ansi = (code) => (text) => `\u001b[${code}m${text}\u001b[0m`;
const plain = (text) => text;
const dim = ansi('2');
const bold = ansi('1');
// Official DeepSeek brand blue from the source SVG: #4D6BFE.
const deepseekBlue = ansi('38;2;77;107;254');
const yellow = ansi('33');
const red = ansi('31');
const green = ansi('32');
const magenta = ansi('35');
const BANNER_CONTROLS = [
    '/ commands · @ files · F2 settings · Ctrl+C stop / ×2 exit · Ctrl+D exit · /help',
    'Shift+Tab plan/build · Shift+↑/↓ reasoning',
].join('\n');
const SUMMARY_MAX_CHARS = 120;
const NORMAL_REASONING_LINES = 3;
const NORMAL_REASONING_CHARS = 600;
const ERROR_DETAIL_LINES = 12;
const ERROR_DETAIL_CHARS = 4_000;
const DEBUG_DETAIL_LINES = 400;
const DEBUG_DETAIL_CHARS = 40_000;
const DEBUG_DIFF_FILES = 20;
const DEBUG_DIFF_SIDE_CHARS = 5_000;
/**
 * Remove terminal control strings supplied by models, tools, files, or plugins.
 * Newlines and tabs remain available to Markdown; raw CSI/OSC/DCS/APC/PM/SOS
 * sequences and other C0/C1 controls never reach the terminal renderer.
 *
 * This is a single-pass parser rather than a backtracking regex so hostile,
 * unterminated control strings cannot make rendering super-linear.
 */
export function sanitizeTerminalText(text) {
    const output = [];
    let index = 0;
    const consumeCsi = (start) => {
        let cursor = start;
        while (cursor < text.length) {
            const code = text.charCodeAt(cursor);
            if (code >= 0x40 && code <= 0x7e)
                return cursor + 1;
            if (code < 0x20 || code > 0x3f)
                return cursor;
            cursor += 1;
        }
        return cursor;
    };
    const consumeControlString = (start, bellTerminates) => {
        let cursor = start;
        while (cursor < text.length) {
            const code = text.charCodeAt(cursor);
            if ((bellTerminates && code === 0x07) || code === 0x9c)
                return cursor + 1;
            if (code === 0x1b && text.charCodeAt(cursor + 1) === 0x5c)
                return cursor + 2;
            cursor += 1;
        }
        return cursor;
    };
    while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code === 0x0d) {
            if (text.charCodeAt(index + 1) === 0x0a)
                index += 1;
            output.push('\n');
            index += 1;
            continue;
        }
        if (code === 0x1b) {
            const next = text.charCodeAt(index + 1);
            if (next === 0x5b) {
                index = consumeCsi(index + 2);
                continue;
            }
            if (next === 0x5d) {
                index = consumeControlString(index + 2, true);
                continue;
            }
            if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
                index = consumeControlString(index + 2, false);
                continue;
            }
            index += 1;
            while (index < text.length) {
                const intermediate = text.charCodeAt(index);
                if (intermediate < 0x20 || intermediate > 0x2f)
                    break;
                index += 1;
            }
            const final = text.charCodeAt(index);
            if (final >= 0x30 && final <= 0x7e)
                index += 1;
            continue;
        }
        if (code === 0x9b) {
            index = consumeCsi(index + 1);
            continue;
        }
        if (code === 0x9d) {
            index = consumeControlString(index + 1, true);
            continue;
        }
        if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
            index = consumeControlString(index + 1, false);
            continue;
        }
        const forbiddenControl = code <= 0x08
            || code === 0x0b
            || code === 0x0c
            || (code >= 0x0e && code <= 0x1f)
            || (code >= 0x7f && code <= 0x9f);
        if (!forbiddenControl)
            output.push(text[index]);
        index += 1;
    }
    return output.join('');
}
export function isSettingsShortcut(data) {
    return matchesKey(data, Key.f2);
}
export class CtrlCExitGate {
    windowMs;
    previousPress = Number.NEGATIVE_INFINITY;
    constructor(windowMs = 1_500) {
        this.windowMs = windowMs;
    }
    press(now = Date.now()) {
        const action = now - this.previousPress <= this.windowMs ? 'exit' : 'interrupt';
        this.previousPress = action === 'exit' ? Number.NEGATIVE_INFINITY : now;
        return action;
    }
    reset() {
        this.previousPress = Number.NEGATIVE_INFINITY;
    }
}
export function createCommandAutocomplete(commands, cwd) {
    const safeCommands = commands.map(command => ({
        ...command,
        name: sanitizeTerminalText(command.name),
        ...(command.description === undefined
            ? {}
            : { description: sanitizeTerminalText(command.description) }),
        ...(command.argumentHint === undefined
            ? {}
            : { argumentHint: sanitizeTerminalText(command.argumentHint) }),
    }));
    const provider = new CombinedAutocompleteProvider(safeCommands, cwd);
    return {
        getSuggestions: async (lines, cursorLine, cursorCol, options) => {
            const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, options);
            if (suggestions === null)
                return null;
            return {
                ...suggestions,
                items: suggestions.items.map(item => ({
                    ...item,
                    value: sanitizeTerminalText(item.value),
                    label: sanitizeTerminalText(item.label),
                    ...(item.description === undefined
                        ? {}
                        : { description: sanitizeTerminalText(item.description) }),
                })),
            };
        },
        applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
        shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) => provider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol),
    };
}
const disabledAutocomplete = {
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};
// Half-block raster generated from DeepSeek's official MIT-licensed SVG:
// https://github.com/deepseek-ai/DeepSeek-Coder-V2/blob/main/figures/logo.svg
const OFFICIAL_DEEPSEEK_RASTER = [
    '     ▄▄▄▄▄▄██    █▄',
    '  ▄██████████▄   ███▄▄▄▄█',
    ' ██████████████▄ ▀██████▀       ▄▄                                               ▄▄',
    '██▀▀▀████████████▄▄██▀▀      ▄▄ ██  ▄▄▄▄    ▄▄▄▄  ▄▄▄▄▄▄   ▄▄▄▄▄   ▄▄▄▄    ▄▄▄▄  ██   ▄▄',
    '██     ▀██████ ▀█████      ▄█▀▀ ██ ██▀▀▀█▄ ██▀▀▀█ ██▀▀▀██ ▄█▀▀▀█  ██▀▀▀█  ██▀▀██ ██ ▄██',
    '██▄       █████▄▄████      ██   ██ █  ███▀ █ ████ ██    █  ▀███▄▄ █  ███▀▄█ ████ ██ ██',
    '▀██        ▀████████       ▀█▄▄▄██ ██▄▄▄█  ██▄▄▄█ ██ ▄▄██ ▄▄▄▄▄██ ██▄▄▄█  █▄▄▄▄█ ██ ▀██',
    ' ▀██▄   ▄▄▄ ▀█████▀         ▀▀▀▀▀▀  ▀▀▀▀    ▀▀▀▀  ██ ▀▀    ▀▀▀▀▀   ▀▀▀▀    ▀▀▀▀  ▀▀   ▀▀',
    '   ███▄▄▄███▄▄█████▄                              ▀▀',
    '     ▀▀██████▀▀',
].join('\n');
export function renderLaunchBanner(sessionId, cwd) {
    return `${deepseekBlue(OFFICIAL_DEEPSEEK_RASTER)}\n\n${bold(deepseekBlue('DeepSeek Harness TUI'))}\n${dim(`session  ${sanitizeTerminalText(sessionId)}`)}\n${dim(`cwd      ${sanitizeTerminalText(cwd)}`)}\n${dim(BANNER_CONTROLS)}`;
}
function boundedDiffSource(text) {
    if (text.length <= DEBUG_DIFF_SIDE_CHARS)
        return text;
    const edge = Math.floor((DEBUG_DIFF_SIDE_CHARS - 32) / 2);
    return `${text.slice(0, edge)}\n… source omitted …\n${text.slice(-edge)}`;
}
function renderFileDiff(diff) {
    const path = sanitizeTerminalText(boundedDiffSource(diff.path)).replace(/\s+/gu, ' ');
    const oldLines = diff.oldText === null ? [] : sanitizeTerminalText(boundedDiffSource(diff.oldText)).split('\n');
    const newLines = sanitizeTerminalText(boundedDiffSource(diff.newText)).split('\n');
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix])
        prefix += 1;
    let suffix = 0;
    while (suffix < oldLines.length - prefix
        && suffix < newLines.length - prefix
        && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix])
        suffix += 1;
    const lines = [
        `--- ${diff.oldText === null ? '/dev/null' : path}`,
        `+++ ${path}`,
        ...oldLines.slice(0, prefix).map(line => ` ${line}`),
        ...oldLines.slice(prefix, oldLines.length - suffix).map(line => `-${line}`),
        ...newLines.slice(prefix, newLines.length - suffix).map(line => `+${line}`),
        ...(suffix === 0 ? [] : oldLines.slice(oldLines.length - suffix).map(line => ` ${line}`)),
    ];
    const maxLines = 80;
    if (lines.length <= maxLines)
        return lines.join('\n');
    const edge = Math.floor((maxLines - 1) / 2);
    return [...lines.slice(0, edge), `… ${String(lines.length - edge * 2)} diff lines omitted …`, ...lines.slice(-edge)].join('\n');
}
function renderDiffs(diffs, maxLines = DEBUG_DETAIL_LINES, maxChars = DEBUG_DETAIL_CHARS) {
    if (diffs === undefined || diffs.length === 0)
        return undefined;
    const retained = diffs.length <= DEBUG_DIFF_FILES
        ? diffs
        : [...diffs.slice(0, DEBUG_DIFF_FILES / 2), ...diffs.slice(-DEBUG_DIFF_FILES / 2)];
    const omitted = diffs.length - retained.length;
    const rendered = retained.map(renderFileDiff);
    if (omitted > 0)
        rendered.unshift(`… ${String(omitted)} files omitted …`);
    return `\`\`\`diff\n${debugPreview(rendered.join('\n\n'), maxLines, maxChars)}\n\`\`\``;
}
const selectTheme = {
    selectedPrefix: deepseekBlue,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: red,
};
const editorTheme = {
    borderColor: deepseekBlue,
    selectList: selectTheme,
};
const markdownTheme = {
    heading: text => bold(deepseekBlue(text)),
    link: deepseekBlue,
    linkUrl: dim,
    code: yellow,
    codeBlock: plain,
    codeBlockBorder: dim,
    quote: dim,
    quoteBorder: dim,
    hr: dim,
    listBullet: deepseekBlue,
    bold,
    italic: magenta,
    strikethrough: dim,
    underline: ansi('4'),
};
function lineCount(text) {
    let end = text.length;
    while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r'))
        end -= 1;
    if (end === 0)
        return 0;
    let lines = 1;
    let hasContent = false;
    for (let index = 0; index < end; index += 1) {
        const character = text[index];
        if (character === '\n')
            lines += 1;
        else if (character !== ' ' && character !== '\t' && character !== '\r')
            hasContent = true;
    }
    return hasContent ? lines : 0;
}
function oneLine(text, maxChars = SUMMARY_MAX_CHARS) {
    const compact = sanitizeTerminalText(text).replace(/\s+/gu, ' ').trim();
    if (compact.length <= maxChars)
        return compact;
    return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
function tailPreview(text, maxLines, maxChars) {
    const trimmed = text.trim();
    const omittedChars = trimmed.length > maxChars;
    const charBounded = omittedChars ? trimmed.slice(-maxChars) : trimmed;
    const lines = charBounded.split('\n');
    const retainedLines = lines.slice(-maxLines);
    const retained = retainedLines.join('\n');
    const omittedLines = Math.max(0, lines.length - retainedLines.length);
    if (omittedLines === 0 && !omittedChars)
        return retained;
    let marker = '… earlier content omitted …';
    if (omittedLines > 0) {
        const unit = omittedLines === 1 ? 'line' : 'lines';
        marker = `… ${String(omittedLines)} earlier ${unit} omitted …`;
    }
    return `${marker}\n${retained}`;
}
function debugPreview(text, maxLines = DEBUG_DETAIL_LINES, maxChars = DEBUG_DETAIL_CHARS) {
    const trimmed = text.trim();
    let bounded = trimmed;
    if (bounded.length > maxChars) {
        const edge = Math.floor((maxChars - 32) / 2);
        bounded = `${bounded.slice(0, edge)}\n… content omitted …\n${bounded.slice(-edge)}`;
    }
    const lines = bounded.split('\n');
    if (lines.length > maxLines) {
        const edge = Math.floor((maxLines - 1) / 2);
        bounded = [
            ...lines.slice(0, edge),
            `… ${String(lines.length - edge * 2)} lines omitted …`,
            ...lines.slice(-edge),
        ].join('\n');
    }
    return bounded;
}
function detailBlock(detail) {
    return detail === undefined || detail === '' ? '' : `\n\n\`\`\`text\n${detail}\n\`\`\``;
}
function formatReasoning(entry, text, density) {
    const lines = lineCount(text);
    if (density === 'debug')
        return `${dim('Thinking')}\n${dim(debugPreview(text || '…'))}`;
    if (!entry.streaming)
        return dim(`Thinking · ${String(lines)} line${lines === 1 ? '' : 's'}`);
    if (density === 'compact')
        return dim('Thinking…');
    const preview = tailPreview(text || '…', NORMAL_REASONING_LINES, NORMAL_REASONING_CHARS);
    return `${dim('Thinking…')}\n${dim(preview)}`;
}
function formatTool(entry, text, density) {
    let mark;
    if (entry.error)
        mark = red('✗');
    else if (entry.streaming)
        mark = yellow('◆');
    else
        mark = green('✓');
    const header = `${mark} ${bold(text)}`;
    const detail = entry.detail === undefined ? undefined : sanitizeTerminalText(entry.detail).trim();
    if (entry.error) {
        let errorDetail;
        if (detail !== undefined) {
            errorDetail = density === 'debug'
                ? debugPreview(detail)
                : tailPreview(detail, ERROR_DETAIL_LINES, ERROR_DETAIL_CHARS);
        }
        return `${header}${detailBlock(errorDetail)}`;
    }
    if (density === 'compact')
        return header;
    if (density === 'debug') {
        const hasDetail = detail !== undefined && detail !== '';
        const hasDiffs = entry.diffs !== undefined && entry.diffs.length > 0;
        const maxLines = hasDetail && hasDiffs ? DEBUG_DETAIL_LINES / 2 : DEBUG_DETAIL_LINES;
        const maxChars = hasDetail && hasDiffs ? DEBUG_DETAIL_CHARS / 2 : DEBUG_DETAIL_CHARS;
        const boundedDetail = hasDetail ? debugPreview(detail, maxLines, maxChars) : undefined;
        const diff = renderDiffs(entry.diffs, maxLines, maxChars);
        return `${header}${detailBlock(boundedDetail)}${diff ? `\n\n${diff}` : ''}`;
    }
    if (entry.streaming)
        return header;
    const summary = entry.toolPresentation?.summary === undefined
        ? undefined
        : oneLine(entry.toolPresentation.summary);
    const card = entry.toolPresentation?.card ?? 'unknown';
    const canPreview = card === 'generic' || card === 'unknown';
    const preview = canPreview && entry.toolName !== 'ask_user_question' && detail
        ? oneLine(detail)
        : undefined;
    const suffix = [summary, preview].filter((part, index, parts) => part !== undefined && part !== '' && parts.indexOf(part) === index).join(' · ');
    return suffix === '' ? header : `${header} ${dim(`· ${suffix}`)}`;
}
function formatContext(entry, text, density) {
    const context = entry.context;
    const summary = oneLine(context.summary);
    if (density === 'debug') {
        return `${yellow(`Context · ${oneLine(context.label)}`)}\n${debugPreview(text)}`;
    }
    if (density === 'normal' && (context.form === 'relay' || context.form === 'opaque')) {
        const preview = oneLine(text);
        if (preview !== '' && preview !== summary)
            return dim(`◇ ${summary} · ${preview}`);
    }
    return dim(`◇ ${summary}`);
}
function formatSystem(entry, text, density) {
    if (entry.error) {
        const detail = density === 'debug'
            ? debugPreview(text)
            : tailPreview(text, ERROR_DETAIL_LINES, ERROR_DETAIL_CHARS);
        return `${red('✗')} ${detail}`;
    }
    if (density === 'debug')
        return `${yellow('System')}\n${debugPreview(text)}`;
    if (entry.systemKind === 'routine')
        return undefined;
    if (entry.systemKind === 'todo') {
        return density === 'compact' ? undefined : dim(entry.systemSummary ?? 'Todos updated');
    }
    return `${yellow('◇')} ${oneLine(entry.systemSummary ?? text)}`;
}
export function formatEntry(entry, density = 'normal') {
    const text = sanitizeTerminalText(entry.text);
    if (entry.kind === 'reasoning')
        return formatReasoning(entry, text, density);
    if (entry.kind === 'tool')
        return formatTool(entry, text, density);
    if (entry.role === 'user')
        return `${deepseekBlue('You')}\n${text}`;
    if (entry.context !== undefined)
        return formatContext(entry, text, density);
    if (entry.role === 'system')
        return formatSystem(entry, text, density);
    return text || '…';
}
class TranscriptRow {
    content;
    markdown;
    setContent(content) {
        if (content === this.content)
            return;
        this.content = content;
        if (content === undefined) {
            this.markdown = undefined;
            return;
        }
        if (this.markdown === undefined) {
            this.markdown = new Markdown(content, 1, 1, markdownTheme, undefined, { renderLatex: true });
        }
        else
            this.markdown.setText(content);
    }
    invalidate() {
        this.markdown?.invalidate();
    }
    render(width) {
        return this.markdown?.render(width) ?? [];
    }
}
function formatScaledTokens(value) {
    return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}
function formatTokens(value) {
    if (value < 1_000)
        return String(value);
    if (value < 1_000_000)
        return `${formatScaledTokens(value / 1_000)}K`;
    return `${formatScaledTokens(value / 1_000_000)}M`;
}
function formatContextWindow(context, compact) {
    const capacity = formatTokens(context.capacityTokens);
    const used = context.usedTokens === undefined ? '—' : `~${formatTokens(context.usedTokens)}`;
    if (compact)
        return `c:${used}/${capacity}`;
    if (context.usedTokens === undefined)
        return `ctx ${used}/${capacity}`;
    const percent = Math.min(100, Math.round(context.usedTokens / context.capacityTokens * 100));
    return `ctx ${used}/${capacity} (${String(percent)}%)`;
}
export class StatusLine {
    state;
    note = '';
    isFollowingOutput = () => true;
    setFollowingOutputProvider(provider) {
        this.isFollowingOutput = provider;
    }
    update(state, note) {
        this.state = state;
        if (note !== undefined)
            this.note = sanitizeTerminalText(note);
    }
    setNote(note) {
        this.note = sanitizeTerminalText(note);
    }
    invalidate() { }
    render(width) {
        if (this.state === undefined)
            return [truncateToWidth(dim(this.note), width, '')];
        const state = this.state;
        const followingOutput = this.isFollowingOutput();
        const compactPrimary = width < 75 || (!followingOutput && width < 105);
        const separator = dim(compactPrimary ? '│' : ' │ ');
        const activity = state.lastError !== undefined
            ? red(compactPrimary ? 'err' : 'error')
            : state.compacting
                ? yellow(compactPrimary ? 'cmp' : 'compacting')
                : state.running ? yellow(compactPrimary ? 'run' : 'running') : green('idle');
        const effort = truncateToWidth(sanitizeTerminalText(state.reasoningEffort ?? 'default'), compactPrimary ? 8 : 16, '…');
        const reasoning = deepseekBlue(`${compactPrimary ? 'r:' : 'reason:'}${effort}`);
        const mode = state.planMode ? deepseekBlue('plan') : dim('build');
        const permissionName = sanitizeTerminalText(state.permissionPreset ?? 'permission?');
        const permissionLabel = !compactPrimary ? permissionName : ({
            'danger-full-access': 'F',
            'workspace-write': 'W',
            'read-only': 'R',
            'permission?': '?',
        }[permissionName] ?? 'C');
        const permission = permissionName === 'danger-full-access'
            ? red(permissionLabel)
            : permissionName === 'workspace-write' || permissionName === 'custom' || permissionLabel === 'C'
                ? yellow(permissionLabel)
                : green(permissionLabel);
        const scroll = followingOutput
            ? undefined
            : yellow(compactPrimary ? 'End↑' : 'history ↑ · End to latest');
        const contextWindow = state.contextWindow;
        const context = contextWindow === undefined || width < 55
            ? undefined
            : deepseekBlue(formatContextWindow(contextWindow, compactPrimary));
        const fixedPrimary = [activity, reasoning, mode, permission, ...(context === undefined ? [] : [context]), ...(scroll === undefined ? [] : [scroll])];
        const modelBudget = Math.max(3, width - fixedPrimary.reduce((total, segment) => total + visibleWidth(segment), 0)
            - visibleWidth(separator) * fixedPrimary.length);
        const rawModel = state.provider && state.model
            ? width >= 100 && !compactPrimary
                ? `${sanitizeTerminalText(state.provider)}/${sanitizeTerminalText(state.model)}`
                : sanitizeTerminalText(state.model)
            : 'model unavailable';
        const modelText = truncateToWidth(rawModel, modelBudget, '…');
        const model = state.provider && state.model ? deepseekBlue(modelText) : dim(modelText);
        const primary = [model, reasoning, mode, permission, ...(context === undefined ? [] : [context]), activity, ...(scroll === undefined ? [] : [scroll])];
        let output = primary.join(separator);
        const tools = state.activeTools.length > 0
            ? yellow(`tool:${state.activeTools.map(tool => sanitizeTerminalText(tool.name)).join(',')}`)
            : undefined;
        const usage = state.usage ? dim(`${state.usage.inputTokens}→${state.usage.outputTokens} tok`) : undefined;
        const todo = state.todos.filter(item => item.status !== 'completed').length;
        const todos = todo > 0 ? dim(`${todo} todo`) : undefined;
        const goal = state.goal ? dim(`goal:${sanitizeTerminalText(state.goal.phase)}`) : undefined;
        const retry = state.retry
            ? yellow(`retry:${state.retry.retry}${state.retry.maxRetries === undefined ? '' : `/${state.retry.maxRetries}`}`)
            : undefined;
        const safeSession = sanitizeTerminalText(state.sessionId);
        const session = dim(safeSession.length > 18 ? `${safeSession.slice(0, 15)}…` : safeSession);
        const note = this.note === '' || this.note === 'ready'
            ? undefined
            : this.note.startsWith('error:') ? red(this.note) : dim(this.note);
        for (const segment of [tools, retry, usage, session, goal, todos, note]) {
            if (segment === undefined)
                continue;
            const candidate = `${output}${separator}${segment}`;
            if (visibleWidth(candidate) <= width)
                output = candidate;
        }
        return [truncateToWidth(output, width, '')];
    }
}
const settingsTheme = {
    label: (text, selected) => selected ? bold(text) : text,
    value: (text, selected) => selected ? deepseekBlue(text) : dim(text),
    description: dim,
    cursor: deepseekBlue('› '),
    hint: dim,
};
class CheckboxList {
    items;
    maxVisible;
    list;
    selectedIndex = 0;
    selected = new Set();
    onSubmit;
    onCancel;
    constructor(items, maxVisible) {
        this.items = items;
        this.maxVisible = maxVisible;
        this.list = this.createList();
    }
    invalidate() {
        this.list.invalidate();
    }
    render(width) {
        return this.list.render(width);
    }
    handleInput(data) {
        if (matchesKey(data, Key.escape)) {
            this.onCancel?.();
            return;
        }
        if (data === ' ') {
            const item = this.list.getSelectedItem();
            if (item === null)
                return;
            if (this.selected.has(item.value))
                this.selected.delete(item.value);
            else
                this.selected.add(item.value);
            this.rebuild();
            return;
        }
        if (matchesKey(data, Key.enter)) {
            this.onSubmit?.(this.items.filter(item => this.selected.has(item.value)));
            return;
        }
        this.list.handleInput(data);
        const current = this.list.getSelectedItem();
        if (current !== null)
            this.selectedIndex = this.items.findIndex(item => item.value === current.value);
    }
    rebuild() {
        this.list = this.createList();
        this.list.setSelectedIndex(this.selectedIndex);
    }
    createList() {
        const list = new SelectList(this.items.map(item => ({
            ...item,
            label: `${this.selected.has(item.value) ? '[x]' : '[ ]'} ${item.label}`,
        })), this.maxVisible, selectTheme);
        list.setSelectedIndex(this.selectedIndex);
        return list;
    }
}
class SearchableSelectList {
    items;
    maxVisible;
    emptyText;
    initialValue;
    input = new Input();
    list;
    filteredItems;
    isFocused = false;
    onSelect;
    onCancel;
    constructor(items, maxVisible, emptyText, initialValue) {
        this.items = items;
        this.maxVisible = maxVisible;
        this.emptyText = emptyText;
        this.initialValue = initialValue;
        this.filteredItems = items;
        this.list = this.createList();
    }
    get focused() {
        return this.isFocused;
    }
    set focused(value) {
        this.isFocused = value;
        this.input.focused = value;
    }
    invalidate() {
        this.input.invalidate();
        this.list.invalidate();
    }
    render(width) {
        const query = this.input.render(Math.max(1, width - 8))[0] ?? '';
        const rows = this.filteredItems.length === 0
            ? [dim(`  ${this.emptyText}`)]
            : this.list.render(width);
        return [`${dim('Search: ')}${query}`, '', ...rows];
    }
    handleInput(data) {
        if (matchesKey(data, Key.escape)) {
            this.onCancel?.();
            return;
        }
        if (matchesKey(data, Key.enter)) {
            const selected = this.list.getSelectedItem();
            if (selected !== null)
                this.onSelect?.(selected);
            return;
        }
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
            this.list.handleInput(data);
            return;
        }
        this.input.handleInput(data);
        this.filteredItems = fuzzyFilter(this.items, this.input.getValue(), item => item.searchText ?? `${item.label} ${item.value} ${item.description ?? ''}`);
        this.list = this.createList();
    }
    createList() {
        const list = new SelectList(this.filteredItems, this.maxVisible, selectTheme);
        if (this.input.getValue() === '' && this.initialValue !== undefined) {
            const initialIndex = this.filteredItems.findIndex(item => item.value === this.initialValue);
            if (initialIndex >= 0)
                list.setSelectedIndex(initialIndex);
        }
        list.onSelect = item => this.onSelect?.(item);
        list.onCancel = () => this.onCancel?.();
        return list;
    }
}
export class DeepSeekTui {
    tui;
    editor;
    transcript = new Container();
    interactionHost = new Container();
    scroll;
    status = new StatusLine();
    components = new Map();
    projectedEntries = new Map();
    projectionIds = new Set();
    transcriptDensity = 'normal';
    sessionId;
    projection;
    callbacks;
    pendingText;
    activeInteraction;
    autocomplete;
    ctrlCExit = new CtrlCExitGate();
    started = false;
    constructor(terminal = new ProcessTerminal()) {
        this.tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
        this.editor = new Editor(this.tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
        this.scroll = new ScrollView(this.transcript, {
            follow: 'end',
            primary: true,
            overscroll: 'chain',
            scrollbar: 'auto',
        });
        this.status.setFollowingOutputProvider(() => this.scroll.isFollowingEnd);
        this.tui.setLayoutRoot(new VStack([
            { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
            {
                component: new VStack([
                    { component: this.interactionHost, basis: 'auto', shrink: 1, minSize: 0, maxSize: 14 },
                    { component: this.editor, basis: 'auto', shrink: 1, minSize: 1 },
                    { component: this.status, basis: 1, shrink: 0 },
                ]),
                basis: 'auto',
                shrink: 1,
                minSize: 2,
            },
        ]));
    }
    setSlashCommands(commands, cwd) {
        this.autocomplete = createCommandAutocomplete(commands, cwd);
        if (this.pendingText === undefined)
            this.editor.setAutocompleteProvider(this.autocomplete);
    }
    getComposerText() {
        return this.editor.getExpandedText();
    }
    setComposerText(text) {
        if (this.pendingText !== undefined)
            throw new Error('cannot replace the composer during a text prompt');
        this.editor.setText(text);
        this.tui.requestRender();
    }
    copyToClipboard(text) {
        this.tui.terminal.write(`\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`);
        this.tui.flash('Copied to clipboard.', 1500);
    }
    setTranscriptDensity(density) {
        if (density === this.transcriptDensity)
            return;
        this.transcriptDensity = density;
        if (this.projection !== undefined) {
            for (const entry of this.projection.entries) {
                this.components.get(entry.id)?.setContent(formatEntry(entry, density));
            }
        }
        this.tui.requestRender();
    }
    start(callbacks) {
        if (this.started)
            return;
        this.started = true;
        this.callbacks = callbacks;
        this.editor.onChange = () => {
            if (this.pendingText !== undefined || callbacks.onDraftChange === undefined)
                return;
            void Promise.resolve(callbacks.onDraftChange(this.editor.getExpandedText())).catch(error => this.flashError(error));
        };
        this.editor.onSubmit = (text) => {
            if (text.trim() === '')
                return;
            this.ctrlCExit.reset();
            if (this.pendingText !== undefined) {
                const pending = this.pendingText;
                pending.resolve(text);
                this.status.setNote('ready');
                this.tui.requestRender();
                return;
            }
            this.editor.addToHistory(text);
            void Promise.resolve(callbacks.onPrompt(text)).catch(error => this.flashError(error));
        };
        this.tui.addInputListener((data) => {
            if (matchesKey(data, Key.ctrl('v')) && callbacks.onPasteImage !== undefined) {
                if (isKeyRelease(data))
                    return { consume: true };
                this.ctrlCExit.reset();
                if (this.activeInteraction !== undefined) {
                    this.tui.flash('Finish the current dialog before attaching an image.', 2500);
                }
                else {
                    void Promise.resolve(callbacks.onPasteImage()).catch(error => this.flashError(error));
                }
                return { consume: true };
            }
            const togglePlan = matchesKey(data, Key.shift(Key.tab));
            let reasoningDirection;
            if (matchesKey(data, Key.shift(Key.up)))
                reasoningDirection = 'increase';
            else if (matchesKey(data, Key.shift(Key.down)))
                reasoningDirection = 'decrease';
            if (togglePlan || reasoningDirection !== undefined) {
                if (isKeyRelease(data))
                    return { consume: true };
                this.ctrlCExit.reset();
                if (this.activeInteraction !== undefined) {
                    this.tui.flash('Finish the current dialog before changing mode or reasoning.', 2500);
                    return { consume: true };
                }
                this.editor.handleInput('\u001b');
                let shortcut;
                if (togglePlan) {
                    shortcut = callbacks.onTogglePlanMode;
                }
                else if (callbacks.onReasoningStep !== undefined && reasoningDirection !== undefined) {
                    const direction = reasoningDirection;
                    const onReasoningStep = callbacks.onReasoningStep;
                    shortcut = () => onReasoningStep(direction);
                }
                if (shortcut === undefined) {
                    this.tui.flash('This shortcut is unavailable in the current profile.', 2500);
                }
                else {
                    void Promise.resolve(shortcut()).catch(error => this.flashError(error));
                }
                return { consume: true };
            }
            if (isSettingsShortcut(data)) {
                this.ctrlCExit.reset();
                if (this.activeInteraction === undefined) {
                    void Promise.resolve(callbacks.onSettings()).catch(error => this.flashError(error));
                }
                else {
                    this.tui.flash('Finish the current dialog before opening Settings.', 2500);
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.ctrl('c'))) {
                if (this.ctrlCExit.press() === 'exit') {
                    void Promise.resolve(callbacks.onExit()).catch(error => this.flashError(error));
                    return { consume: true };
                }
                this.activeInteraction?.cancel();
                void Promise.resolve(callbacks.onInterrupt()).catch(error => this.flashError(error));
                this.setStatus('Ctrl+C again to exit');
                return { consume: true };
            }
            if (matchesKey(data, Key.escape) && this.pendingText !== undefined) {
                this.activeInteraction?.cancel();
                return { consume: true };
            }
            this.ctrlCExit.reset();
            if (matchesKey(data, Key.ctrl('d')) && this.activeInteraction !== undefined) {
                this.tui.flash('Close the current dialog before exiting.', 2000);
                return { consume: true };
            }
            if (matchesKey(data, Key.ctrl('d')) && this.editor.getText() === '') {
                void Promise.resolve(callbacks.onExit()).catch(error => this.flashError(error));
                return { consume: true };
            }
            return undefined;
        });
        this.tui.setFocus(this.editor);
        this.tui.start();
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        this.activeInteraction?.cancel();
        this.tui.stop();
    }
    renderProjection(state) {
        if (this.sessionId !== undefined && state.sessionId !== this.sessionId)
            this.resetTimeline(state.sessionId);
        this.sessionId ??= state.sessionId;
        this.projection = state;
        const nextIds = new Set(state.entries.map(entry => entry.id));
        for (const id of this.projectionIds) {
            if (nextIds.has(id))
                continue;
            const component = this.components.get(id);
            if (component !== undefined)
                this.transcript.removeChild(component);
            this.components.delete(id);
            this.projectedEntries.delete(id);
        }
        for (const entry of state.entries) {
            const existing = this.components.get(entry.id);
            if (existing !== undefined) {
                if (this.projectedEntries.get(entry.id) !== entry) {
                    existing.setContent(formatEntry(entry, this.transcriptDensity));
                    this.projectedEntries.set(entry.id, entry);
                }
                continue;
            }
            const component = new TranscriptRow();
            component.setContent(formatEntry(entry, this.transcriptDensity));
            this.components.set(entry.id, component);
            this.projectedEntries.set(entry.id, entry);
            this.transcript.addChild(component);
        }
        this.projectionIds = nextIds;
        this.status.update(state, state.lastError === undefined ? '' : `error: ${state.lastError}`);
        this.tui.requestRender();
    }
    appendNotice(text) {
        const safe = sanitizeTerminalText(text);
        const source = safe.includes('\n') ? `${yellow('Notice')}\n${safe}` : `${yellow('Notice')} · ${safe}`;
        this.transcript.addChild(this.markdown(source));
        this.tui.requestRender();
    }
    appendLaunchBanner(sessionId, cwd) {
        this.resetTimeline(sessionId);
        const source = renderLaunchBanner(sessionId, cwd);
        this.transcript.addChild(this.markdown(source));
        this.tui.requestRender();
    }
    setStatus(note) {
        this.status.setNote(note);
        if (this.projection !== undefined)
            this.status.update(this.projection, note);
        this.tui.requestRender();
    }
    flashStatus(note, durationMs = 2500) {
        this.tui.flash(sanitizeTerminalText(note), durationMs);
    }
    flashError(error) {
        const text = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
        this.tui.flash(`Error: ${text}`, 5000);
        this.appendNotice(`Error: ${text}`);
        this.setStatus(`error: ${text}`);
    }
    async choose(title, items, signal, options = {}) {
        if (signal?.aborted)
            return undefined;
        return await new Promise((resolve) => {
            const safeItems = items.map(item => ({
                ...item,
                label: `${item.value === options.initialValue ? '✓ ' : '  '}${sanitizeTerminalText(item.label)}`,
                ...(item.description === undefined
                    ? {}
                    : { description: sanitizeTerminalText(item.description) }),
            }));
            const list = new SelectList(safeItems, Math.min(8, Math.max(3, safeItems.length)), selectTheme);
            const selectedIndex = items.findIndex(item => item.value === options.initialValue);
            if (selectedIndex >= 0)
                list.setSelectedIndex(selectedIndex);
            let settled = false;
            const settle = (item) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                this.closeInteraction(interaction);
                if (item === undefined)
                    resolve(undefined);
                else
                    resolve(items.find(original => original.value === item.value));
            };
            const abort = () => settle(undefined);
            list.onSelect = settle;
            list.onCancel = () => settle(undefined);
            const interaction = {
                priority: options.priority ?? 'optional',
                cancel: () => settle(undefined),
            };
            this.openInteraction(title, list, '↑↓ move · Enter select · Esc close', interaction);
            signal?.addEventListener('abort', abort, { once: true });
        });
    }
    async chooseSearchable(title, items, signal, options = {}) {
        if (signal?.aborted)
            return undefined;
        return await new Promise((resolve) => {
            const safeItems = items.map(item => ({
                ...item,
                label: `${item.value === options.initialValue ? '✓ ' : '  '}${sanitizeTerminalText(item.label)}`,
                ...(item.description === undefined
                    ? {}
                    : { description: sanitizeTerminalText(item.description) }),
                ...(item.searchText === undefined
                    ? {}
                    : { searchText: sanitizeTerminalText(item.searchText) }),
            }));
            const list = new SearchableSelectList(safeItems, Math.min(7, Math.max(3, safeItems.length)), options.emptyText ?? 'No matching items', options.initialValue);
            let settled = false;
            const settle = (item) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                this.closeInteraction(interaction);
                if (item === undefined)
                    resolve(undefined);
                else
                    resolve(items.find(original => original.value === item.value));
            };
            const abort = () => settle(undefined);
            list.onSelect = settle;
            list.onCancel = () => settle(undefined);
            const interaction = {
                priority: options.priority ?? 'optional',
                cancel: () => settle(undefined),
            };
            this.openInteraction(title, list, 'Type to search · ↑↓ move · Enter select · Esc close', interaction);
            signal?.addEventListener('abort', abort, { once: true });
        });
    }
    async chooseMany(title, items, signal, options = {}) {
        if (signal?.aborted)
            return undefined;
        return await new Promise((resolve) => {
            const safeItems = items.map(item => ({
                ...item,
                label: sanitizeTerminalText(item.label),
                ...(item.description === undefined ? {} : { description: sanitizeTerminalText(item.description) }),
            }));
            const list = new CheckboxList(safeItems, Math.min(8, Math.max(3, safeItems.length)));
            let settled = false;
            const settle = (selected) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                this.closeInteraction(interaction);
                resolve(selected);
            };
            const abort = () => settle(undefined);
            list.onSubmit = selected => settle(selected.map(item => items.find(original => original.value === item.value)));
            list.onCancel = () => settle(undefined);
            const interaction = {
                priority: options.priority ?? 'optional',
                cancel: () => settle(undefined),
            };
            this.openInteraction(title, list, '↑↓ move · Space toggle · Enter submit · Esc close', interaction);
            signal?.addEventListener('abort', abort, { once: true });
        });
    }
    async chooseSetting(title, items, signal, initialId) {
        if (signal?.aborted)
            return undefined;
        return await new Promise((resolve) => {
            let settled = false;
            const settingsItems = items.map(item => ({
                id: item.id,
                label: sanitizeTerminalText(item.label),
                description: item.description === undefined ? undefined : sanitizeTerminalText(item.description),
                currentValue: sanitizeTerminalText(item.currentValue),
                values: [sanitizeTerminalText(item.currentValue)],
            }));
            const settle = (id) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                this.closeInteraction(interaction);
                resolve(id);
            };
            const list = new SettingsList(settingsItems, Math.min(8, Math.max(3, items.length)), settingsTheme, id => settle(id), () => settle(undefined), { enableSearch: false });
            const initialIndex = items.findIndex(item => item.id === initialId);
            for (let index = 0; index < initialIndex; index += 1)
                list.handleInput('\u001b[B');
            const abort = () => settle(undefined);
            const interaction = { priority: 'optional', cancel: () => settle(undefined) };
            this.openInteraction(title, list, 'Enter open · Esc close', interaction);
            signal?.addEventListener('abort', abort, { once: true });
        });
    }
    async promptText(title, signal, options = {}) {
        if (signal?.aborted)
            return undefined;
        const priority = options.priority ?? 'optional';
        this.prepareInteraction(priority);
        const draft = this.editor.getExpandedText();
        return await new Promise((resolve) => {
            let settled = false;
            const settle = (value) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                this.closeInteraction(interaction);
                this.editor.setText(draft);
                if (this.pendingText === pending)
                    this.pendingText = undefined;
                if (this.autocomplete !== undefined)
                    this.editor.setAutocompleteProvider(this.autocomplete);
                resolve(value);
            };
            const abort = () => {
                settle(undefined);
            };
            const pending = {
                signal,
                resolve: value => settle(value),
                reject: () => settle(undefined),
            };
            const interaction = {
                priority,
                cancel: () => settle(undefined),
            };
            this.pendingText = pending;
            this.editor.setText('');
            this.editor.setAutocompleteProvider(disabledAutocomplete);
            this.openInteraction(title, this.editor, 'Type your answer · Enter submit · Esc close', interaction, false);
            signal?.addEventListener('abort', abort, { once: true });
            this.tui.setFocus(this.editor);
        });
    }
    openInteraction(title, component, hint, interaction, mountComponent = true) {
        this.prepareInteraction(interaction.priority);
        this.interactionHost.clear();
        this.interactionHost.addChild(new Markdown(sanitizeTerminalText(title), 1, 0, markdownTheme));
        if (mountComponent)
            this.interactionHost.addChild(component);
        this.interactionHost.addChild(new Text(dim(hint), 1, 0));
        this.activeInteraction = interaction;
        this.tui.setFocus(component);
        this.tui.requestRender();
    }
    prepareInteraction(priority) {
        if (this.activeInteraction === undefined)
            return;
        if (priority === 'required' && this.activeInteraction.priority === 'optional') {
            this.activeInteraction.cancel();
            return;
        }
        throw new Error('another terminal interaction is already active');
    }
    closeInteraction(interaction) {
        if (this.activeInteraction !== interaction)
            return;
        this.activeInteraction = undefined;
        this.interactionHost.clear();
        this.tui.setFocus(this.editor);
        this.tui.requestRender();
    }
    resetTimeline(sessionId) {
        this.sessionId = sessionId;
        this.transcript.clear();
        this.components.clear();
        this.projectedEntries.clear();
        this.projectionIds.clear();
        this.projection = undefined;
        this.scroll.scrollToEnd();
    }
    markdown(text) {
        return new Markdown(text, 1, 1, markdownTheme, undefined, { renderLatex: true });
    }
}
