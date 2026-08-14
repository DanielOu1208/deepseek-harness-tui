import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { installModelSelection, } from '@deepseek-ai/dsh-agent';
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { PERMISSION_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-permission-presets';
import { SessionId } from '@deepseek-ai/dsh-session';
import { buildSlashCommands, formatCommandHelp, parseInput } from './commands.js';
import { BUSY_PICKER_ITEMS, GOAL_PICKER_ITEMS, OTHER_ANSWER_VALUE, PLAN_PICKER_ITEMS, SETTINGS_PICKER_ITEMS, filterPickerItems, modelPickerItems, parseModelRef, parseSettingsPatch, questionLabelsFromValues, questionPickerItems, reasoningInitialValue, reasoningPickerItems, sessionPickerItems, settingsNamespacePickerItems, } from './interaction.js';
import { createProjection, foldSessionEvent } from './projection.js';
import { DEFAULT_TRANSCRIPT_DENSITY, TRANSCRIPT_DENSITY_PICKER_ITEMS, TRANSCRIPT_SETTINGS_NAMESPACE, TRANSCRIPT_SETTINGS_SCHEMA, } from './transcript-settings.js';
import { DeepSeekTui, sanitizeTerminalText } from './ui.js';
export const name = 'dsh-tui-runner';
export const inject = [
    'dshTuiStartup',
    'agentDefaultModel',
    'agents',
    'sessions',
    'sessionPersistence',
    'commands',
    'permissionPresets',
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
export class DshTuiRunner {
    ctx;
    startup;
    ui;
    transcriptSettings;
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
    constructor(ctx, startup, ui = new DeepSeekTui(), transcriptSettings) {
        this.ctx = ctx;
        this.startup = startup;
        this.ui = ui;
        this.transcriptSettings = transcriptSettings;
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
        this.ui.appendLaunchBanner(String(this.agent.id), this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd()));
        this.ui.start({
            onPrompt: text => this.submit(text),
            onSettings: () => this.chooseSettings(),
            onInterrupt: () => this.interrupt(),
            onExit: () => this.shutdown(true),
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
    async open(resumeId) {
        const defaultSelection = this.ctx.agentDefaultModel.currentSelection();
        let selected = defaultSelection;
        if (resumeId !== undefined) {
            const inspected = await this.ctx.sessionPersistence.inspect(SessionId(resumeId));
            selected = modelFromEvents(inspected.events, defaultSelection);
        }
        const selection = { current: selected, assembled: undefined };
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
        this.handle = handle;
        this.selection = selection;
        this.bindAgent(handle.agent);
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
        }
        this.ui.renderProjection(state);
    }
    async submit(raw) {
        if (this.closing || raw.trim() === '')
            return;
        const input = parseInput(raw);
        if (input.kind === 'prompt') {
            if (this.agent.status === 'running') {
                if (this.busyEnter === 'steer') {
                    this.agent.steer(message(input.text));
                    this.ui.setStatus('steering queued for the next step');
                }
                else {
                    this.agent.followup(message(input.text));
                    this.ui.setStatus('follow-up queued after the active turn');
                }
            }
            else {
                this.agent.followup(message(input.text));
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
                await this.switchSession();
                return;
            case 'resume':
                if (input.argument === '')
                    await this.chooseSession();
                else
                    await this.switchSession(input.argument);
                return;
            case 'sessions':
                await this.showSessions();
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
                    throw new Error('usage: /queue <prompt>');
                this.agent.followup(message(input.argument));
                this.ui.setStatus('follow-up queued');
                return;
            case 'steer':
                if (input.argument === '')
                    throw new Error('usage: /steer <prompt>');
                this.agent.steer(message(input.argument));
                this.ui.setStatus('steering queued');
                return;
        }
    }
    async runHarnessCommand(line) {
        const abort = new AbortController();
        const execution = await this.ctx.commands.execute(this.agent, line, abort.signal);
        if (execution === undefined) {
            const available = this.ctx.commands.list(this.agent).map(command => `/${command.name}`).join(', ');
            this.ui.appendNotice(`Unknown Harness command: ${line}\nAvailable: ${available || 'none'}`);
            return;
        }
        this.refresh();
    }
    interrupt() {
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
    async switchSession(resumeId) {
        this.ui.setStatus(resumeId ? `opening ${resumeId}…` : 'creating a new session…');
        await this.detachCurrent();
        await this.open(resumeId);
        this.ui.appendLaunchBanner(String(this.agent.id), this.agent.session.header.cwd ?? resolve(this.startup.cwd ?? process.cwd()));
        this.ui.appendNotice(resumeId ? `Resumed ${resumeId}` : `New session ${this.agent.id}`);
        this.refresh();
    }
    async detachCurrent() {
        if (this.handle === undefined)
            return;
        this.agent.cancel({ kind: 'user' }, { keepInbox: true });
        await this.agent.whenIdle();
        await this.ctx.sessions.flush(this.agent.session);
        while (this.subscriptions.length > 0)
            this.subscriptions.pop()?.();
        const handle = this.handle;
        this.handle = undefined;
        this.selection = undefined;
        this.projection = undefined;
        this.projectionCursor = 0;
        await handle.dispose();
    }
    async showSessions() {
        const sessions = await this.ctx.sessionPersistence.list();
        sessions.sort((left, right) => right.createdAt - left.createdAt);
        const lines = sessions.slice(0, 30).map(header => `- ${header.id} · ${new Date(header.createdAt).toLocaleString()}${header.cwd ? ` · ${header.cwd}` : ''}`);
        this.ui.appendNotice(`Persisted sessions (${sessions.length})\n${lines.join('\n') || 'None yet.'}`);
    }
    async chooseSession() {
        const items = await this.loadSessionPickerItems();
        if (items.length === 0) {
            this.ui.appendNotice('No other persisted sessions are available.');
            return;
        }
        const choice = await this.ui.choose('Resume a persisted session', items);
        if (choice !== undefined)
            await this.switchSession(choice.value);
    }
    async loadSessionPickerItems() {
        const sessions = await this.ctx.sessionPersistence.list();
        return sessionPickerItems(sessions.map(header => ({
            id: String(header.id),
            cwd: header.cwd,
            createdAt: header.createdAt,
        }))).filter(item => item.value !== String(this.agent.id)).slice(0, 30);
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
        try {
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
