import { CombinedAutocompleteProvider, Container, Editor, Key, Markdown, ProcessTerminal, ScrollView, SelectList, TuiAltScreen, VStack, matchesKey, truncateToWidth, } from '@earendil-works/pi-tui';
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
const FOOTER_CONTROLS = 'F2 settings · Ctrl+C stop / ×2 exit · Ctrl+D exit · /help';
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
    return `${deepseekBlue(OFFICIAL_DEEPSEEK_RASTER)}\n\n${bold(deepseekBlue('DeepSeek Harness TUI'))}\n${dim(`session  ${sanitizeTerminalText(sessionId)}`)}\n${dim(`cwd      ${sanitizeTerminalText(cwd)}`)}\n${dim(`/ for commands · @ for files · ${FOOTER_CONTROLS}`)}`;
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
export class ControlBar {
    invalidate() { }
    render(width) {
        return [truncateToWidth(dim('[F2 Settings]  [Ctrl+C Stop · ×2 Exit]  [Ctrl+D Exit]  [/ Commands]'), width, '')];
    }
}
export class StatusLine {
    state;
    note = 'ready';
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
        const activity = state.compacting ? yellow('compacting') : state.running ? yellow('running') : green('idle');
        const tools = state.activeTools.length > 0
            ? ` · ${state.activeTools.map(tool => sanitizeTerminalText(tool.name)).join(',')}`
            : '';
        const model = state.provider && state.model
            ? ` · ${sanitizeTerminalText(state.provider)}/${sanitizeTerminalText(state.model)}${state.reasoningEffort ? ` · reasoning:${sanitizeTerminalText(state.reasoningEffort)}` : ''}`
            : '';
        const usage = state.usage ? ` · ${state.usage.inputTokens}→${state.usage.outputTokens} tok` : '';
        const todo = state.todos.filter(item => item.status !== 'completed').length;
        const todos = todo > 0 ? ` · ${todo} todo` : '';
        const mode = state.planMode ? ' · plan' : '';
        const permission = state.permissionPreset ? ` · ${sanitizeTerminalText(state.permissionPreset)}` : '';
        const goal = state.goal ? ` · goal:${sanitizeTerminalText(state.goal.phase)}` : '';
        const retry = state.retry
            ? ` · retry:${state.retry.retry}${state.retry.maxRetries === undefined ? '' : `/${state.retry.maxRetries}`}`
            : '';
        const safeSession = sanitizeTerminalText(state.sessionId);
        const session = safeSession.length > 20 ? `${safeSession.slice(0, 17)}…` : safeSession;
        return [truncateToWidth(`${activity}${tools} · ${session}${model}${mode}${permission}${goal}${retry}${usage}${todos} · ${dim(this.note)}`, width, '')];
    }
}
export class DeepSeekTui {
    tui;
    editor;
    transcript = new Container();
    scroll;
    status = new StatusLine();
    components = new Map();
    entryIds = [];
    notices = [];
    projection;
    callbacks;
    pendingText;
    overlayActive = false;
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
        this.tui.setLayoutRoot(new VStack([
            { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
            {
                component: new VStack([
                    { component: this.editor, basis: 'auto', shrink: 1, minSize: 1 },
                    { component: this.status, basis: 1, shrink: 0 },
                    { component: new ControlBar(), basis: 1, shrink: 0 },
                ]),
                basis: 'auto',
                shrink: 1,
                minSize: 3,
            },
        ]));
    }
    setSlashCommands(commands, cwd) {
        this.editor.setAutocompleteProvider(createCommandAutocomplete(commands, cwd));
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
            this.editor.addToHistory(text);
            if (this.pendingText !== undefined) {
                const pending = this.pendingText;
                this.pendingText = undefined;
                pending.resolve(text);
                this.status.setNote('ready');
                this.tui.requestRender();
                return;
            }
            void Promise.resolve(callbacks.onPrompt(text)).catch(error => this.flashError(error));
        };
        this.tui.addInputListener((data) => {
            if (isSettingsShortcut(data)) {
                this.ctrlCExit.reset();
                if (this.pendingText === undefined && !this.overlayActive) {
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
                if (this.pendingText !== undefined) {
                    const pending = this.pendingText;
                    this.pendingText = undefined;
                    pending.reject(new Error('cancelled by user'));
                }
                else {
                    void Promise.resolve(callbacks.onInterrupt()).catch(error => this.flashError(error));
                }
                this.setStatus('Ctrl+C again to exit');
                return { consume: true };
            }
            this.ctrlCExit.reset();
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
        this.pendingText?.reject(new Error('terminal closed'));
        this.pendingText = undefined;
        this.overlayActive = false;
        this.tui.stop();
    }
    renderProjection(state) {
        this.projection = state;
        const nextIds = state.entries.map(entry => entry.id);
        const sameOrder = nextIds.length === this.entryIds.length
            && nextIds.every((id, index) => id === this.entryIds[index]);
        if (!sameOrder) {
            this.transcript.clear();
            this.components.clear();
            for (const entry of state.entries) {
                const component = this.markdown(formatEntry(entry));
                this.components.set(entry.id, component);
                this.transcript.addChild(component);
            }
            for (const notice of this.notices)
                this.transcript.addChild(this.markdown(notice));
            this.entryIds = nextIds;
        }
        else {
            for (const entry of state.entries)
                this.components.get(entry.id)?.setText(formatEntry(entry));
        }
        this.status.update(state, state.lastError ?? 'ready');
        this.tui.requestRender();
    }
    appendNotice(text) {
        const source = `${yellow('System')}\n${sanitizeTerminalText(text)}`;
        this.notices.push(source);
        this.transcript.addChild(this.markdown(source));
        this.tui.requestRender();
    }
    appendLaunchBanner(sessionId, cwd) {
        const source = renderLaunchBanner(sessionId, cwd);
        this.notices.push(source);
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
        this.setStatus(`error: ${text}`);
    }
    async choose(title, items, signal) {
        if (signal?.aborted)
            return undefined;
        if (this.overlayActive)
            throw new Error('another terminal menu is already active');
        this.appendNotice(title);
        return await new Promise((resolve) => {
            const safeItems = items.map(item => ({
                ...item,
                label: sanitizeTerminalText(item.label),
                ...(item.description === undefined
                    ? {}
                    : { description: sanitizeTerminalText(item.description) }),
            }));
            const list = new SelectList(safeItems, Math.min(10, Math.max(3, safeItems.length)), selectTheme);
            let settled = false;
            let handle;
            const settle = (item) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                handle.hide();
                this.overlayActive = false;
                this.tui.setFocus(this.editor);
                resolve(item);
            };
            const abort = () => settle(undefined);
            list.onSelect = settle;
            list.onCancel = () => settle(undefined);
            this.overlayActive = true;
            try {
                handle = this.tui.showOverlay(list, {
                    width: '70%',
                    maxHeight: '70%',
                    anchor: 'center',
                    margin: 1,
                });
            }
            catch (error) {
                this.overlayActive = false;
                throw error;
            }
            signal?.addEventListener('abort', abort, { once: true });
        });
    }
    async promptText(title, signal) {
        if (signal?.aborted)
            return undefined;
        if (this.pendingText !== undefined)
            throw new Error('another terminal question is already active');
        this.appendNotice(title);
        this.setStatus('answer the question above · Ctrl+C cancel');
        return await new Promise((resolve) => {
            const abort = () => {
                if (this.pendingText === pending)
                    this.pendingText = undefined;
                resolve(undefined);
            };
            const pending = {
                signal,
                resolve: (value) => {
                    signal?.removeEventListener('abort', abort);
                    resolve(value);
                },
                reject: () => {
                    signal?.removeEventListener('abort', abort);
                    resolve(undefined);
                },
            };
            this.pendingText = pending;
            signal?.addEventListener('abort', abort, { once: true });
            this.tui.setFocus(this.editor);
        });
    }
    markdown(text) {
        return new Markdown(text, 1, 1, markdownTheme, undefined, { renderLatex: true });
    }
}
