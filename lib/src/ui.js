import { CombinedAutocompleteProvider, Container, Editor, Key, Markdown, ProcessTerminal, ScrollView, SelectList, SettingsList, Text, TuiAltScreen, VStack, matchesKey, truncateToWidth, visibleWidth, } from '@earendil-works/pi-tui';
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
const BANNER_CONTROLS = '/ commands · @ files · F2 settings · Ctrl+C stop / ×2 exit · Ctrl+D exit · /help';
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
function renderFileDiff(diff) {
    const path = sanitizeTerminalText(diff.path);
    const oldLines = diff.oldText === null ? [] : sanitizeTerminalText(diff.oldText).split('\n');
    const newLines = sanitizeTerminalText(diff.newText).split('\n');
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
function renderDiffs(diffs) {
    if (diffs === undefined || diffs.length === 0)
        return undefined;
    return `\`\`\`diff\n${diffs.map(renderFileDiff).join('\n\n')}\n\`\`\``;
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
export function formatEntry(entry) {
    const text = sanitizeTerminalText(entry.text);
    if (entry.kind === 'reasoning') {
        return `${dim('Thinking')}\n${dim(text || '…')}`;
    }
    if (entry.kind === 'tool') {
        const mark = entry.error ? red('✗') : entry.streaming ? yellow('◆') : green('✓');
        const detail = entry.detail === undefined ? undefined : sanitizeTerminalText(entry.detail).trim();
        const diff = renderDiffs(entry.diffs);
        return `${mark} ${bold(text)}${detail ? `\n\n\`\`\`text\n${detail}\n\`\`\`` : ''}${diff ? `\n\n${diff}` : ''}`;
    }
    if (entry.role === 'user')
        return `${deepseekBlue('You')}\n${text}`;
    if (entry.role === 'system')
        return `${yellow('System')}\n${text}`;
    return text || '…';
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
        const fixedPrimary = [activity, reasoning, mode, permission, ...(scroll === undefined ? [] : [scroll])];
        const modelBudget = Math.max(3, width - fixedPrimary.reduce((total, segment) => total + visibleWidth(segment), 0)
            - visibleWidth(separator) * fixedPrimary.length);
        const rawModel = state.provider && state.model
            ? width >= 100 && !compactPrimary
                ? `${sanitizeTerminalText(state.provider)}/${sanitizeTerminalText(state.model)}`
                : sanitizeTerminalText(state.model)
            : 'model unavailable';
        const modelText = truncateToWidth(rawModel, modelBudget, '…');
        const model = state.provider && state.model ? deepseekBlue(modelText) : dim(modelText);
        const primary = [model, reasoning, mode, permission, activity, ...(scroll === undefined ? [] : [scroll])];
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
        for (const segment of [tools, retry, session, usage, goal, todos, note]) {
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
export class DeepSeekTui {
    tui;
    editor;
    transcript = new Container();
    interactionHost = new Container();
    scroll;
    status = new StatusLine();
    components = new Map();
    projectionIds = new Set();
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
    start(callbacks) {
        if (this.started)
            return;
        this.started = true;
        this.callbacks = callbacks;
        this.editor.onSubmit = (text) => {
            if (text.trim() === '')
                return;
            this.ctrlCExit.reset();
            if (this.pendingText !== undefined) {
                const pending = this.pendingText;
                this.pendingText = undefined;
                pending.resolve(text);
                this.status.setNote('ready');
                this.tui.requestRender();
                return;
            }
            this.editor.addToHistory(text);
            void Promise.resolve(callbacks.onPrompt(text)).catch(error => this.flashError(error));
        };
        this.tui.addInputListener((data) => {
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
        }
        for (const entry of state.entries) {
            const existing = this.components.get(entry.id);
            if (existing !== undefined) {
                existing.setText(formatEntry(entry));
                continue;
            }
            const component = this.markdown(formatEntry(entry));
            this.components.set(entry.id, component);
            this.transcript.addChild(component);
        }
        this.projectionIds = nextIds;
        this.status.update(state, state.lastError === undefined ? '' : `error: ${state.lastError}`);
        this.tui.requestRender();
    }
    appendNotice(text) {
        const source = `${yellow('System')}\n${sanitizeTerminalText(text)}`;
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
        const draft = this.editor.getText();
        this.editor.setText('');
        this.editor.setAutocompleteProvider(disabledAutocomplete);
        return await new Promise((resolve) => {
            let settled = false;
            const settle = (value) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                if (this.pendingText === pending)
                    this.pendingText = undefined;
                this.closeInteraction(interaction);
                this.editor.setText(draft);
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
        this.projectionIds.clear();
        this.projection = undefined;
        this.scroll.scrollToEnd();
    }
    markdown(text) {
        return new Markdown(text, 1, 1, markdownTheme, undefined, { renderLatex: true });
    }
}
