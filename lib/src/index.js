import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { installModelSelection, } from '@deepseek-ai/dsh-agent';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { PERMISSION_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-permission-presets';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import { SessionId } from '@deepseek-ai/dsh-session';
import { buildSlashCommands, formatCommandHelp, parseInput } from './commands.js';
import { projectWorkflowActivity } from './activity.js';
import { detectImageMediaType, readClipboardImage } from './clipboard-image.js';
import { deliverableBasename, deriveDeliverables } from './deliverables.js';
import { createSessionDraftStore } from './drafts.js';
import { defaultSessionExportFilename, SESSION_EXPORT_DISCLOSURE, writeSessionExport, } from './export.js';
import { BUSY_PICKER_ITEMS, GOAL_PICKER_ITEMS, OTHER_ANSWER_VALUE, PLAN_PICKER_ITEMS, SETTINGS_PICKER_ITEMS, filterPickerItems, modelPickerItems, parseModelRef, parseSettingsPatch, questionLabelsFromValues, questionPickerItems, reasoningInitialValue, reasoningPickerItems, sessionPickerItems, settingsNamespacePickerItems, stepReasoningEffort, } from './interaction.js';
import { createProjection, foldSessionEvent, projectSession } from './projection.js';
import { openExternalPath } from './platform.js';
import { queueItemLabel, queueItems } from './queue.js';
import { projectVisibility } from './visibility.js';
import { DEFAULT_TRANSCRIPT_DENSITY, TRANSCRIPT_DENSITY_PICKER_ITEMS, TRANSCRIPT_SETTINGS_NAMESPACE, TRANSCRIPT_SETTINGS_SCHEMA, } from './transcript-settings.js';
import { DeepSeekTui, sanitizeTerminalText } from './ui.js';
export const name = 'dsh-tui-runner';
export const inject = [
    'dshTuiStartup',
    'attachments',
    'agentDefaultModel',
    'agents',
    'sessions',
    'sessionPersistence',
    'sessionTitle',
    'commands',
    'planMode',
    'permissionPresets',
    'sessionProjections',
    'tokenMeter',
    'workspaceRegistry',
    'pluginInventory',
    'jobs',
    'subagents',
    'settings',
    'tools',
    'llm',
    'approval',
    'userQuestions',
];
function message(text) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}
function modelFromEvents(events, fallback) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type !== 'request/header')
            continue;
        const config = event.data.header.config;
        return {
            provider: config.provider,
            model: config.model,
            ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
        };
    }
    return fallback;
}
function questionTitle(question) {
    return [
        question.header ? `## ${question.header}` : undefined,
        question.question,
        question.detail,
    ].filter((part) => Boolean(part)).join('\n\n');
}
async function mapWithConcurrency(items, limit, visit) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await visit(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
function updatedAt(events, createdAt) {
    return events.at(-1)?.time ?? createdAt;
}
function formatDuration(milliseconds) {
    if (milliseconds === undefined)
        return 'n/a';
    if (milliseconds < 1_000)
        return `${String(Math.round(milliseconds))}ms`;
    if (milliseconds < 60_000)
        return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)}s`;
    return `${(milliseconds / 60_000).toFixed(1)}m`;
}
function formatTokenCount(tokens) {
    return new Intl.NumberFormat('en-US').format(tokens);
}
export class DshTuiRunner {
    ctx;
    startup;
    ui;
    transcriptSettings;
    draftStore;
    handle;
    selection;
    subscriptions = [];
    interactionDisposers = [];
    busyEnter = 'queue';
    projection;
    projectionCursor = 0;
    closing = false;
    started = false;
    localTranscriptDensity = DEFAULT_TRANSCRIPT_DENSITY;
    selectedContextWindow;
    shortcutQueue = Promise.resolve();
    actionQueue = Promise.resolve();
    sessionGeneration = 0;
    sessionLoadAbort;
    activityLoadAbort;
    draftSaveTimer;
    pendingImages = [];
    sessionNavigatorCache = new Map();
    constructor(ctx, startup, ui = new DeepSeekTui(), transcriptSettings, draftStore = createSessionDraftStore(join(resolveDshHome(), 'tui', 'drafts', 'v1'))) {
        this.ctx = ctx;
        this.startup = startup;
        this.ui = ui;
        this.transcriptSettings = transcriptSettings;
        this.draftStore = draftStore;
        if (this.transcriptSettings !== undefined) {
            this.ui.setTranscriptDensity(this.transcriptSettings.get().transcriptDensity);
            this.interactionDisposers.push(this.transcriptSettings.watch(next => {
                this.ui.setTranscriptDensity(next.transcriptDensity);
            }));
        }
    }
    get transcriptDensity() {
        return this.transcriptSettings?.get().transcriptDensity ?? this.localTranscriptDensity;
    }
    get agent() {
        if (this.handle === undefined)
            throw new Error('no active DeepSeek session');
        return this.handle.agent;
    }
    async start() {
        await this.ctx.get('loader')?.await();
        if (this.closing)
            return;
        this.installInteractions();
        await this.open(this.startup.resume);
        await this.restoreCurrentDraft();
        this.ui.appendLaunchBanner(String(this.agent.id), this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd()));
        this.ui.start({
            onPrompt: text => this.submit(text),
            onDraftChange: text => this.scheduleDraftSave(text),
            onPasteImage: () => this.enqueueAction(() => this.pasteClipboardImage()),
            onSettings: () => this.enqueueAction(() => this.chooseSettings()),
            onTogglePlanMode: () => this.enqueueAction(() => this.enqueueShortcut(() => this.togglePlanMode())),
            onReasoningStep: direction => this.enqueueAction(() => this.enqueueShortcut(() => this.stepReasoning(direction))),
            onInterrupt: () => this.interrupt(),
            onExit: () => this.enqueueAction(() => this.shutdown(true)),
        });
        this.started = true;
        this.refresh();
        if (this.startup.prompt !== undefined)
            await this.submit(this.startup.prompt);
    }
    installInteractions() {
        const userQuestions = this.ctx.get('userQuestions');
        const questionDispose = userQuestions?.registerProvider({
            ask: request => this.askQuestions(request),
        });
        if (questionDispose !== undefined)
            this.interactionDisposers.push(questionDispose);
        this.interactionDisposers.push(this.ctx.on('approval/request', (request, next) => {
            if (this.handle === undefined || request.agent !== this.handle.agent)
                return next();
            return this.askApproval(request);
        }));
    }
    async askApproval(request) {
        const choice = await this.ui.choose(`Permission request\n\nTool: ${request.toolName}${request.reason ? `\nReason: ${request.reason}` : ''}`, [
            { value: 'allow', label: 'Allow once', description: 'Run this action once' },
            { value: 'reject', label: 'Reject', description: 'Deny this action' },
        ], request.signal, { initialValue: 'reject', priority: 'required' });
        if (request.signal?.aborted)
            return 'cancelled';
        return choice?.value === 'allow' ? 'allowed-once' : choice?.value === 'reject' ? 'rejected' : 'cancelled';
    }
    async askQuestions(request) {
        if (request.agent !== undefined && request.agent !== this.handle?.agent) {
            throw new Error('question belongs to a different agent');
        }
        const answers = [];
        for (const question of request.questions) {
            if (request.signal?.aborted)
                throw new Error('question cancelled');
            const title = questionTitle(question);
            const options = question.options ?? [];
            const optionItems = questionPickerItems(options);
            if (question.multiSelect) {
                if (options.length === 0) {
                    const custom = await this.ui.promptText(`${title}\n\nType your answer:`, request.signal, { priority: 'required' });
                    if (custom === undefined)
                        throw new Error('question cancelled');
                    answers.push({ id: question.id, selected: [], custom });
                    continue;
                }
                const selected = await this.ui.chooseMany(title, [
                    ...optionItems,
                    { value: OTHER_ANSWER_VALUE, label: 'Other…', description: 'Add a custom answer' },
                ], request.signal, { priority: 'required' });
                if (selected === undefined)
                    throw new Error('question cancelled');
                const customRequested = selected.some(item => item.value === OTHER_ANSWER_VALUE);
                const labels = questionLabelsFromValues(selected.map(item => item.value), options);
                if (!customRequested) {
                    answers.push({ id: question.id, selected: labels });
                    continue;
                }
                const custom = await this.ui.promptText(`${title}\n\nType the additional answer:`, request.signal, { priority: 'required' });
                if (custom === undefined)
                    throw new Error('question cancelled');
                answers.push({ id: question.id, selected: labels, custom });
                continue;
            }
            if (options.length > 0) {
                const choice = await this.ui.choose(title, [
                    ...optionItems,
                    { value: OTHER_ANSWER_VALUE, label: 'Other…', description: 'Type a custom answer' },
                ], request.signal, { priority: 'required' });
                if (choice === undefined)
                    throw new Error('question cancelled');
                if (choice.value !== OTHER_ANSWER_VALUE) {
                    const labels = questionLabelsFromValues([choice.value], options);
                    if (labels[0] === undefined)
                        throw new Error('question choice is no longer available');
                    answers.push({ id: question.id, selected: [labels[0]] });
                    continue;
                }
            }
            const custom = await this.ui.promptText(`${title}\n\nType your answer:`, request.signal, { priority: 'required' });
            if (custom === undefined)
                throw new Error('question cancelled');
            answers.push({ id: question.id, selected: [], custom });
        }
        return { answers };
    }
    async prepareSession(resumeId, fallbackSelection) {
        const defaultSelection = fallbackSelection ?? this.ctx.agentDefaultModel.currentSelection();
        let selected = defaultSelection;
        if (resumeId !== undefined) {
            const inspected = await this.ctx.sessionPersistence.inspect(SessionId(resumeId));
            selected = modelFromEvents(inspected.events, defaultSelection);
        }
        const selection = { current: selected, assembled: undefined };
        const contextWindow = await this.resolveContextWindow(selected);
        const setup = (agentCtx) => { installModelSelection(agentCtx, selection); };
        const handle = resumeId === undefined
            ? await this.ctx.agents.create({
                sessionId: SessionId(`session-${randomUUID()}`),
                meta: { cwd: resolve(this.startup.cwd ?? process.cwd()) },
                agentOptions: { provider: selected.provider, model: selected.model },
                setup,
            })
            : await this.ctx.agents.resume({
                resumeSessionId: SessionId(resumeId),
                agentOptions: { provider: selected.provider, model: selected.model },
                setup,
            });
        return { handle, selection, contextWindow };
    }
    activateSession(prepared) {
        this.handle = prepared.handle;
        this.selection = prepared.selection;
        this.selectedContextWindow = prepared.contextWindow;
        this.bindAgent(prepared.handle.agent);
    }
    async open(resumeId, fallbackSelection) {
        this.activateSession(await this.prepareSession(resumeId, fallbackSelection));
        await this.attachCurrentWorkspace();
    }
    async attachCurrentWorkspace() {
        const cwd = this.agent.session.header.cwd;
        if (cwd === undefined)
            return;
        try {
            const workspace = await this.ctx.workspaceRegistry.create(cwd);
            await workspace.attachSession(this.agent.session.id);
        }
        catch {
            // A missing historical directory must not prevent its session from opening.
        }
    }
    bindAgent(agent) {
        while (this.subscriptions.length > 0)
            this.subscriptions.pop()?.();
        this.projection = createProjection(String(agent.id));
        this.projectionCursor = 0;
        this.subscriptions.push(this.ctx.on('session/event', (session) => {
            if (session === agent.session)
                this.refresh();
        }), this.ctx.on('agent/status', ({ agent: subject }) => {
            if (subject === agent)
                this.refresh();
        }), this.ctx.on('commands/change', () => {
            if (this.handle?.agent === agent)
                this.refreshSlashCommands(agent);
        }));
        this.refreshSlashCommands(agent);
    }
    refreshSlashCommands(agent) {
        const cwd = agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd());
        const commands = buildSlashCommands(this.ctx.commands.list(agent));
        for (const command of commands) {
            switch (command.name) {
                case 'model':
                    command.getArgumentCompletions = async (prefix) => filterPickerItems(modelPickerItems(await this.loadModels()), prefix);
                    break;
                case 'resume':
                    command.getArgumentCompletions = async (prefix) => filterPickerItems(await this.loadSessionPickerItems(), prefix);
                    break;
                case 'session':
                    command.getArgumentCompletions = async (prefix) => filterPickerItems(await this.loadSessionPickerItems(), prefix);
                    break;
                case 'sessions':
                    command.getArgumentCompletions = prefix => filterPickerItems([
                        { value: 'archived', label: 'archived', description: 'Browse one-way archived sessions' },
                    ], prefix);
                    break;
                case 'permission':
                    command.getArgumentCompletions = prefix => filterPickerItems(this.permissionPickerItems(), prefix);
                    break;
                case 'reasoning':
                    command.getArgumentCompletions = async (prefix) => filterPickerItems(await this.loadReasoningPickerItems(), prefix);
                    break;
                case 'busy':
                    command.getArgumentCompletions = prefix => filterPickerItems(BUSY_PICKER_ITEMS, prefix);
                    break;
                case 'settings':
                    command.getArgumentCompletions = prefix => filterPickerItems([
                        ...SETTINGS_PICKER_ITEMS,
                        ...this.loadSettingsNamespacePickerItems(),
                    ], prefix);
                    break;
                case 'goal':
                    command.getArgumentCompletions = prefix => filterPickerItems([
                        { value: 'clear', label: 'clear', description: 'Remove the current goal' },
                        { value: 'edit ', label: 'edit', description: 'Edit the goal objective' },
                        { value: 'pause', label: 'pause', description: 'Pause automatic continuation' },
                        { value: 'resume', label: 'resume', description: 'Resume automatic continuation' },
                    ], prefix);
                    break;
                case 'plan':
                    command.getArgumentCompletions = prefix => filterPickerItems([
                        { value: 'off', label: 'off', description: 'Leave plan mode' },
                    ], prefix);
                    break;
            }
        }
        this.ui.setSlashCommands(commands, cwd);
    }
    refresh() {
        if (this.handle === undefined)
            return;
        const presenter = {
            presentCall: (name, argumentsValue) => this.ctx.tools.get(name, this.agent)?.presentCall?.(argumentsValue),
            presentResult: (name, argumentsValue, result) => this.ctx.tools.get(name, this.agent)?.presentResult?.(argumentsValue, result),
        };
        const events = this.agent.session.events;
        if (this.projection === undefined || this.projectionCursor > events.length) {
            this.projection = createProjection(String(this.agent.id));
            this.projectionCursor = 0;
        }
        while (this.projectionCursor < events.length) {
            const event = events[this.projectionCursor];
            if (event !== undefined)
                this.projection = foldSessionEvent(this.projection, event, presenter);
            this.projectionCursor += 1;
        }
        const state = { ...this.projection, running: this.agent.status === 'running' };
        if (this.selection?.current !== undefined) {
            state.provider = this.selection.current.provider;
            state.model = this.selection.current.model;
            state.reasoningEffort = this.selection.current.reasoningEffort;
            const requestContext = state.requestContext;
            const routeMatches = requestContext?.provider === this.selection.current.provider
                && requestContext.model === this.selection.current.model;
            const capacityTokens = this.selectedContextWindow ?? (routeMatches ? requestContext?.contextWindow : undefined);
            if (capacityTokens !== undefined) {
                const pressure = this.ctx.sessionProjections.snapshot(this.agent.session).values.contextPressure;
                const usedTokens = routeMatches && state.contextUsageReady
                    ? pressure?.projectedTokens ?? pressure?.pressureTokens
                    : undefined;
                state.contextWindow = {
                    capacityTokens,
                    ...(usedTokens === undefined ? {} : { usedTokens }),
                };
            }
        }
        this.ui.renderProjection(state);
    }
    async resolveContextWindow(selection) {
        try {
            const info = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model);
            const contextWindow = info.context?.contextWindow;
            return typeof contextWindow === 'number' && Number.isInteger(contextWindow) && contextWindow > 0
                ? contextWindow
                : undefined;
        }
        catch {
            return undefined;
        }
    }
    enqueueShortcut(action) {
        const generation = this.sessionGeneration;
        const runIfCurrent = async () => {
            if (generation === this.sessionGeneration)
                await action();
        };
        const queued = this.shortcutQueue.then(runIfCurrent, runIfCurrent);
        this.shortcutQueue = queued.catch(() => { });
        return queued;
    }
    enqueueAction(action) {
        const queued = this.actionQueue.then(action, action);
        this.actionQueue = queued.catch(() => { });
        return queued;
    }
    cancelDraftSave() {
        if (this.draftSaveTimer === undefined)
            return;
        clearTimeout(this.draftSaveTimer);
        this.draftSaveTimer = undefined;
    }
    scheduleDraftSave(text) {
        if (this.handle === undefined || this.closing)
            return;
        const sessionId = String(this.agent.id);
        this.cancelDraftSave();
        this.draftSaveTimer = setTimeout(() => {
            this.draftSaveTimer = undefined;
            void this.draftStore.save(sessionId, text).catch(error => this.ui.flashError(error));
        }, 150);
    }
    composerText() {
        const getComposerText = this.ui.getComposerText;
        return typeof getComposerText === 'function' ? getComposerText.call(this.ui) : undefined;
    }
    replaceComposerText(text) {
        const setComposerText = this.ui.setComposerText;
        if (typeof setComposerText === 'function')
            setComposerText.call(this.ui, text);
    }
    async persistCurrentDraft(text = this.composerText()) {
        if (this.handle === undefined)
            return;
        if (text === undefined)
            return;
        this.cancelDraftSave();
        await this.draftStore.save(String(this.agent.id), text);
    }
    async restoreCurrentDraft() {
        if (this.handle === undefined)
            return;
        if (this.composerText() === undefined)
            return;
        this.cancelDraftSave();
        this.replaceComposerText(await this.draftStore.load(String(this.agent.id)) ?? '');
    }
    async addPendingImage(input) {
        const limits = this.ctx.attachments.imageLimits;
        if (this.pendingImages.length >= limits.maxImagesPerMessage) {
            throw new Error(`a prompt can contain at most ${limits.maxImagesPerMessage} images`);
        }
        const total = this.pendingImages.reduce((sum, image) => sum + image.data.byteLength, 0) + input.data.byteLength;
        if (total > limits.maxMessageImageBytes) {
            throw new Error(`pending images exceed the ${limits.maxMessageImageBytes}-byte message limit`);
        }
        await this.ctx.attachments.validateImage(input);
        this.pendingImages.push(input);
        this.ui.appendNotice(`[image] ${input.name ?? 'attachment'} · ${input.mediaType} · ${input.data.byteLength} bytes`);
        this.ui.setStatus(`${this.pendingImages.length} image${this.pendingImages.length === 1 ? '' : 's'} attached to the next prompt`);
    }
    async attachImagePath(path) {
        const cwd = this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd());
        const absolute = resolve(cwd, path);
        const metadata = await stat(absolute);
        if (!metadata.isFile())
            throw new Error(`attachment is not a file: ${path}`);
        if (metadata.size > this.ctx.attachments.imageLimits.maxImageBytes) {
            throw new Error(`image exceeds the ${this.ctx.attachments.imageLimits.maxImageBytes}-byte limit`);
        }
        const data = new Uint8Array(await readFile(absolute));
        const mediaType = detectImageMediaType(data);
        if (mediaType === undefined)
            throw new Error('unsupported image; use PNG, JPEG, WebP, or GIF');
        await this.addPendingImage({ data, mediaType, name: basename(absolute) });
    }
    async pasteClipboardImage() {
        this.ui.setStatus('reading image from clipboard…');
        const image = await readClipboardImage();
        if (image === undefined) {
            this.ui.appendNotice('No supported clipboard image was available. Use /attach <path> as a fallback.');
            this.ui.setStatus('ready');
            return;
        }
        await this.addPendingImage(image);
    }
    async chooseAttachments(path = '') {
        if (path.trim() !== '') {
            await this.attachImagePath(path.trim());
            return;
        }
        if (this.pendingImages.length === 0) {
            const entered = await this.ui.promptText('Image path (PNG, JPEG, WebP, or GIF):');
            if (entered?.trim())
                await this.attachImagePath(entered.trim());
            return;
        }
        const items = [
            ...this.pendingImages.map((image, index) => ({
                value: `remove:${index}`,
                label: `[image] ${image.name ?? `attachment ${index + 1}`}`,
                description: `${image.mediaType} · ${image.data.byteLength} bytes · select to remove`,
            })),
            { value: 'add', label: 'Attach another image…', description: 'Read an image file from the workspace' },
            { value: 'clear', label: 'Remove all images', description: 'Clear pending image attachments' },
        ];
        const choice = await this.ui.choose('Pending images', items);
        if (choice === undefined)
            return;
        if (choice.value === 'add') {
            const entered = await this.ui.promptText('Image path (PNG, JPEG, WebP, or GIF):');
            if (entered?.trim())
                await this.attachImagePath(entered.trim());
            return;
        }
        if (choice.value === 'clear')
            this.pendingImages = [];
        else {
            const index = Number(choice.value.slice('remove:'.length));
            if (Number.isInteger(index))
                this.pendingImages.splice(index, 1);
        }
        this.ui.setStatus(this.pendingImages.length === 0
            ? 'pending images cleared'
            : `${this.pendingImages.length} image${this.pendingImages.length === 1 ? '' : 's'} attached to the next prompt`);
    }
    async promptMessage(text) {
        if (this.pendingImages.length === 0)
            return message(text);
        const selection = this.selection?.current;
        if (selection === undefined)
            throw new Error('model selection is unavailable');
        const info = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model);
        if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
            throw new Error(`the current model ${selection.provider}/${selection.model} does not accept image input`);
        }
        await Promise.all(this.pendingImages.map(image => this.ctx.attachments.validateImage(image)));
        const refs = [];
        for (const image of this.pendingImages)
            refs.push(await this.ctx.attachments.saveImage(image));
        return createUserMessage({
            content: [
                { type: 'text', text },
                ...refs.map(attachment => ({ type: 'image', attachment })),
            ],
            source: { kind: 'user' },
        });
    }
    async confirmDiscardPendingImages() {
        if (this.pendingImages.length === 0)
            return true;
        const choice = await this.ui.choose(`Discard ${this.pendingImages.length} unsent image${this.pendingImages.length === 1 ? '' : 's'} and change sessions?`, [
            { value: 'keep', label: 'Stay here', description: 'Keep the pending images' },
            { value: 'discard', label: 'Discard and switch', description: 'Unsent image drafts are temporary' },
        ], undefined, { initialValue: 'keep' });
        if (choice?.value !== 'discard')
            return false;
        return true;
    }
    async togglePlanMode() {
        const handle = this.handle;
        if (handle === undefined)
            throw new Error('no active DeepSeek session');
        const generation = this.sessionGeneration;
        const agent = handle.agent;
        const current = this.ctx.planMode.get(agent);
        const target = !(current.pending ?? current.active);
        await this.runHarnessCommand(target ? '/plan' : '/plan off', agent);
        if (generation !== this.sessionGeneration || this.handle !== handle)
            return;
        const next = this.ctx.planMode.get(agent);
        const selected = next.pending ?? next.active;
        this.ui.setStatus(next.pending === undefined
            ? `${selected ? 'plan' : 'build'} mode`
            : `${selected ? 'plan' : 'build'} mode queued for the next step`);
    }
    async stepReasoning(direction) {
        const handle = this.handle;
        const selectionRef = this.selection;
        const generation = this.sessionGeneration;
        if (handle === undefined)
            throw new Error('no active DeepSeek session');
        if (selectionRef === undefined)
            throw new Error('model selection is unavailable');
        const selection = selectionRef.current;
        if (selection === undefined)
            throw new Error('model selection is unavailable');
        const info = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model);
        if (generation !== this.sessionGeneration
            || this.handle !== handle
            || this.selection !== selectionRef
            || selectionRef.current !== selection)
            return;
        if (info.reasoning === undefined) {
            const status = 'reasoning is not configurable for the current model';
            this.ui.setStatus(status);
            this.ui.flashStatus(status);
            return;
        }
        const result = stepReasoningEffort(info.reasoning, selection.reasoningEffort, direction);
        if (result.kind === 'unavailable') {
            const status = result.reason === 'no-efforts'
                ? 'reasoning is not configurable for the current model'
                : 'the current reasoning level is unknown; use /reasoning';
            this.ui.setStatus(status);
            this.ui.flashStatus(status);
            return;
        }
        if (result.kind === 'boundary') {
            const status = `reasoning is already at ${result.effort}`;
            this.ui.setStatus(status);
            this.ui.flashStatus(status);
            return;
        }
        selectionRef.current = {
            provider: selection.provider,
            model: selection.model,
            reasoningEffort: ReasoningEffortId(result.effort),
        };
        this.refresh();
        this.ui.setStatus(`reasoning ${result.effort} · next request`);
    }
    submit(raw) {
        return this.enqueueAction(() => this.processSubmission(raw));
    }
    async processSubmission(raw) {
        if (this.closing || raw.trim() === '')
            return;
        const input = parseInput(raw);
        if (input.kind === 'prompt') {
            const sessionId = String(this.agent.id);
            this.cancelDraftSave();
            await this.draftStore.save(sessionId, input.text);
            try {
                const outgoing = await this.promptMessage(input.text);
                if (this.agent.status === 'running') {
                    if (this.busyEnter === 'steer') {
                        this.agent.steer(outgoing);
                        this.ui.setStatus('steering queued for the next step');
                    }
                    else {
                        this.agent.followup(outgoing);
                        this.ui.setStatus('follow-up queued after the active turn');
                    }
                }
                else {
                    this.agent.followup(outgoing);
                }
                this.pendingImages = [];
                const nextDraft = this.composerText() ?? '';
                if (nextDraft === '')
                    await this.draftStore.delete(sessionId);
                else
                    await this.draftStore.save(sessionId, nextDraft);
            }
            catch (error) {
                const newerText = this.composerText() ?? '';
                const restored = newerText === '' ? input.text : `${input.text}\n${newerText}`;
                this.replaceComposerText(restored);
                await this.draftStore.save(sessionId, restored);
                throw error;
            }
            return;
        }
        if (input.kind === 'harness-command') {
            if (input.line === '/goal') {
                await this.chooseGoalCommand();
                return;
            }
            if (input.line === '/plan') {
                await this.choosePlanCommand();
                return;
            }
            await this.runHarnessCommand(input.line);
            return;
        }
        switch (input.name) {
            case 'help':
                this.ui.appendNotice(formatCommandHelp(buildSlashCommands(this.ctx.commands.list(this.agent))));
                return;
            case 'stop':
                this.interrupt();
                return;
            case 'pause':
                await this.pauseAndExit();
                return;
            case 'exit':
                await this.shutdown(true);
                return;
            case 'new':
                await this.requestSessionSwitch();
                return;
            case 'resume':
                if (input.argument === '')
                    await this.chooseSession();
                else
                    await this.requestSessionSwitch(input.argument);
                return;
            case 'sessions':
                if (input.argument !== '' && input.argument !== 'archived')
                    throw new Error('usage: /sessions [archived]');
                await this.chooseSession(input.argument === 'archived');
                return;
            case 'session':
                if (input.argument !== '' && input.argument !== String(this.agent.id)) {
                    await this.requestSessionSwitch(input.argument);
                    if (String(this.agent.id) !== input.argument)
                        return;
                }
                await this.chooseSessionAction();
                return;
            case 'workspaces':
                if (input.argument !== '')
                    throw new Error('usage: /workspaces');
                await this.chooseWorkspace();
                return;
            case 'models':
                await this.showModels();
                return;
            case 'model':
                await this.selectModel(input.argument);
                return;
            case 'reasoning':
                await this.selectReasoning(input.argument);
                return;
            case 'permission':
                if (input.argument === '')
                    await this.choosePermission();
                else
                    await this.runHarnessCommand(`/permission ${input.argument}`);
                return;
            case 'busy':
                await this.selectBusyEnter(input.argument);
                return;
            case 'settings':
                await this.chooseSettings(input.argument);
                return;
            case 'queue':
                if (input.argument === '')
                    await this.chooseQueueManager();
                else {
                    this.agent.followup(message(input.argument));
                    this.ui.setStatus('follow-up queued');
                }
                return;
            case 'steer':
                if (input.argument === '')
                    throw new Error('usage: /steer <prompt>');
                this.agent.steer(message(input.argument));
                this.ui.setStatus('steering queued');
                return;
            case 'attach':
                await this.chooseAttachments(input.argument);
                return;
            case 'deliverables':
                await this.chooseDeliverable();
                return;
            case 'inspect':
                await this.chooseInspectorEntry();
                return;
            case 'stats':
                this.showSessionStats();
                return;
            case 'activity':
                await this.showActivity();
                return;
            case 'export':
                await this.exportSession(input.argument);
                return;
        }
    }
    async runHarnessCommand(line, agent = this.agent, generation = this.sessionGeneration) {
        const abort = new AbortController();
        const execution = await this.ctx.commands.execute(agent, line, abort.signal);
        if (execution === undefined) {
            if (generation === this.sessionGeneration && this.handle?.agent === agent) {
                const available = this.ctx.commands.list(agent).map(command => `/${command.name}`).join(', ');
                this.ui.appendNotice(`Unknown Harness command: ${line}\nAvailable: ${available || 'none'}`);
            }
            return;
        }
        if (generation === this.sessionGeneration && this.handle?.agent === agent)
            this.refresh();
    }
    findQueuedMessage(item) {
        return [...this.agent.inbox.nextStep, ...this.agent.inbox.nextTurn]
            .find(candidate => String(candidate.id) === item.id);
    }
    async chooseQueueManager() {
        while (!this.closing) {
            const items = queueItems(this.agent.inbox.nextStep, this.agent.inbox.nextTurn);
            if (items.length === 0) {
                this.ui.appendNotice('Queue is empty. Use /queue <prompt> to add a follow-up turn.');
                return;
            }
            const choice = await this.ui.chooseSearchable('Queued work', items.map(item => ({
                value: item.id,
                label: queueItemLabel(item),
                description: `${item.placement === 'next-step' ? 'Steer' : 'Follow-up'} · ${item.id}${item.editable ? '' : ' · image message'}`,
                searchText: `${item.id} ${item.text}`,
            })));
            if (choice === undefined)
                return;
            const selected = items.find(item => item.id === choice.value);
            if (selected === undefined || this.findQueuedMessage(selected) === undefined) {
                this.ui.flashStatus('That queue item is no longer pending.');
                continue;
            }
            const actions = [
                ...(selected.editable
                    ? [{ value: 'edit', label: 'Edit text…', description: 'Replace this queued message in place' }]
                    : []),
                { value: 'remove', label: 'Remove', description: 'Cancel this queued message' },
                { value: 'back', label: 'Back', description: 'Return to the queue' },
            ];
            const action = await this.ui.choose('Queue item', actions, undefined, { initialValue: 'back' });
            if (action === undefined || action.value === 'back')
                continue;
            if (action.value === 'edit') {
                const text = await this.ui.promptText('Replacement queue text:');
                if (text === undefined || text.trim() === '')
                    continue;
                if (!this.agent.inbox.replace(selected.id, message(text.trim()))) {
                    this.ui.flashStatus('That queue item was already claimed or removed.');
                }
                else {
                    this.ui.setStatus('queued message updated');
                }
                continue;
            }
            const confirmation = await this.ui.choose('Remove this queued message?', [
                { value: 'cancel', label: 'Cancel', description: 'Keep the message queued' },
                { value: 'remove', label: 'Remove message', description: 'This cannot be undone' },
            ], undefined, { initialValue: 'cancel' });
            if (confirmation?.value !== 'remove')
                continue;
            if (!this.agent.inbox.remove(selected.id)) {
                this.ui.flashStatus('That queue item was already claimed or removed.');
            }
            else {
                this.ui.setStatus('queued message removed');
            }
        }
    }
    presentedToolMutations() {
        const calls = new Map();
        const output = [];
        for (const event of this.agent.session.events) {
            if (event.type === 'tool/call') {
                calls.set(String(event.data.callId), event);
                continue;
            }
            if (event.type !== 'tool/result')
                continue;
            const block = event.data.message.content[0];
            const call = block?.type === 'tool-result' ? calls.get(String(block.toolCallId)) : undefined;
            if (call === undefined)
                continue;
            let argumentsValue = call.data.arguments;
            try {
                argumentsValue = JSON.parse(call.data.arguments);
            }
            catch { }
            const callView = this.ctx.tools.get(call.data.name, this.agent)?.presentCall?.(argumentsValue);
            output.push({
                seq: event.seq,
                turn: event.data.turn,
                failed: event.data.error !== undefined || (block?.type === 'tool-result' && block.isError === true),
                ...(callView === undefined ? {} : { callView }),
            });
        }
        return output;
    }
    async chooseDeliverable() {
        const deliverables = deriveDeliverables(this.presentedToolMutations());
        if (deliverables.length === 0) {
            this.ui.appendNotice('No successful mutation tools have reported produced files in this session.');
            return;
        }
        const choice = await this.ui.chooseSearchable('Produced files', deliverables.map(item => ({
            value: item.path,
            label: deliverableBasename(item.path),
            description: `turn ${item.turn} · ${item.path}`,
            searchText: item.path,
        })));
        if (choice === undefined)
            return;
        const cwd = this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd());
        const absolute = resolve(cwd, choice.value);
        const action = await this.ui.choose(choice.value, [
            { value: 'copy', label: 'Copy path', description: absolute },
            { value: 'open', label: 'Open externally', description: 'Use the operating system’s default application' },
            { value: 'cancel', label: 'Cancel' },
        ], undefined, { initialValue: 'cancel' });
        if (action?.value === 'copy') {
            this.ui.copyToClipboard(absolute);
            return;
        }
        if (action?.value === 'open') {
            const metadata = await stat(absolute);
            if (!metadata.isFile())
                throw new Error(`deliverable is not a file: ${choice.value}`);
            await openExternalPath(absolute);
            this.ui.setStatus(`opened ${choice.value}`);
        }
    }
    visibilitySnapshot() {
        return projectVisibility(this.agent.session.events, String(this.agent.id));
    }
    inspectorToolDetail(tool) {
        return [
            `${tool.kind === 'subtool' ? 'Nested tool' : 'Tool'} · ${tool.name}`,
            `- Call: ${tool.callId}`,
            `- Status: ${tool.status}`,
            `- Turn/step: ${tool.turn === undefined ? 'n/a' : String(tool.turn)}/${tool.step === undefined ? 'n/a' : String(tool.step)}`,
            `- Started: ${new Date(tool.startedAt).toLocaleString()} · seq ${String(tool.startSeq)}`,
            `- Duration: ${formatDuration(tool.durationMs)}`,
            ...(tool.parentCallId === undefined ? [] : [`- Parent call: ${tool.parentCallId}`]),
            ...(tool.rootCallId === undefined ? [] : [`- Root call: ${tool.rootCallId}`]),
            ...(tool.argumentsText === undefined ? [] : ['', 'Arguments', tool.argumentsText]),
            ...(tool.resultText === undefined ? [] : ['', tool.resultIsError === true ? 'Error result' : 'Result', tool.resultText]),
            ...(tool.resultMetaText === undefined ? [] : ['', 'Result metadata', tool.resultMetaText]),
        ].join('\n');
    }
    async chooseInspectorEntry() {
        const snapshot = this.visibilitySnapshot();
        const choices = [
            ...snapshot.tools.map((tool, index) => ({
                value: `tool:${String(index)}`,
                label: `${tool.kind === 'subtool' ? '↳ ' : ''}${tool.name}`,
                description: `${tool.status} · ${formatDuration(tool.durationMs)} · call ${tool.callId}`,
                searchText: [tool.name, tool.callId, tool.argumentsText, tool.resultText].filter(Boolean).join(' '),
            })).reverse(),
            ...snapshot.steps.map((step, index) => ({
                value: `step:${String(index)}`,
                label: `Turn ${String(step.turn)} · step ${String(step.step)}`,
                description: `${step.status} · model ${formatDuration(step.modelMs)} · first token ${formatDuration(step.ttftMs)}`,
            })).reverse(),
        ];
        if (choices.length === 0) {
            this.ui.appendNotice('No model steps or tool calls have been recorded in this session.');
            return;
        }
        const choice = await this.ui.chooseSearchable('Session inspector', choices);
        if (choice === undefined)
            return;
        const [kind, rawIndex] = choice.value.split(':');
        const index = Number(rawIndex);
        if (kind === 'tool') {
            const tool = snapshot.tools[index];
            if (tool !== undefined)
                this.ui.appendNotice(this.inspectorToolDetail(tool));
            return;
        }
        const step = snapshot.steps[index];
        if (step === undefined)
            return;
        this.ui.appendNotice([
            `Turn ${String(step.turn)} · step ${String(step.step)}`,
            `- Status: ${step.status}`,
            `- Started: ${new Date(step.startedAt).toLocaleString()} · seq ${String(step.startSeq)}`,
            `- Model time: ${formatDuration(step.modelMs)}`,
            `- First token: ${formatDuration(step.ttftMs)}`,
            `- Decode: ${formatDuration(step.decodeMs)}`,
            `- Output tokens: ${step.outputTokens === undefined ? 'n/a' : formatTokenCount(step.outputTokens)}`,
        ].join('\n'));
    }
    showSessionStats() {
        const visibility = this.visibilitySnapshot();
        const official = this.ctx.sessionProjections.snapshot(this.agent.session).values.sessionStats;
        const timing = official ?? visibility.timing;
        const tokens = visibility.tokens;
        const averageTtft = timing.ttftSteps === 0 ? undefined : timing.ttftMs / timing.ttftSteps;
        const decodeRate = timing.decodeMs === 0 ? undefined : timing.decodeTokens / (timing.decodeMs / 1_000);
        this.ui.appendNotice([
            'Session statistics',
            `- Turns / steps: ${String(timing.turns)} / ${String(timing.steps)}`,
            `- Model / tool time: ${formatDuration(timing.llmMs)} / ${formatDuration(timing.toolMs)}`,
            `- Average first-token latency: ${formatDuration(averageTtft)}`,
            `- Decode: ${formatDuration(timing.decodeMs)} · ${decodeRate === undefined ? 'n/a' : `${decodeRate.toFixed(1)} tokens/s`}`,
            `- Nested Code Mode tool time: ${formatDuration(visibility.timing.subtoolMs)}`,
            '',
            'Provider-reported tokens',
            `- Uncached input: ${formatTokenCount(tokens.uncachedInputTokens)}`,
            `- Cache read: ${formatTokenCount(tokens.cacheReadTokens)}`,
            `- Cache write: ${formatTokenCount(tokens.cacheWriteTokens)}`,
            `- Output: ${formatTokenCount(tokens.outputTokens)}`,
        ].join('\n'));
    }
    async showActivity() {
        const category = await this.ui.choose('Session activity', [
            { value: 'jobs', label: 'Background jobs', description: 'Process-local work visible to this session' },
            { value: 'workflows', label: 'Workflows', description: 'Durable workflow runs recorded in this session' },
            { value: 'subagents', label: 'Subagents', description: 'Durable descendant sessions and current residency' },
        ]);
        if (category === undefined)
            return;
        if (category.value === 'jobs') {
            const jobs = this.ctx.jobs.list(this.agent);
            if (jobs.length === 0) {
                this.ui.appendNotice('No background jobs are registered for this session.\n\nJob state is process-local and is not restored after the Harness exits.');
                return;
            }
            const choice = await this.ui.chooseSearchable('Background jobs', jobs.map((job, index) => ({
                value: String(index),
                label: `${job.id} · ${job.label}`,
                description: `${job.status}${job.detail === undefined ? '' : ` · ${job.detail}`}`,
                searchText: `${job.id} ${job.kind} ${job.label} ${job.status} ${job.detail ?? ''}`,
            })));
            const job = choice === undefined ? undefined : jobs[Number(choice.value)];
            if (job !== undefined) {
                this.ui.appendNotice([
                    `${job.id} · ${job.label}`,
                    `- Kind / status: ${job.kind} / ${job.status}`,
                    `- Started: ${new Date(job.startedAt).toLocaleString()}`,
                    ...(job.finishedAt === undefined ? [] : [`- Finished: ${new Date(job.finishedAt).toLocaleString()}`]),
                    ...(job.detail === undefined ? [] : [`- Detail: ${job.detail}`]),
                    `- Reported: ${job.reported ? 'yes' : 'no'}`,
                    '',
                    'Job state is process-local. This inspector does not consume job output or change its reported state.',
                ].join('\n'));
            }
            return;
        }
        if (category.value === 'workflows') {
            const workflows = projectWorkflowActivity(this.agent.session.events);
            if (workflows.length === 0) {
                this.ui.appendNotice('No durable workflow runs have been recorded in this session.');
                return;
            }
            const choice = await this.ui.chooseSearchable('Workflow runs', workflows.map((workflow, index) => ({
                value: String(index),
                label: workflow.name,
                description: `${workflow.stopReason ?? 'active/incomplete'} · ${String(workflow.members.length)} agents · ${workflow.id}`,
                searchText: `${workflow.name} ${workflow.id} ${workflow.members.map(member => member.label).join(' ')}`,
            })));
            const workflow = choice === undefined ? undefined : workflows[Number(choice.value)];
            if (workflow !== undefined) {
                this.ui.appendNotice([
                    `${workflow.name} · ${workflow.id}`,
                    `- Status: ${workflow.stopReason ?? 'active/incomplete'}`,
                    `- Started: ${new Date(workflow.startedAt).toLocaleString()}`,
                    ...(workflow.endedAt === undefined ? [] : [`- Duration: ${formatDuration(workflow.endedAt - workflow.startedAt)}`]),
                    ...(workflow.members.length === 0
                        ? ['- Agents: none recorded']
                        : ['', 'Agents', ...workflow.members.map(member => `- ${member.phase === undefined ? '' : `${member.phase} · `}${member.label} · ${member.outcome} · ${member.childId}`)]),
                    '',
                    'This view comes from top-level durable tool-workflow records. A missing end can mean active work, a crash, or incomplete recording; live phase/log text and result values are not persisted by Harness rc.6.',
                ].join('\n'));
            }
            return;
        }
        const abort = new AbortController();
        this.activityLoadAbort?.abort(new Error('activity loading superseded'));
        this.activityLoadAbort = abort;
        const agent = this.agent;
        const generation = this.sessionGeneration;
        this.ui.setStatus('loading subagent tree…');
        try {
            const descendants = await this.ctx.subagents.listDescendants(agent.id, abort.signal);
            if (generation !== this.sessionGeneration || this.handle?.agent !== agent)
                return;
            if (descendants.length === 0) {
                this.ui.appendNotice('No durable subagent descendants were found for this session.');
                return;
            }
            const choice = await this.ui.chooseSearchable('Subagent descendants', descendants.map((entry, index) => ({
                value: String(index),
                label: `${'  '.repeat(Math.max(0, entry.depth - 1))}${entry.kind === 'child' ? entry.label ?? String(entry.id) : String(entry.id)}`,
                description: entry.kind === 'child'
                    ? `${entry.mode} · ${entry.activity}${entry.hasChildren ? ' · has children' : ''}`
                    : `diagnostic · ${entry.reason}`,
                searchText: entry.kind === 'child'
                    ? `${entry.id} ${entry.label ?? ''} ${entry.mode} ${entry.activity}`
                    : `${entry.id} ${entry.reason}`,
            })));
            const entry = choice === undefined ? undefined : descendants[Number(choice.value)];
            if (entry !== undefined) {
                this.ui.appendNotice(entry.kind === 'child'
                    ? [
                        `${entry.label ?? entry.id}`,
                        `- Session: ${entry.id}`,
                        `- Parent: ${entry.parentId}`,
                        `- Depth: ${String(entry.depth)}`,
                        `- Mode: ${entry.mode}`,
                        `- Activity: ${entry.activity}`,
                        `- Has children: ${entry.hasChildren ? 'yes' : 'no'}`,
                        '',
                        'Activity means resident or persisted; it is not a durable success/failure outcome.',
                    ].join('\n')
                    : `Subagent diagnostic\n- Session: ${entry.id}\n- Parent: ${entry.parentId}\n- Depth: ${String(entry.depth)}\n- Reason: ${entry.reason}`);
            }
        }
        finally {
            if (this.activityLoadAbort === abort)
                this.activityLoadAbort = undefined;
        }
    }
    async exportSession(argument) {
        let format = argument.trim();
        if (format !== '' && format !== 'json' && format !== 'markdown') {
            throw new Error('usage: /export [markdown|json]');
        }
        if (format === '') {
            const selected = await this.ui.choose('Export format', [
                { value: 'markdown', label: 'Markdown', description: 'Readable transcript plus a lossless event-log appendix' },
                { value: 'json', label: 'JSON', description: 'Versioned portable data envelope' },
            ], undefined, { initialValue: 'markdown' });
            if (selected === undefined)
                return;
            format = selected.value;
        }
        const cwd = this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd());
        const defaultPath = join(cwd, defaultSessionExportFilename(this.agent.session.header, format));
        const destinationChoice = await this.ui.choose(`Export current session\n\n${SESSION_EXPORT_DISCLOSURE}`, [
            { value: 'default', label: 'Save in workspace', description: defaultPath },
            { value: 'custom', label: 'Choose another path…', description: 'Enter an absolute or working-directory-relative path' },
            { value: 'cancel', label: 'Cancel' },
        ], undefined, { initialValue: 'default' });
        if (destinationChoice === undefined || destinationChoice.value === 'cancel')
            return;
        let destination = defaultPath;
        if (destinationChoice.value === 'custom') {
            const customPath = await this.ui.promptText('Export destination path:');
            if (customPath === undefined || customPath.trim() === '')
                return;
            destination = resolve(cwd, customPath.trim());
        }
        const session = this.agent.session;
        await this.ctx.sessions.flush(session);
        const official = this.ctx.sessionProjections.snapshot(session);
        const events = session.events.filter(event => event.seq <= official.asOfSeq);
        const sessionId = String(this.agent.id);
        const presenter = {
            presentCall: (name, argumentsValue) => this.ctx.tools.get(name, this.agent)?.presentCall?.(argumentsValue),
            presentResult: (name, argumentsValue, result) => this.ctx.tools.get(name, this.agent)?.presentResult?.(argumentsValue, result),
        };
        const input = {
            header: session.header,
            events,
            projections: {
                transcript: projectSession(sessionId, events, presenter),
                visibility: projectVisibility(events, sessionId),
                official,
            },
        };
        try {
            const written = await writeSessionExport(input, destination, { format });
            this.ui.appendNotice(`Exported ${format} session to ${written.path} (${formatTokenCount(written.bytes)} bytes).\n${SESSION_EXPORT_DISCLOSURE}`);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const overwrite = await this.ui.choose(`Replace existing export?\n\n${destination}`, [
                { value: 'cancel', label: 'Cancel', description: 'Keep the existing file' },
                { value: 'overwrite', label: 'Replace file', description: 'Atomically overwrite this exact path' },
            ], undefined, { initialValue: 'cancel' });
            if (overwrite?.value !== 'overwrite')
                return;
            const written = await writeSessionExport(input, destination, { format, overwrite: true });
            this.ui.appendNotice(`Exported ${format} session to ${written.path} (${formatTokenCount(written.bytes)} bytes).\n${SESSION_EXPORT_DISCLOSURE}`);
        }
    }
    interrupt() {
        if (this.handle === undefined)
            return;
        const sessionLoad = this.sessionLoadAbort;
        if (sessionLoad !== undefined)
            sessionLoad.abort(new Error('session loading cancelled'));
        const activityLoad = this.activityLoadAbort;
        if (activityLoad !== undefined)
            activityLoad.abort(new Error('activity loading cancelled'));
        if (this.agent.status === 'running') {
            this.agent.cancel({ kind: 'user' }, { keepInbox: true });
            this.ui.setStatus('stopping current turn…');
        }
        else {
            this.ui.setStatus('idle · Ctrl+D or /exit to close');
        }
    }
    pendingInboxCount() {
        if (this.handle === undefined)
            return 0;
        return this.agent.inbox.nextTurn.length + this.agent.inbox.nextStep.length;
    }
    blockSessionChangeForPending() {
        const count = this.pendingInboxCount();
        if (count === 0)
            return false;
        const status = `wait for ${count} queued ${count === 1 ? 'message' : 'messages'} before changing sessions`;
        this.ui.setStatus(status);
        this.ui.flashStatus(status);
        return true;
    }
    async requestSessionSwitch(resumeId) {
        if (resumeId !== undefined && resumeId === String(this.agent.id))
            return;
        if (this.blockSessionChangeForPending())
            return;
        // Validate a direct resume target before the current agent is stopped.
        if (resumeId !== undefined)
            await this.ctx.sessionPersistence.inspect(SessionId(resumeId));
        if (this.agent.status === 'running') {
            const target = resumeId === undefined ? 'create a new session' : 'open the selected session';
            const choice = await this.ui.choose(`The current turn is still running. Stop it and ${target}?`, [
                { value: 'stay', label: 'Stay here', description: 'Keep the current turn running' },
                { value: 'switch', label: 'Stop and switch', description: 'Stop this turn, save it, and change sessions' },
            ], undefined, { initialValue: 'stay' });
            if (choice?.value !== 'switch')
                return;
        }
        // A message may have been queued while the confirmation was open.
        if (this.blockSessionChangeForPending())
            return;
        if (!await this.confirmDiscardPendingImages())
            return;
        await this.switchSession(resumeId);
    }
    async switchSession(resumeId) {
        this.ui.setStatus(resumeId ? `opening ${resumeId}…` : 'creating a new session…');
        const previousId = String(this.agent.id);
        const previousSelection = this.selection?.current;
        await this.persistCurrentDraft();
        await this.detachCurrent();
        try {
            await this.open(resumeId);
        }
        catch (error) {
            try {
                await this.open(previousId, previousSelection);
                this.ui.appendNotice(`Session change failed; restored ${previousId}`);
            }
            catch {
                await this.open(undefined, previousSelection);
                this.pendingImages = [];
                this.ui.appendNotice('Session change failed; opened a fresh session because the previous session could not be restored.');
            }
            await this.restoreCurrentDraft();
            this.refresh();
            throw error;
        }
        this.pendingImages = [];
        this.ui.appendLaunchBanner(String(this.agent.id), this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd()));
        await this.restoreCurrentDraft();
        this.ui.appendNotice(resumeId ? `Resumed ${resumeId}` : `New session ${this.agent.id}`);
        this.refresh();
    }
    async chooseSessionAction() {
        const action = await this.ui.choose('Current session actions', [
            { value: 'rename', label: 'Rename…', description: 'Set a durable title for this session' },
            { value: 'fork', label: 'Fork…', description: 'Create a new session from a completed turn' },
            { value: 'archive', label: 'Archive…', description: 'Hide this session from normal navigation' },
            { value: 'cancel', label: 'Cancel' },
        ], undefined, { initialValue: 'cancel' });
        if (action === undefined || action.value === 'cancel')
            return;
        if (action.value === 'rename') {
            const current = this.ctx.sessionTitle.get(this.agent.session)?.title;
            const title = await this.ui.promptText(`New session title${current === undefined ? '' : ` (currently: ${current})`}:`);
            if (title === undefined)
                return;
            const renamed = this.ctx.sessionTitle.rename(this.agent.session, title);
            await this.ctx.sessions.flush(this.agent.session);
            this.sessionNavigatorCache.delete(String(this.agent.id));
            this.ui.appendNotice(`Renamed this session to ${renamed.title}.`);
            return;
        }
        if (action.value === 'fork') {
            await this.chooseForkBoundary();
            return;
        }
        await this.archiveCurrentSession();
    }
    async chooseForkBoundary() {
        if (this.blockSessionChangeForPending())
            return;
        if (this.agent.status === 'running') {
            this.ui.flashStatus('Stop the active turn before creating a fork.');
            return;
        }
        if (!await this.confirmDiscardPendingImages())
            return;
        const endings = this.agent.session.events.filter(event => event.type === 'turn/end');
        const choices = endings.length === 0
            ? [{ value: '-1', label: 'Empty fork', description: 'Start with no prior turns' }]
            : endings.map(event => ({
                value: String(event.seq),
                label: `After turn ${event.data.turn}`,
                description: `${event.data.reason} · ${new Date(event.time).toLocaleString()} · seq ${event.seq}`,
            })).reverse();
        const choice = await this.ui.choose('Fork boundary', choices, undefined, { initialValue: choices[0]?.value });
        if (choice === undefined)
            return;
        await this.forkCurrentSession(Number(choice.value));
    }
    async forkCurrentSession(boundary) {
        const source = this.agent.session;
        const previousId = String(source.id);
        const previousSelection = this.selection?.current;
        if (previousSelection === undefined)
            throw new Error('model selection is unavailable');
        const seed = boundary < 0 ? [] : source.events.filter(event => event.seq <= boundary);
        const childId = SessionId(`session-${randomUUID()}`);
        const selection = { current: previousSelection, assembled: undefined };
        await this.persistCurrentDraft();
        await this.detachCurrent();
        try {
            const contextWindow = await this.resolveContextWindow(previousSelection);
            const handle = await this.ctx.agents.create({
                sessionId: childId,
                meta: {
                    ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
                    parentSession: source.id,
                    seedLength: seed.length,
                },
                seed,
                agentOptions: { provider: previousSelection.provider, model: previousSelection.model },
                setup: (agentCtx) => { installModelSelection(agentCtx, selection); },
            });
            this.activateSession({ handle, selection, contextWindow });
            await this.attachCurrentWorkspace();
            this.pendingImages = [];
        }
        catch (error) {
            await this.open(previousId, previousSelection);
            await this.restoreCurrentDraft();
            this.refresh();
            throw error;
        }
        this.ui.appendLaunchBanner(String(this.agent.id), this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd()));
        await this.restoreCurrentDraft();
        this.ui.appendNotice(`Forked ${previousId} into ${this.agent.id} at ${boundary < 0 ? 'an empty history' : `seq ${boundary}`}.`);
        this.refresh();
    }
    async archiveCurrentSession() {
        const archivedId = String(this.agent.id);
        const confirmation = await this.ui.choose(`Archive ${archivedId}?\n\nThe session log will be preserved, but Harness rc.6 cannot unarchive it.`, [
            { value: 'cancel', label: 'Cancel', description: 'Keep the session in normal navigation' },
            { value: 'archive', label: 'Archive session', description: 'Hide it from normal session and workspace lists' },
        ], undefined, { initialValue: 'cancel' });
        if (confirmation?.value !== 'archive')
            return;
        await this.requestSessionSwitch();
        if (String(this.agent.id) === archivedId)
            return;
        await this.ctx.workspaceRegistry.archiveSession(SessionId(archivedId));
        this.sessionNavigatorCache.delete(archivedId);
        this.ui.appendNotice(`Archived ${archivedId}. Its durable session log was preserved.`);
    }
    async chooseWorkspace() {
        const workspaceRegistry = this.ctx.get?.('workspaceRegistry');
        const archived = new Set(workspaceRegistry?.archivedSessionIds.map(String) ?? []);
        const workspaces = this.ctx.workspaceRegistry.list();
        const snapshots = await this.ctx.sessionPersistence.listSnapshots();
        const visibleIds = snapshots
            .filter(snapshot => snapshot.header.origin !== 'subagent' && !archived.has(String(snapshot.header.id)))
            .map(snapshot => String(snapshot.header.id));
        const visibleIdSet = new Set(visibleIds);
        const groupedIds = new Set(workspaces.flatMap(workspace => workspace.sessionIds.map(String)));
        const workspaceGroups = workspaces.map(workspace => {
            const ids = workspace.sessionIds.map(String).filter(id => visibleIdSet.has(id));
            return {
                value: String(workspace.id),
                label: workspace.title,
                description: `${ids.length} sessions · ${workspace.path}`,
                ids: new Set(ids),
            };
        });
        const groups = [
            ...workspaceGroups,
            {
                value: 'ungrouped',
                label: 'Ungrouped sessions',
                description: `${visibleIds.filter(id => !groupedIds.has(id)).length} sessions`,
                ids: new Set(visibleIds.filter(id => !groupedIds.has(id))),
            },
        ].filter(group => group.ids.size > 0);
        if (groups.length === 0) {
            this.ui.appendNotice('No workspace-grouped sessions are available.');
            return;
        }
        const group = await this.ui.chooseSearchable('Workspaces', groups.map(item => ({
            value: item.value,
            label: item.label,
            description: item.description,
            searchText: `${item.label} ${item.description}`,
        })));
        if (group === undefined)
            return;
        const selected = groups.find(item => item.value === group.value);
        if (selected === undefined)
            return;
        const items = (await this.loadSessionPickerItems()).filter(item => selected.ids.has(item.value));
        const session = await this.ui.chooseSearchable(selected.label, items, undefined, {
            initialValue: String(this.agent.id),
            emptyText: 'No matching sessions',
        });
        if (session !== undefined && session.value !== String(this.agent.id))
            await this.requestSessionSwitch(session.value);
    }
    async detachCurrent() {
        if (this.handle === undefined)
            return;
        const handle = this.handle;
        const agent = handle.agent;
        this.sessionGeneration += 1;
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        await agent.whenIdle();
        await this.ctx.sessions.flush(agent.session);
        await handle.dispose();
        if (this.handle !== handle)
            return;
        while (this.subscriptions.length > 0)
            this.subscriptions.pop()?.();
        this.handle = undefined;
        this.selection = undefined;
        this.projection = undefined;
        this.projectionCursor = 0;
        this.selectedContextWindow = undefined;
    }
    async chooseSession(archived = false) {
        this.ui.setStatus(archived ? 'loading archived sessions…' : 'loading sessions…');
        const abort = new AbortController();
        this.sessionLoadAbort = abort;
        let items;
        try {
            items = await this.loadSessionPickerItems(abort.signal, archived);
        }
        catch (error) {
            if (abort.signal.aborted) {
                this.ui.setStatus('session loading cancelled');
                return;
            }
            throw error;
        }
        finally {
            if (this.sessionLoadAbort === abort)
                this.sessionLoadAbort = undefined;
        }
        if (items.length === 0) {
            this.ui.appendNotice(archived ? 'No archived sessions.' : 'No sessions are available.');
            this.ui.setStatus('ready');
            return;
        }
        const currentId = String(this.agent.id);
        const choice = await this.ui.chooseSearchable(archived ? 'Archived sessions' : 'Sessions', items, undefined, {
            initialValue: items.some(item => item.value === currentId) ? currentId : undefined,
            emptyText: 'No matching sessions',
        });
        if (choice === undefined || choice.value === currentId) {
            this.ui.setStatus('ready');
            return;
        }
        await this.requestSessionSwitch(choice.value);
    }
    async loadSessionPickerItems(signal, archivedOnly = false) {
        const snapshots = await this.ctx.sessionPersistence.listSnapshots(signal);
        signal?.throwIfAborted();
        const workspaceRegistry = this.ctx.get?.('workspaceRegistry');
        const archived = new Set(workspaceRegistry?.archivedSessionIds.map(String) ?? []);
        const visible = snapshots.filter(snapshot => snapshot.header.origin !== 'subagent'
            && archived.has(String(snapshot.header.id)) === archivedOnly);
        const visibleIds = new Set(visible.map(snapshot => String(snapshot.header.id)));
        for (const id of this.sessionNavigatorCache.keys()) {
            if (!visibleIds.has(id))
                this.sessionNavigatorCache.delete(id);
        }
        const currentId = String(this.agent.id);
        const sources = await mapWithConcurrency(visible, 8, snapshot => this.loadSessionPickerSource(snapshot, currentId, signal));
        if (!visibleIds.has(currentId)
            && this.agent.session.header.origin !== 'subagent'
            && archived.has(currentId) === archivedOnly) {
            sources.push(this.liveSessionPickerSource());
        }
        return sessionPickerItems(sources);
    }
    async loadSessionPickerSource(snapshot, currentId, signal) {
        signal?.throwIfAborted();
        const id = String(snapshot.header.id);
        if (id === currentId)
            return this.liveSessionPickerSource();
        const revision = String(snapshot.revision);
        const cached = this.sessionNavigatorCache.get(id);
        if (cached?.revision === revision)
            return cached.source;
        try {
            const inspected = await this.ctx.sessionPersistence.inspect(snapshot.header.id, signal);
            const source = this.sessionPickerSource(inspected.meta, inspected.events);
            this.sessionNavigatorCache.set(id, { revision, source });
            return source;
        }
        catch {
            signal?.throwIfAborted();
            return this.sessionPickerSource(snapshot.header, [], { titleUnavailable: true });
        }
    }
    liveSessionPickerSource() {
        return this.sessionPickerSource(this.agent.session.header, this.agent.session.events, {
            current: true,
            running: this.agent.status === 'running',
        });
    }
    sessionPickerSource(header, events, state = {}) {
        return {
            id: String(header.id),
            title: foldSessionTitle(events)?.title,
            cwd: header.cwd,
            createdAt: header.createdAt,
            updatedAt: updatedAt(events, header.createdAt),
            parentSession: header.parentSession === undefined ? undefined : String(header.parentSession),
            ...state,
        };
    }
    permissionPickerItems() {
        const current = this.ctx.permissionPresets.current(this.agent.session.events);
        return this.ctx.permissionPresets.names.map(name => {
            const option = this.ctx.permissionPresets.optionOf(name);
            return {
                value: option.value,
                label: option.name,
                description: `${name === current ? 'Current · ' : ''}${option.description ?? name}`,
            };
        });
    }
    async choosePermission() {
        const choice = await this.ui.choose('Choose a permission mode', this.permissionPickerItems(), undefined, {
            initialValue: this.ctx.permissionPresets.current(this.agent.session.events),
        });
        if (choice !== undefined)
            await this.runHarnessCommand(`/permission ${choice.value}`);
    }
    async chooseGoalCommand() {
        const choice = await this.ui.choose('Goal actions', [...GOAL_PICKER_ITEMS]);
        if (choice === undefined)
            return;
        if (choice.value === 'view') {
            await this.runHarnessCommand('/goal');
            return;
        }
        if (choice.value === 'set' || choice.value === 'edit') {
            const objective = await this.ui.promptText(choice.value === 'edit' ? 'Enter the revised goal objective:' : 'Enter the goal objective:');
            if (objective?.trim()) {
                await this.runHarnessCommand(`/goal ${choice.value === 'edit' ? 'edit ' : ''}${objective.trim()}`);
            }
            return;
        }
        await this.runHarnessCommand(`/goal ${choice.value}`);
    }
    async choosePlanCommand() {
        const choice = await this.ui.choose('Plan mode', [...PLAN_PICKER_ITEMS], undefined, {
            initialValue: this.projection?.planMode ? 'enter' : 'off',
        });
        if (choice === undefined)
            return;
        if (choice.value === 'message') {
            const guidance = await this.ui.promptText('Enter plan-mode guidance:');
            if (guidance?.trim())
                await this.runHarnessCommand(`/plan ${guidance.trim()}`);
            return;
        }
        await this.runHarnessCommand(choice.value === 'off' ? '/plan off' : '/plan');
    }
    async loadModels() {
        const available = [];
        for (const provider of this.ctx.llm.listProviders()) {
            try {
                const models = await this.ctx.llm.listModels(provider.id);
                for (const model of models) {
                    available.push({ provider: provider.id, model: model.id, name: model.name });
                }
            }
            catch {
                // A provider that cannot enumerate models stays out of the picker.
            }
        }
        return available;
    }
    async showModels() {
        const lines = [];
        for (const provider of this.ctx.llm.listProviders()) {
            try {
                const models = await this.ctx.llm.listModels(provider.id);
                if (models.length === 0)
                    lines.push(`- ${provider.id} · no advertised models`);
                else
                    for (const model of models)
                        lines.push(`- ${provider.id}/${model.id} · ${model.name}`);
            }
            catch (error) {
                lines.push(`- ${provider.id} · ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.ui.appendNotice(`Available models\n${lines.join('\n') || 'No active providers.'}`);
    }
    async selectModel(value) {
        const interactive = value.trim() === '';
        if (interactive) {
            const items = modelPickerItems(await this.loadModels());
            if (items.length === 0) {
                this.ui.appendNotice('No models are currently available.');
                return;
            }
            const current = this.selection?.current;
            const choice = await this.ui.choose('Choose a model', items, undefined, {
                initialValue: current === undefined ? undefined : `${current.provider}/${current.model}`,
            });
            if (choice === undefined)
                return;
            value = choice.value;
        }
        const ref = parseModelRef(value);
        if (ref === undefined)
            throw new Error('usage: /model <provider>/<model>');
        const info = await this.ctx.llm.resolveModelInfo(ref.provider, ref.model);
        if (this.selection === undefined)
            throw new Error('model selection is unavailable');
        let next = ref;
        if (interactive && info.reasoning !== undefined) {
            const reasoning = await this.ui.choose('Choose reasoning effort', reasoningPickerItems(info.reasoning), undefined, { initialValue: reasoningInitialValue(this.selection.current, ref) });
            if (reasoning === undefined)
                return;
            next = {
                ...ref,
                ...(reasoning.value === 'default' ? {} : { reasoningEffort: ReasoningEffortId(reasoning.value) }),
            };
        }
        this.selection.current = next;
        this.selectedContextWindow = info.context?.contextWindow;
        this.ui.appendNotice(`Next request will use ${ref.provider}/${ref.model} · reasoning ${next.reasoningEffort ?? 'model default'}`);
        this.refresh();
    }
    async loadReasoningPickerItems() {
        const selection = this.selection?.current;
        if (selection === undefined)
            return [];
        const info = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model);
        return info.reasoning === undefined ? [] : reasoningPickerItems(info.reasoning);
    }
    async chooseReasoning() {
        const items = await this.loadReasoningPickerItems();
        if (items.length === 0) {
            this.ui.appendNotice('The current model does not expose configurable reasoning effort.');
            return;
        }
        const choice = await this.ui.choose('Choose reasoning effort', items, undefined, {
            initialValue: this.selection?.current?.reasoningEffort ?? 'default',
        });
        if (choice !== undefined)
            await this.selectReasoning(choice.value);
    }
    async selectReasoning(value) {
        if (value.trim() === '') {
            await this.chooseReasoning();
            return;
        }
        const selection = this.selection?.current;
        if (selection === undefined)
            throw new Error('model selection is unavailable');
        const info = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model);
        if (info.reasoning === undefined)
            throw new Error('current model does not support reasoning effort selection');
        const normalized = value.trim();
        if (normalized !== 'default' && !info.reasoning.efforts.some(effort => effort.id === normalized)) {
            throw new Error(`unknown reasoning effort: ${normalized}`);
        }
        this.selection.current = {
            provider: selection.provider,
            model: selection.model,
            ...(normalized === 'default' ? {} : { reasoningEffort: ReasoningEffortId(normalized) }),
        };
        this.ui.appendNotice(normalized === 'default'
            ? 'Reasoning effort reset to the model default.'
            : `Reasoning effort set to ${normalized}.`);
        this.refresh();
    }
    async selectBusyEnter(value) {
        if (value.trim() === '') {
            const choice = await this.ui.choose('Plain Enter while the agent is busy', [...BUSY_PICKER_ITEMS], undefined, {
                initialValue: this.busyEnter,
            });
            if (choice === undefined)
                return;
            value = choice.value;
        }
        if (value !== 'queue' && value !== 'steer')
            throw new Error('usage: /busy <queue|steer>');
        this.busyEnter = value;
        this.ui.appendNotice(`Busy Enter now ${value === 'queue' ? 'queues a follow-up' : 'steers the active turn'}.`);
    }
    settingsSummary() {
        const current = this.selection?.current;
        const model = current === undefined ? 'unavailable' : `${current.provider}/${current.model}`;
        const currentPermission = this.ctx.permissionPresets.current(this.agent.session.events);
        const defaults = this.ctx.agentDefaultModel.currentSelection();
        return [
            'Core TUI settings',
            `- Current model: ${model}`,
            `- Current reasoning: ${current?.reasoningEffort ?? 'model default'}`,
            `- Current permission: ${currentPermission}`,
            `- Busy Enter: ${this.busyEnter}`,
            `- Transcript detail: ${this.transcriptDensity}`,
            `- New-session model: ${defaults.provider}/${defaults.model}`,
            `- New-session reasoning: ${defaults.reasoningEffort ?? 'model default'}`,
            `- New-session permission: ${this.ctx.permissionPresets.defaultPreset}`,
            `- Working directory: ${this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd())}`,
        ].join('\n');
    }
    async showProviders() {
        const active = this.ctx.llm.listProviders();
        const configurable = new Map(this.ctx.llm.listConfigurableProviders().map(provider => [provider.provider, provider]));
        const rows = await Promise.all(active.map(async (provider) => {
            try {
                const models = await this.ctx.llm.listModels(provider.id);
                const modelSummary = models.length === 0
                    ? 'no catalog models'
                    : models.map(model => `${model.id} [${model.inputModalities?.join('+') ?? 'capabilities unknown'}]`).join(', ');
                const config = configurable.get(provider.id);
                return `- ${provider.id} (${provider.name}) · active${config === undefined ? '' : ` · settings ${config.settingsNs}`}\n  ${modelSummary}`;
            }
            catch (error) {
                return `- ${provider.id} (${provider.name}) · model listing failed: ${String(error)}`;
            }
        }));
        const activeIds = new Set(active.map(provider => provider.id));
        const dormant = [...configurable.values()]
            .filter(provider => !activeIds.has(provider.provider))
            .map(provider => `- ${provider.provider} (${provider.displayName}) · dormant · settings ${provider.settingsNs}`);
        this.ui.appendNotice([
            'Provider routes',
            ...(rows.length === 0 ? ['- No active provider adapters.'] : rows),
            ...(dormant.length === 0 ? [] : ['', 'Configurable but inactive', ...dormant]),
            '',
            'Credentials are intentionally not displayed. Use `deepseek auth status` to inspect the active credential source.',
            'Provider profile changes remain a settings.yaml / advanced-settings workflow.',
        ].join('\n'));
    }
    showRuntime() {
        const service = this.ctx.get('pluginInventory');
        const entries = service?.list().entries ?? [];
        const dshHome = resolveDshHome();
        this.ui.appendNotice([
            'Harness Host runtime',
            ...(entries.length === 0
                ? ['- Plugin inventory is unavailable.']
                : entries.map(entry => `- ${entry.entryId} · ${entry.moduleName} · ${entry.enabled ? entry.fiberPhase ?? 'enabled' : 'disabled'}`)),
            '',
            'Configuration files',
            `- User settings: ${join(dshHome, 'settings.yaml')}`,
            `- TUI profile: ${join(dshHome, 'profiles', 'tui')}`,
            `- User agent presets: ${join(dshHome, '.agent-presets')}`,
            '',
            'Plugin enablement and preset composition are configuration-file workflows; this panel is read-only.',
        ].join('\n'));
    }
    async showSupport() {
        const action = await this.ui.choose('Support and feedback\n\nThe official /feedback command records your note in this session. Its acknowledgement will disclose whether session sharing is enabled, feedback-gated, disabled, or not configured.', [
            { value: 'cancel', label: 'Cancel', description: 'Do not record feedback' },
            { value: 'feedback', label: 'Write feedback…', description: 'Record a note through the official Harness command' },
        ], undefined, { initialValue: 'cancel' });
        if (action?.value !== 'feedback')
            return;
        const text = await this.ui.promptText('Feedback about this session:');
        if (text === undefined || text.trim() === '')
            return;
        await this.runHarnessCommand(`/feedback ${text.trim()}`);
    }
    loadSettingsNamespacePickerItems() {
        return settingsNamespacePickerItems(this.ctx.settings.describe({ redactSecrets: true }).map(descriptor => ({
            ns: String(descriptor.ns),
            applies: descriptor.applies,
            revision: descriptor.revision,
            secrets: descriptor.secrets,
        })));
    }
    async editAdvancedSettings(namespace = '') {
        const descriptors = this.ctx.settings.describe({ redactSecrets: true });
        if (descriptors.length === 0) {
            this.ui.appendNotice('No runtime settings namespaces are registered.');
            return;
        }
        if (namespace.trim() === '') {
            const choice = await this.ui.choose('Advanced runtime settings', settingsNamespacePickerItems(descriptors.map(descriptor => ({
                ns: String(descriptor.ns),
                applies: descriptor.applies,
                revision: descriptor.revision,
                secrets: descriptor.secrets,
            }))));
            if (choice === undefined)
                return;
            namespace = choice.value;
        }
        const descriptor = descriptors.find(candidate => String(candidate.ns) === namespace.trim());
        if (descriptor === undefined)
            throw new Error(`unknown settings namespace: ${namespace}`);
        const redacted = JSON.stringify(descriptor.value, null, 2) ?? 'undefined';
        this.ui.appendNotice([
            `Settings: ${descriptor.ns}`,
            `Applies: ${descriptor.applies}`,
            `Revision: ${descriptor.revision}`,
            descriptor.secrets?.length ? 'Secret fields are hidden and will not be changed by a patch.' : undefined,
            '',
            redacted,
        ].filter((line) => line !== undefined).join('\n'));
        const action = await this.ui.choose(`Edit ${descriptor.ns}`, [
            { value: 'patch', label: 'Apply JSON patch…', description: 'Merge fields into this namespace' },
            { value: 'reset', label: 'Reset overrides', description: 'Return every field to its composed/default value' },
            { value: 'cancel', label: 'Cancel' },
        ]);
        if (action === undefined || action.value === 'cancel')
            return;
        if (action.value === 'reset') {
            const confirmation = await this.ui.choose(`Reset all user overrides for ${descriptor.ns}?`, [
                { value: 'cancel', label: 'Cancel' },
                { value: 'confirm', label: 'Reset overrides', description: 'Re-inherit composition defaults' },
            ]);
            if (confirmation?.value !== 'confirm')
                return;
            await this.ctx.settings.replace(descriptor.ns, {}, descriptor.revision);
            this.ui.appendNotice(`Reset ${descriptor.ns}. ${descriptor.applies === 'restart' ? 'Restart the TUI to apply it.' : 'Applied live.'}`);
            return;
        }
        const text = await this.ui.promptText(`JSON object patch for ${descriptor.ns}:`);
        if (text === undefined)
            return;
        await this.ctx.settings.update(descriptor.ns, parseSettingsPatch(text), descriptor.revision);
        this.ui.appendNotice(`Updated ${descriptor.ns}. ${descriptor.applies === 'restart' ? 'Restart the TUI to apply it.' : 'Applied live.'}`);
    }
    settingsChoices() {
        const current = this.selection?.current;
        const defaults = this.ctx.agentDefaultModel.currentSelection();
        const permission = this.ctx.permissionPresets.current(this.agent.session.events);
        const values = {
            summary: 'view',
            model: current === undefined ? 'unavailable' : `${current.provider}/${current.model}`,
            reasoning: current?.reasoningEffort ?? 'model default',
            permission,
            busy: this.busyEnter,
            'transcript-density': this.transcriptDensity,
            'save-model-default': `${defaults.provider}/${defaults.model}`,
            'save-permission-default': this.ctx.permissionPresets.defaultPreset,
            providers: `${this.ctx.llm.listProviders().length} active`,
            runtime: 'read only',
            support: '/feedback',
            advanced: `${this.ctx.settings.describe({ redactSecrets: true }).length} namespaces`,
        };
        return SETTINGS_PICKER_ITEMS.map(item => ({
            id: item.value,
            label: item.label,
            description: item.description,
            currentValue: values[item.value] ?? '',
        }));
    }
    async chooseSettings(action = '') {
        if (action.trim() !== '') {
            await this.applySetting(action.trim());
            return;
        }
        let selectedId;
        while (!this.closing) {
            const choice = await this.ui.chooseSetting('Core settings', this.settingsChoices(), undefined, selectedId);
            if (choice === undefined)
                return;
            selectedId = choice;
            await this.applySetting(choice);
        }
    }
    async applySetting(action) {
        switch (action.trim()) {
            case 'summary':
                this.ui.appendNotice(this.settingsSummary());
                return;
            case 'model':
                await this.selectModel('');
                return;
            case 'reasoning':
                await this.selectReasoning('');
                return;
            case 'permission':
                await this.choosePermission();
                return;
            case 'busy':
                await this.selectBusyEnter('');
                return;
            case 'transcript-density':
                await this.selectTranscriptDensity();
                return;
            case 'providers':
                await this.showProviders();
                return;
            case 'runtime':
                this.showRuntime();
                return;
            case 'support':
                await this.showSupport();
                return;
            case 'advanced':
                await this.editAdvancedSettings();
                return;
            case 'save-model-default': {
                const current = this.selection?.current;
                if (current === undefined)
                    throw new Error('model selection is unavailable');
                await this.ctx.agentDefaultModel.saveSelection(current);
                this.ui.appendNotice(`Saved ${current.provider}/${current.model} as the default for future sessions.`);
                return;
            }
            case 'save-permission-default': {
                const current = this.ctx.permissionPresets.current(this.agent.session.events);
                if (current === 'custom')
                    throw new Error('custom permission state cannot be saved as a preset default');
                if (current === 'danger-full-access') {
                    const confirmed = await this.ui.choose('Save Full access as the default for future sessions?', [
                        { value: 'cancel', label: 'Cancel', description: 'Keep the safer existing default' },
                        { value: 'confirm', label: 'Save Full access', description: 'New sessions may run tools without approval' },
                    ]);
                    if (confirmed?.value !== 'confirm')
                        return;
                }
                await this.ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { defaultPreset: current });
                this.ui.appendNotice(`Saved ${current} as the permission default for future sessions.`);
                return;
            }
            default:
                await this.editAdvancedSettings(action);
                return;
        }
    }
    async selectTranscriptDensity() {
        const choice = await this.ui.choose('Transcript detail', [...TRANSCRIPT_DENSITY_PICKER_ITEMS], undefined, {
            initialValue: this.transcriptDensity,
        });
        if (choice === undefined)
            return;
        const density = choice.value;
        if (this.transcriptSettings === undefined) {
            this.localTranscriptDensity = density;
            this.ui.setTranscriptDensity(density);
        }
        else {
            await this.transcriptSettings.update({ transcriptDensity: density });
        }
        this.ui.appendNotice(`Transcript detail set to ${choice.label}.`);
    }
    async pauseAndExit() {
        if (this.handle === undefined)
            return;
        const id = sanitizeTerminalText(String(this.agent.id));
        this.agent.cancel({ kind: 'user' }, { keepInbox: true });
        await this.agent.whenIdle();
        await this.ctx.sessions.flush(this.agent.session);
        this.ui.stop();
        process.stdout.write(`Paused DeepSeek session ${id}\nResume with: deepseek --resume ${id}\n`);
        await this.shutdown(true, false);
    }
    async shutdown(requestExit, stopUi = true) {
        if (this.closing)
            return;
        this.closing = true;
        this.sessionLoadAbort?.abort(new Error('TUI shutting down'));
        this.activityLoadAbort?.abort(new Error('TUI shutting down'));
        try {
            await this.persistCurrentDraft();
            await this.draftStore.flush();
            if (stopUi && this.started)
                this.ui.stop();
            await this.detachCurrent();
        }
        finally {
            while (this.interactionDisposers.length > 0)
                this.interactionDisposers.pop()?.();
            if (requestExit)
                this.ctx.get('appExit')?.(0);
        }
    }
}
export function apply(ctx) {
    const startup = ctx.get('dshTuiStartup');
    if (startup === undefined)
        throw new Error('dsh-tui: missing startup options');
    const transcriptSettings = ctx.settings.register(TRANSCRIPT_SETTINGS_NAMESPACE, TRANSCRIPT_SETTINGS_SCHEMA, { applies: 'live' });
    const runner = new DshTuiRunner(ctx, startup, undefined, transcriptSettings);
    ctx.effect(() => {
        void runner.start().catch((error) => {
            runner.shutdown(false).catch(() => { });
            const message = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
            process.stderr.write(`dsh-tui: ${message}\n`);
            ctx.get('appExit')?.(1);
        });
        return () => runner.shutdown(false);
    }, 'dsh-tui-runner');
}
export { DeepSeekTui } from './ui.js';
export { projectSession } from './projection.js';
export { DEFAULT_TRANSCRIPT_DENSITY, TRANSCRIPT_DENSITIES, TRANSCRIPT_DENSITY_PICKER_ITEMS, TRANSCRIPT_SETTINGS_NAMESPACE, TRANSCRIPT_SETTINGS_SCHEMA, } from './transcript-settings.js';
