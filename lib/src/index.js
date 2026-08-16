import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { installModelSelection, } from '@deepseek-ai/dsh-agent';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { buildSlashCommands, formatCommandHelp, parseInput } from './commands.js';
import { createSessionDraftStore } from './drafts.js';
import { GOAL_PICKER_ITEMS, PLAN_PICKER_ITEMS, filterPickerItems, stepReasoningEffort, } from './interaction.js';
import { PromptController } from './prompt-controller.js';
import { createProjection, foldSessionEvent, projectSession } from './projection.js';
import { QueueController } from './queue-controller.js';
import { SessionInsightsController } from './session-insights.js';
import { forkSeedEvents, modelSelectionFromEvents } from './session-lifecycle.js';
import { SessionNavigator } from './session-navigator.js';
import { SettingsController } from './settings-controller.js';
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
export class DshTuiRunner {
    ctx;
    startup;
    ui;
    transcriptSettings;
    handle;
    selection;
    subscriptions = [];
    projection;
    projectionCursor = 0;
    closing = false;
    started = false;
    startPromise;
    shutdownPromise;
    startupAbort = new AbortController();
    sessionTransitionAbort;
    sessionTransitionPromise;
    commandAbort;
    commandPromise;
    selectedContextWindow;
    shortcutQueue = Promise.resolve();
    actionQueue = Promise.resolve();
    sessionGeneration = 0;
    sessionInsights;
    sessionNavigator;
    queueController;
    settingsController;
    promptController;
    constructor(ctx, startup, ui = new DeepSeekTui(), transcriptSettings, draftStore = createSessionDraftStore(join(resolveDshHome(), 'tui', 'drafts', 'v1')), promptController) {
        this.ctx = ctx;
        this.startup = startup;
        this.ui = ui;
        this.transcriptSettings = transcriptSettings;
        this.promptController = promptController ?? new PromptController({
            ctx: this.ctx,
            ui: this.ui,
            draftStore,
            startupCwd: this.startup.cwd,
            getAgent: () => this.handle?.agent,
            getSelection: () => this.selection,
            isClosing: () => this.closing,
        });
        this.sessionInsights = new SessionInsightsController({
            ctx: this.ctx,
            ui: this.ui,
            startupCwd: this.startup.cwd,
            getCurrentSession: () => ({ agent: this.agent, generation: this.sessionGeneration }),
        });
        this.sessionNavigator = new SessionNavigator({
            ctx: this.ctx,
            ui: this.ui,
            getAgent: () => this.agent,
            requestSwitch: id => this.requestSessionSwitch(id),
        });
        this.queueController = new QueueController({
            ui: this.ui,
            getAgent: () => this.agent,
            isClosing: () => this.closing,
        });
        this.settingsController = new SettingsController({
            ctx: this.ctx,
            ui: this.ui,
            transcriptSettings: this.transcriptSettings,
            startupCwd: this.startup.cwd,
            getAgent: () => this.agent,
            getSelection: () => this.selection,
            setSelectedContextWindow: value => { this.selectedContextWindow = value; },
            runHarnessCommand: line => this.runHarnessCommand(line),
            refresh: () => this.refresh(),
            isClosing: () => this.closing,
            hasPendingImages: () => this.promptController.hasPendingImages(),
        });
    }
    get transcriptDensity() {
        return this.settingsController.transcriptDensity;
    }
    get agent() {
        if (this.handle === undefined)
            throw new Error('no active DeepSeek session');
        return this.handle.agent;
    }
    start() {
        this.startPromise ??= this.startInternal().catch((error) => {
            if (this.closing && this.startupAbort.signal.aborted)
                return;
            throw error;
        });
        return this.startPromise;
    }
    async startInternal() {
        await this.ctx.get('loader')?.await();
        this.startupAbort.signal.throwIfAborted();
        this.promptController.installInteractions();
        await this.open(this.startup.resume, undefined, this.startupAbort.signal);
        this.startupAbort.signal.throwIfAborted();
        await this.promptController.restoreCurrentDraft();
        this.startupAbort.signal.throwIfAborted();
        this.ui.appendLaunchBanner(String(this.agent.id), this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd()));
        this.ui.start({
            onPrompt: text => this.submit(text),
            onDraftChange: text => this.promptController.scheduleDraftSave(text),
            onPasteImage: () => this.enqueueAction(() => this.promptController.pasteClipboardImage()),
            onSettings: () => this.enqueueAction(() => this.settingsController.chooseSettings()),
            onTogglePlanMode: () => this.enqueueAction(() => this.enqueueShortcut(() => this.togglePlanMode())),
            onReasoningStep: direction => this.enqueueAction(() => this.enqueueShortcut(() => this.stepReasoning(direction))),
            onInterrupt: () => this.interrupt(),
            onExit: () => this.enqueueAction(() => this.shutdownFromAction(true)),
        });
        this.started = true;
        this.refresh();
        if (this.startup.prompt !== undefined)
            await this.submit(this.startup.prompt);
    }
    async prepareSession(resumeId, fallbackSelection, signal, resolvedSelection) {
        const defaultSelection = fallbackSelection ?? this.ctx.agentDefaultModel.currentSelection();
        const selected = resolvedSelection ?? await this.resolveSessionSelection(resumeId, defaultSelection, signal);
        const selection = { current: selected, assembled: undefined };
        const contextWindow = await this.resolveContextWindow(selected, signal);
        signal?.throwIfAborted();
        const setup = (agentCtx) => { installModelSelection(agentCtx, selection); };
        const handle = resumeId === undefined
            ? await this.ctx.agents.create({
                sessionId: SessionId(`session-${randomUUID()}`),
                meta: { cwd: resolve(this.startup.cwd ?? process.cwd()) },
                agentOptions: { provider: selected.provider, model: selected.model },
                setup,
                signal,
            })
            : await this.ctx.agents.resume({
                resumeSessionId: SessionId(resumeId),
                agentOptions: { provider: selected.provider, model: selected.model },
                setup,
                signal,
            });
        if (signal?.aborted) {
            await handle.dispose();
            signal.throwIfAborted();
        }
        return { handle, selection, contextWindow };
    }
    async resolveSessionSelection(resumeId, fallback, signal) {
        if (resumeId === undefined)
            return fallback;
        const inspected = await this.ctx.sessionPersistence.inspect(SessionId(resumeId), signal);
        signal?.throwIfAborted();
        return modelSelectionFromEvents(inspected.events, fallback);
    }
    activateSession(prepared) {
        this.handle = prepared.handle;
        this.selection = prepared.selection;
        this.selectedContextWindow = prepared.contextWindow;
        this.bindAgent(prepared.handle.agent);
    }
    async open(resumeId, fallbackSelection, signal, resolvedSelection) {
        this.activateSession(await this.prepareSession(resumeId, fallbackSelection, signal, resolvedSelection));
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
                    command.getArgumentCompletions = async (prefix) => this.settingsController.modelCompletions(prefix);
                    break;
                case 'resume':
                    command.getArgumentCompletions = async (prefix) => filterPickerItems(await this.sessionNavigator.loadPickerItems(), prefix);
                    break;
                case 'session':
                    command.getArgumentCompletions = async (prefix) => filterPickerItems(await this.sessionNavigator.loadPickerItems(), prefix);
                    break;
                case 'sessions':
                    command.getArgumentCompletions = prefix => filterPickerItems([
                        { value: 'archived', label: 'archived', description: 'Browse one-way archived sessions' },
                    ], prefix);
                    break;
                case 'permission':
                    command.getArgumentCompletions = prefix => filterPickerItems(this.settingsController.permissionPickerItems(), prefix);
                    break;
                case 'reasoning':
                    command.getArgumentCompletions = async (prefix) => filterPickerItems(await this.settingsController.loadReasoningPickerItems(), prefix);
                    break;
                case 'busy':
                    command.getArgumentCompletions = prefix => this.settingsController.busyCompletions(prefix);
                    break;
                case 'settings':
                    command.getArgumentCompletions = prefix => this.settingsController.settingCompletions(prefix);
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
    async resolveContextWindow(selection, signal) {
        try {
            const info = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model, signal);
            const contextWindow = info.context?.contextWindow;
            return typeof contextWindow === 'number' && Number.isInteger(contextWindow) && contextWindow > 0
                ? contextWindow
                : undefined;
        }
        catch {
            signal?.throwIfAborted();
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
        const run = async () => {
            if (!this.closing)
                await action();
        };
        const queued = this.actionQueue.then(run, run);
        this.actionQueue = queued.catch(() => { });
        return queued;
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
    localCommandHandlers() {
        return {
            help: async () => this.ui.appendNotice(formatCommandHelp(buildSlashCommands(this.ctx.commands.list(this.agent)))),
            stop: async () => this.interrupt(),
            pause: async () => this.pauseAndExit(),
            exit: async () => this.shutdownFromAction(true),
            new: async () => this.requestSessionSwitch(),
            resume: async (argument) => {
                if (argument === '')
                    await this.sessionNavigator.chooseSession();
                else
                    await this.requestSessionSwitch(argument);
            },
            sessions: async (argument) => {
                if (argument !== '' && argument !== 'archived')
                    throw new Error('usage: /sessions [archived]');
                await this.sessionNavigator.chooseSession(argument === 'archived');
            },
            session: async (argument) => {
                if (argument !== '' && argument !== String(this.agent.id)) {
                    await this.requestSessionSwitch(argument);
                    if (String(this.agent.id) !== argument)
                        return;
                }
                await this.chooseSessionAction();
            },
            workspaces: async (argument) => {
                if (argument !== '')
                    throw new Error('usage: /workspaces');
                await this.sessionNavigator.chooseWorkspace();
            },
            models: async () => this.settingsController.showModels(),
            model: async (argument) => this.settingsController.selectModel(argument),
            reasoning: async (argument) => this.settingsController.selectReasoning(argument),
            permission: async (argument) => {
                if (argument === '')
                    await this.settingsController.choosePermission();
                else
                    await this.runHarnessCommand(`/permission ${argument}`);
            },
            busy: async (argument) => this.settingsController.selectBusyEnter(argument),
            settings: async (argument) => this.settingsController.chooseSettings(argument),
            queue: async (argument) => {
                if (argument === '')
                    await this.queueController.choose();
                else {
                    this.agent.followup(message(argument));
                    this.ui.setStatus('follow-up queued');
                }
            },
            steer: async (argument) => {
                if (argument === '')
                    throw new Error('usage: /steer <prompt>');
                this.agent.steer(message(argument));
                this.ui.setStatus('steering queued');
            },
            attach: async (argument) => this.promptController.chooseAttachments(argument),
            deliverables: async () => this.sessionInsights.chooseDeliverable(),
            inspect: async () => this.sessionInsights.chooseInspectorEntry(),
            stats: async () => this.sessionInsights.showSessionStats(),
            activity: async () => this.sessionInsights.showActivity(),
            export: async (argument) => this.sessionInsights.exportSession(argument),
        };
    }
    async processSubmission(raw) {
        if (this.closing || raw.trim() === '')
            return;
        const input = parseInput(raw);
        if (input.kind === 'prompt') {
            const sessionId = await this.promptController.beginPrompt(input.text);
            try {
                const outgoing = await this.promptController.promptMessage(input.text);
                if (this.agent.status === 'running') {
                    if (this.settingsController.busyEnter === 'steer') {
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
                await this.promptController.completePrompt(sessionId);
            }
            catch (error) {
                await this.promptController.recoverPrompt(sessionId, input.text);
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
        await this.localCommandHandlers()[input.name](input.argument);
    }
    async runHarnessCommand(line, agent = this.agent, generation = this.sessionGeneration) {
        if (this.commandAbort !== undefined)
            throw new Error('another Harness command is already running');
        const abort = new AbortController();
        this.commandAbort = abort;
        const executionPromise = this.ctx.commands.execute(agent, line, abort.signal);
        const settled = executionPromise.then(() => { }, () => { });
        this.commandPromise = settled;
        try {
            const execution = await executionPromise;
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
        catch (error) {
            if (!abort.signal.aborted)
                throw error;
        }
        finally {
            if (this.commandAbort === abort)
                this.commandAbort = undefined;
            if (this.commandPromise === settled)
                this.commandPromise = undefined;
        }
    }
    interrupt() {
        this.sessionNavigator.interrupt();
        this.sessionTransitionAbort?.abort(new Error('session change cancelled'));
        this.commandAbort?.abort(new Error('Harness command cancelled'));
        this.sessionInsights.interrupt();
        if (this.handle === undefined)
            return;
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
    async withSessionTransition(operation) {
        if (this.closing)
            throw new Error('the TUI is shutting down');
        if (this.sessionTransitionAbort !== undefined)
            throw new Error('another session change is already in progress');
        const abort = new AbortController();
        this.sessionTransitionAbort = abort;
        const transition = (async () => {
            try {
                await operation(abort.signal);
            }
            catch (error) {
                if (abort.signal.aborted && this.handle !== undefined) {
                    this.ui.setStatus('session change cancelled');
                    return;
                }
                throw error;
            }
            finally {
                if (this.sessionTransitionAbort === abort)
                    this.sessionTransitionAbort = undefined;
            }
        })();
        this.sessionTransitionPromise = transition;
        try {
            await transition;
        }
        finally {
            if (this.sessionTransitionPromise === transition)
                this.sessionTransitionPromise = undefined;
        }
    }
    async withComposerLock(operation) {
        this.ui.setComposerLocked(true);
        try {
            await operation();
        }
        finally {
            this.ui.setComposerLocked(false);
        }
    }
    async requestSessionSwitch(resumeId) {
        await this.withSessionTransition(signal => this.requestSessionSwitchInner(resumeId, signal));
    }
    async requestSessionSwitchInner(resumeId, signal) {
        if (resumeId !== undefined && resumeId === String(this.agent.id))
            return;
        if (this.blockSessionChangeForPending())
            return;
        // Resolve a direct target before the current agent is stopped. The resolved
        // route is reused during open so there is no second, uninterruptible scan.
        const fallback = this.ctx.agentDefaultModel.currentSelection();
        const targetSelection = await this.resolveSessionSelection(resumeId, fallback, signal);
        if (this.agent.status === 'running') {
            const target = resumeId === undefined ? 'create a new session' : 'open the selected session';
            const choice = await this.ui.choose(`The current turn is still running. Stop it and ${target}?`, [
                { value: 'stay', label: 'Stay here', description: 'Keep the current turn running' },
                { value: 'switch', label: 'Stop and switch', description: 'Stop this turn, save it, and change sessions' },
            ], signal, { initialValue: 'stay' });
            if (choice?.value !== 'switch')
                return;
        }
        // A message may have been queued while the confirmation was open.
        if (this.blockSessionChangeForPending())
            return;
        if (!await this.promptController.confirmDiscardPendingImages())
            return;
        await this.switchSession(resumeId, signal, targetSelection);
    }
    async restoreAfterFailedSessionChange(previousId, previousSelection) {
        if (this.closing)
            throw new Error('cannot restore a session while the TUI is shutting down');
        try {
            await this.open(previousId, previousSelection, undefined, previousSelection);
            if (this.closing)
                throw new Error('session restoration was interrupted by shutdown');
            this.ui.appendNotice(`Session change failed; restored ${previousId}`);
        }
        catch (error) {
            if (this.closing)
                throw error;
            await this.open(undefined, previousSelection, undefined, previousSelection);
            if (this.closing)
                throw new Error('fallback session creation was interrupted by shutdown');
            this.promptController.clearPendingImages();
            this.ui.appendNotice('Session change failed; opened a fresh session because the previous session could not be restored.');
        }
        await this.promptController.restoreCurrentDraft();
        this.refresh();
    }
    async switchSession(resumeId, signal, targetSelection) {
        if (signal === undefined) {
            await this.withSessionTransition(async (transitionSignal) => {
                const fallback = this.selection?.current ?? this.ctx.agentDefaultModel.currentSelection();
                const selected = await this.resolveSessionSelection(resumeId, fallback, transitionSignal);
                await this.switchSession(resumeId, transitionSignal, selected);
            });
            return;
        }
        await this.withComposerLock(async () => {
            this.ui.setStatus(resumeId ? `opening ${resumeId}…` : 'creating a new session…');
            const previousId = String(this.agent.id);
            const previousSelection = this.selection?.current;
            await this.promptController.persistCurrentDraft();
            signal.throwIfAborted();
            await this.detachCurrent();
            try {
                await this.open(resumeId, targetSelection, signal, targetSelection);
                signal.throwIfAborted();
            }
            catch (error) {
                if (!this.closing)
                    await this.restoreAfterFailedSessionChange(previousId, previousSelection);
                throw error;
            }
            this.promptController.clearPendingImages();
            this.ui.appendLaunchBanner(String(this.agent.id), this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd()));
            await this.promptController.restoreCurrentDraft();
            this.ui.appendNotice(resumeId ? `Resumed ${resumeId}` : `New session ${this.agent.id}`);
            this.refresh();
        });
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
            this.sessionNavigator.invalidate(String(this.agent.id));
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
        if (!await this.promptController.confirmDiscardPendingImages())
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
        await this.withSessionTransition(signal => this.forkCurrentSession(Number(choice.value), signal));
    }
    async forkCurrentSession(boundary, signal) {
        if (signal === undefined) {
            await this.withSessionTransition(transitionSignal => this.forkCurrentSession(boundary, transitionSignal));
            return;
        }
        await this.withComposerLock(async () => {
            const source = this.agent.session;
            const previousId = String(source.id);
            const previousSelection = this.selection?.current;
            if (previousSelection === undefined)
                throw new Error('model selection is unavailable');
            const seed = forkSeedEvents(source.events, boundary);
            const childId = SessionId(`session-${randomUUID()}`);
            const selection = { current: { ...previousSelection }, assembled: undefined };
            await this.promptController.persistCurrentDraft();
            signal.throwIfAborted();
            await this.detachCurrent();
            try {
                const contextWindow = await this.resolveContextWindow(previousSelection, signal);
                signal.throwIfAborted();
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
                    signal,
                });
                if (signal.aborted) {
                    await handle.dispose();
                    signal.throwIfAborted();
                }
                this.activateSession({ handle, selection, contextWindow });
                await this.attachCurrentWorkspace();
                signal.throwIfAborted();
                this.promptController.clearPendingImages();
            }
            catch (error) {
                if (!this.closing)
                    await this.restoreAfterFailedSessionChange(previousId, previousSelection);
                throw error;
            }
            this.ui.appendLaunchBanner(String(this.agent.id), this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd()));
            await this.promptController.restoreCurrentDraft();
            this.ui.appendNotice(`Forked ${previousId} into ${this.agent.id} at ${boundary < 0 ? 'an empty history' : `seq ${boundary}`}.`);
            this.refresh();
        });
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
        this.sessionNavigator.invalidate(archivedId);
        this.ui.appendNotice(`Archived ${archivedId}. Its durable session log was preserved.`);
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
    async pauseAndExit() {
        if (this.handle === undefined)
            return;
        const id = sanitizeTerminalText(String(this.agent.id));
        this.agent.cancel({ kind: 'user' }, { keepInbox: true });
        await this.agent.whenIdle();
        await this.ctx.sessions.flush(this.agent.session);
        this.ui.stop();
        process.stdout.write(`Paused DeepSeek session ${id}\nResume with: deepseek --resume ${id}\n`);
        await this.shutdownFromAction(true, false);
    }
    shutdown(requestExit, stopUi = true) {
        return this.beginShutdown(requestExit, stopUi, this.actionQueue);
    }
    shutdownFromAction(requestExit, stopUi = true) {
        if (this.shutdownPromise !== undefined)
            return Promise.resolve();
        return this.beginShutdown(requestExit, stopUi);
    }
    beginShutdown(requestExit, stopUi, inFlightActions) {
        if (this.shutdownPromise !== undefined)
            return this.shutdownPromise;
        this.closing = true;
        this.startupAbort.abort(new Error('TUI shutting down'));
        this.sessionNavigator.interrupt(new Error('TUI shutting down'));
        this.sessionTransitionAbort?.abort(new Error('TUI shutting down'));
        this.commandAbort?.abort(new Error('TUI shutting down'));
        this.sessionInsights.shutdown();
        const inFlightStartup = this.started ? undefined : this.startPromise;
        const inFlightTransition = this.sessionTransitionPromise;
        const inFlightCommand = this.commandPromise;
        this.shutdownPromise = (async () => {
            try {
                if (stopUi && this.started)
                    this.ui.stop();
                await inFlightStartup?.catch(() => { });
                await inFlightActions;
                await inFlightTransition?.catch(() => { });
                await inFlightCommand;
                this.settingsController.dispose();
                await this.promptController.persistCurrentDraft();
                await this.promptController.flushDrafts();
                await this.detachCurrent();
            }
            finally {
                this.promptController.disposeInteractions();
                if (requestExit)
                    this.ctx.get('appExit')?.(0);
            }
        })();
        return this.shutdownPromise;
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
