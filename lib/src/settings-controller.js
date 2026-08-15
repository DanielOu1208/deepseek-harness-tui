import { join, resolve } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { PERMISSION_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-permission-presets';
import { BUSY_PICKER_ITEMS, filterPickerItems, modelPickerItems, parseModelRef, parseSettingsPatch, reasoningInitialValue, reasoningPickerItems, settingsNamespacePickerItems, } from './interaction.js';
import { DEFAULT_TRANSCRIPT_DENSITY, TRANSCRIPT_DENSITY_PICKER_ITEMS, } from './transcript-settings.js';
const SETTING_DEFINITIONS = [
    { id: 'summary', label: 'Current settings', description: 'Show active session and default values', currentValue: () => 'view', apply: controller => controller.showSummary() },
    { id: 'transcript-density', label: 'Transcript detail', description: 'Choose how much transcript detail to show', currentValue: controller => controller.transcriptDensity, apply: controller => controller.selectTranscriptDensity() },
    { id: 'model', label: 'Model', description: 'Switch provider and model', currentValue: controller => controller.currentModelLabel(), apply: controller => controller.selectModel('') },
    { id: 'reasoning', label: 'Reasoning effort', description: 'Select effort for the current model', currentValue: controller => controller.currentReasoningLabel(), apply: controller => controller.selectReasoning('') },
    { id: 'permission', label: 'Permission', description: 'Set this session’s tool-access preset', currentValue: controller => controller.currentPermission(), apply: controller => controller.choosePermission() },
    { id: 'busy', label: 'Busy Enter', description: 'Choose queue or steer while running', currentValue: controller => controller.busyEnter, apply: controller => controller.selectBusyEnter('') },
    { id: 'save-model-default', label: 'Save model as default', description: 'Use this model and effort for future sessions', currentValue: controller => controller.defaultModelLabel(), apply: controller => controller.saveModelDefault() },
    { id: 'save-permission-default', label: 'Save permission as default', description: 'Use this permission preset for future sessions', currentValue: controller => controller.deps.ctx.permissionPresets.defaultPreset, apply: controller => controller.savePermissionDefault() },
    { id: 'providers', label: 'Providers', description: 'Inspect configured routes, models, and input capabilities', currentValue: controller => `${controller.deps.ctx.llm.listProviders().length} active`, apply: controller => controller.showProviders() },
    { id: 'runtime', label: 'Runtime', description: 'Inspect mounted Host plugins and configuration paths', currentValue: () => 'read only', apply: controller => controller.showRuntime() },
    { id: 'support', label: 'Support and feedback', description: 'Review disclosure and send Harness feedback', currentValue: () => '/feedback', apply: controller => controller.showSupport() },
    { id: 'advanced', label: 'Advanced runtime settings', description: 'Browse and patch registered Harness settings namespaces', currentValue: controller => `${controller.settingsNamespaceCount()} namespaces`, apply: controller => controller.editAdvancedSettings() },
];
export const SETTINGS_PICKER_ITEMS = SETTING_DEFINITIONS.map(({ id, label, description }) => ({ value: id, label, description }));
function messageContainsImage(message) {
    return message.content.some(block => block.type === 'image');
}
export function assertModelSupportsSessionImages(agent, info, hasPendingImages = false) {
    if (info.inputModalities === undefined || info.inputModalities.includes('image'))
        return;
    const messages = [
        ...agent.session.deriveMessages(),
        ...agent.inbox.nextStep,
        ...agent.inbox.nextTurn,
    ];
    if (hasPendingImages || messages.some(messageContainsImage)) {
        throw new Error(`${info.provider}/${info.id} does not accept images, but this session contains image input`);
    }
}
export class SettingsController {
    deps;
    localTranscriptDensity = DEFAULT_TRANSCRIPT_DENSITY;
    disposers = [];
    busyEnter = 'queue';
    constructor(deps) {
        this.deps = deps;
        if (deps.transcriptSettings !== undefined) {
            deps.ui.setTranscriptDensity(deps.transcriptSettings.get().transcriptDensity);
            this.disposers.push(deps.transcriptSettings.watch(next => {
                deps.ui.setTranscriptDensity(next.transcriptDensity);
            }));
        }
    }
    dispose() {
        while (this.disposers.length > 0)
            this.disposers.pop()?.();
    }
    get transcriptDensity() {
        return this.deps.transcriptSettings?.get().transcriptDensity ?? this.localTranscriptDensity;
    }
    settingPickerItems() {
        return [...SETTINGS_PICKER_ITEMS];
    }
    settingCompletions(prefix) {
        return filterPickerItems([...this.settingPickerItems(), ...this.loadSettingsNamespacePickerItems()], prefix);
    }
    async modelCompletions(prefix) {
        return filterPickerItems(modelPickerItems(await this.loadModels()), prefix);
    }
    busyCompletions(prefix) {
        return filterPickerItems(BUSY_PICKER_ITEMS, prefix);
    }
    permissionPickerItems() {
        const current = this.currentPermission();
        return this.deps.ctx.permissionPresets.names.map(name => {
            const option = this.deps.ctx.permissionPresets.optionOf(name);
            return {
                value: option.value,
                label: option.name,
                description: `${name === current ? 'Current · ' : ''}${option.description ?? name}`,
            };
        });
    }
    async choosePermission() {
        const choice = await this.deps.ui.choose('Choose a permission mode', this.permissionPickerItems(), undefined, {
            initialValue: this.currentPermission(),
        });
        if (choice !== undefined)
            await this.deps.runHarnessCommand(`/permission ${choice.value}`);
    }
    async loadModels() {
        const available = [];
        for (const provider of this.deps.ctx.llm.listProviders()) {
            try {
                const models = await this.deps.ctx.llm.listModels(provider.id);
                for (const model of models)
                    available.push({ provider: provider.id, model: model.id, name: model.name });
            }
            catch {
                // A provider that cannot enumerate models stays out of the picker.
            }
        }
        return available;
    }
    async showModels() {
        const lines = [];
        for (const provider of this.deps.ctx.llm.listProviders()) {
            try {
                const models = await this.deps.ctx.llm.listModels(provider.id);
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
        this.deps.ui.appendNotice(`Available models\n${lines.join('\n') || 'No active providers.'}`);
    }
    async selectModel(value) {
        const interactive = value.trim() === '';
        if (interactive) {
            const items = modelPickerItems(await this.loadModels());
            if (items.length === 0) {
                this.deps.ui.appendNotice('No models are currently available.');
                return;
            }
            const current = this.deps.getSelection()?.current;
            const choice = await this.deps.ui.choose('Choose a model', items, undefined, {
                initialValue: current === undefined ? undefined : `${current.provider}/${current.model}`,
            });
            if (choice === undefined)
                return;
            value = choice.value;
        }
        const ref = parseModelRef(value);
        if (ref === undefined)
            throw new Error('usage: /model <provider>/<model>');
        const info = await this.deps.ctx.llm.resolveModelInfo(ref.provider, ref.model);
        const selection = this.deps.getSelection();
        if (selection === undefined)
            throw new Error('model selection is unavailable');
        let next = ref;
        if (interactive && info.reasoning !== undefined) {
            const reasoning = await this.deps.ui.choose('Choose reasoning effort', reasoningPickerItems(info.reasoning), undefined, { initialValue: reasoningInitialValue(selection.current, ref) });
            if (reasoning === undefined)
                return;
            next = {
                ...ref,
                ...(reasoning.value === 'default' ? {} : { reasoningEffort: ReasoningEffortId(reasoning.value) }),
            };
        }
        assertModelSupportsSessionImages(this.deps.getAgent(), info, this.deps.hasPendingImages());
        selection.current = next;
        this.deps.setSelectedContextWindow(info.context?.contextWindow);
        this.deps.ui.appendNotice(`Next request will use ${ref.provider}/${ref.model} · reasoning ${next.reasoningEffort ?? 'model default'}`);
        this.deps.refresh();
    }
    async loadReasoningPickerItems() {
        const selection = this.deps.getSelection()?.current;
        if (selection === undefined)
            return [];
        const info = await this.deps.ctx.llm.resolveModelInfo(selection.provider, selection.model);
        return info.reasoning === undefined ? [] : reasoningPickerItems(info.reasoning);
    }
    async selectReasoning(value) {
        if (value.trim() === '') {
            const items = await this.loadReasoningPickerItems();
            if (items.length === 0) {
                this.deps.ui.appendNotice('The current model does not expose configurable reasoning effort.');
                return;
            }
            const choice = await this.deps.ui.choose('Choose reasoning effort', items, undefined, {
                initialValue: this.deps.getSelection()?.current?.reasoningEffort ?? 'default',
            });
            if (choice !== undefined)
                await this.selectReasoning(choice.value);
            return;
        }
        const selection = this.deps.getSelection()?.current;
        if (selection === undefined)
            throw new Error('model selection is unavailable');
        const info = await this.deps.ctx.llm.resolveModelInfo(selection.provider, selection.model);
        if (info.reasoning === undefined)
            throw new Error('current model does not support reasoning effort selection');
        const normalized = value.trim();
        if (normalized !== 'default' && !info.reasoning.efforts.some(effort => effort.id === normalized)) {
            throw new Error(`unknown reasoning effort: ${normalized}`);
        }
        this.deps.getSelection().current = {
            provider: selection.provider,
            model: selection.model,
            ...(normalized === 'default' ? {} : { reasoningEffort: ReasoningEffortId(normalized) }),
        };
        this.deps.ui.appendNotice(normalized === 'default'
            ? 'Reasoning effort reset to the model default.'
            : `Reasoning effort set to ${normalized}.`);
        this.deps.refresh();
    }
    async selectBusyEnter(value) {
        if (value.trim() === '') {
            const choice = await this.deps.ui.choose('Plain Enter while the agent is busy', [...BUSY_PICKER_ITEMS], undefined, {
                initialValue: this.busyEnter,
            });
            if (choice === undefined)
                return;
            value = choice.value;
        }
        if (value !== 'queue' && value !== 'steer')
            throw new Error('usage: /busy <queue|steer>');
        this.busyEnter = value;
        this.deps.ui.appendNotice(`Busy Enter now ${value === 'queue' ? 'queues a follow-up' : 'steers the active turn'}.`);
    }
    async chooseSettings(action = '') {
        if (action.trim() !== '') {
            await this.applySetting(action.trim());
            return;
        }
        let selectedId;
        while (!this.deps.isClosing()) {
            const choice = await this.deps.ui.chooseSetting('Core settings', this.settingsChoices(), undefined, selectedId);
            if (choice === undefined)
                return;
            selectedId = choice;
            await this.applySetting(choice);
        }
    }
    async selectTranscriptDensity() {
        const choice = await this.deps.ui.choose('Transcript detail', [...TRANSCRIPT_DENSITY_PICKER_ITEMS], undefined, {
            initialValue: this.transcriptDensity,
        });
        if (choice === undefined)
            return;
        const density = choice.value;
        if (this.deps.transcriptSettings === undefined) {
            this.localTranscriptDensity = density;
            this.deps.ui.setTranscriptDensity(density);
        }
        else {
            await this.deps.transcriptSettings.update({ transcriptDensity: density });
        }
        this.deps.ui.appendNotice(`Transcript detail set to ${choice.label}.`);
    }
    settingsChoices() {
        return SETTING_DEFINITIONS.map(definition => ({
            id: definition.id,
            label: definition.label,
            description: definition.description,
            currentValue: definition.currentValue(this),
        }));
    }
    async applySetting(action) {
        const definition = SETTING_DEFINITIONS.find(candidate => candidate.id === action.trim());
        if (definition !== undefined) {
            await definition.apply(this);
            return;
        }
        await this.editAdvancedSettings(action);
    }
    currentModelLabel() {
        const current = this.deps.getSelection()?.current;
        return current === undefined ? 'unavailable' : `${current.provider}/${current.model}`;
    }
    currentReasoningLabel() {
        return this.deps.getSelection()?.current?.reasoningEffort ?? 'model default';
    }
    currentPermission() {
        return this.deps.ctx.permissionPresets.current(this.deps.getAgent().session.events);
    }
    defaultModelLabel() {
        const defaults = this.deps.ctx.agentDefaultModel.currentSelection();
        return `${defaults.provider}/${defaults.model}`;
    }
    showSummary() {
        const defaults = this.deps.ctx.agentDefaultModel.currentSelection();
        const agent = this.deps.getAgent();
        this.deps.ui.appendNotice([
            'Core TUI settings',
            `- Current model: ${this.currentModelLabel()}`,
            `- Current reasoning: ${this.currentReasoningLabel()}`,
            `- Current permission: ${this.currentPermission()}`,
            `- Busy Enter: ${this.busyEnter}`,
            `- Transcript detail: ${this.transcriptDensity}`,
            `- New-session model: ${defaults.provider}/${defaults.model}`,
            `- New-session reasoning: ${defaults.reasoningEffort ?? 'model default'}`,
            `- New-session permission: ${this.deps.ctx.permissionPresets.defaultPreset}`,
            `- Working directory: ${agent.session.header.cwd ?? resolve(this.deps.startupCwd ?? process.cwd())}`,
        ].join('\n'));
    }
    async saveModelDefault() {
        const current = this.deps.getSelection()?.current;
        if (current === undefined)
            throw new Error('model selection is unavailable');
        await this.deps.ctx.agentDefaultModel.saveSelection(current);
        this.deps.ui.appendNotice(`Saved ${current.provider}/${current.model} as the default for future sessions.`);
    }
    async savePermissionDefault() {
        const current = this.currentPermission();
        if (current === 'custom')
            throw new Error('custom permission state cannot be saved as a preset default');
        if (current === 'danger-full-access') {
            const confirmed = await this.deps.ui.choose('Save Full access as the default for future sessions?', [
                { value: 'cancel', label: 'Cancel', description: 'Keep the safer existing default' },
                { value: 'confirm', label: 'Save Full access', description: 'New sessions may run tools without approval' },
            ]);
            if (confirmed?.value !== 'confirm')
                return;
        }
        await this.deps.ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { defaultPreset: current });
        this.deps.ui.appendNotice(`Saved ${current} as the permission default for future sessions.`);
    }
    async showProviders() {
        const active = this.deps.ctx.llm.listProviders();
        const configurable = new Map(this.deps.ctx.llm.listConfigurableProviders().map(provider => [provider.provider, provider]));
        const rows = await Promise.all(active.map(async (provider) => {
            try {
                const models = await this.deps.ctx.llm.listModels(provider.id);
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
        this.deps.ui.appendNotice([
            'Provider routes',
            ...(rows.length === 0 ? ['- No active provider adapters.'] : rows),
            ...(dormant.length === 0 ? [] : ['', 'Configurable but inactive', ...dormant]),
            '',
            'Credentials are intentionally not displayed. Use `deepseek auth status` to inspect the active credential source.',
            'Provider profile changes remain a settings.yaml / advanced-settings workflow.',
        ].join('\n'));
    }
    showRuntime() {
        const service = this.deps.ctx.get('pluginInventory');
        const entries = service?.list().entries ?? [];
        const dshHome = resolveDshHome();
        this.deps.ui.appendNotice([
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
        const action = await this.deps.ui.choose('Support and feedback\n\nThe official /feedback command records your note in this session. Its acknowledgement will disclose whether session sharing is enabled, feedback-gated, disabled, or not configured.', [
            { value: 'cancel', label: 'Cancel', description: 'Do not record feedback' },
            { value: 'feedback', label: 'Write feedback…', description: 'Record a note through the official Harness command' },
        ], undefined, { initialValue: 'cancel' });
        if (action?.value !== 'feedback')
            return;
        const text = await this.deps.ui.promptText('Feedback about this session:');
        if (text === undefined || text.trim() === '')
            return;
        await this.deps.runHarnessCommand(`/feedback ${text.trim()}`);
    }
    settingsNamespaceCount() {
        return this.deps.ctx.settings.describe({ redactSecrets: true }).length;
    }
    loadSettingsNamespacePickerItems() {
        return settingsNamespacePickerItems(this.deps.ctx.settings.describe({ redactSecrets: true }).map(descriptor => ({
            ns: String(descriptor.ns),
            applies: descriptor.applies,
            revision: descriptor.revision,
            secrets: descriptor.secrets,
        })));
    }
    async editAdvancedSettings(namespace = '') {
        const descriptors = this.deps.ctx.settings.describe({ redactSecrets: true });
        if (descriptors.length === 0) {
            this.deps.ui.appendNotice('No runtime settings namespaces are registered.');
            return;
        }
        if (namespace.trim() === '') {
            const choice = await this.deps.ui.choose('Advanced runtime settings', this.loadSettingsNamespacePickerItems());
            if (choice === undefined)
                return;
            namespace = choice.value;
        }
        const descriptor = descriptors.find(candidate => String(candidate.ns) === namespace.trim());
        if (descriptor === undefined)
            throw new Error(`unknown settings namespace: ${namespace}`);
        const redacted = JSON.stringify(descriptor.value, null, 2) ?? 'undefined';
        this.deps.ui.appendNotice([
            `Settings: ${descriptor.ns}`,
            `Applies: ${descriptor.applies}`,
            `Revision: ${descriptor.revision}`,
            descriptor.secrets?.length ? 'Secret fields are hidden and will not be changed by a patch.' : undefined,
            '',
            redacted,
        ].filter((line) => line !== undefined).join('\n'));
        const action = await this.deps.ui.choose(`Edit ${descriptor.ns}`, [
            { value: 'patch', label: 'Apply JSON patch…', description: 'Merge fields into this namespace' },
            { value: 'reset', label: 'Reset overrides', description: 'Return every field to its composed/default value' },
            { value: 'cancel', label: 'Cancel' },
        ]);
        if (action === undefined || action.value === 'cancel')
            return;
        if (action.value === 'reset') {
            const confirmation = await this.deps.ui.choose(`Reset all user overrides for ${descriptor.ns}?`, [
                { value: 'cancel', label: 'Cancel' },
                { value: 'confirm', label: 'Reset overrides', description: 'Re-inherit composition defaults' },
            ]);
            if (confirmation?.value !== 'confirm')
                return;
            await this.deps.ctx.settings.replace(descriptor.ns, {}, descriptor.revision);
            this.deps.ui.appendNotice(`Reset ${descriptor.ns}. ${descriptor.applies === 'restart' ? 'Restart the TUI to apply it.' : 'Applied live.'}`);
            return;
        }
        const text = await this.deps.ui.promptText(`JSON object patch for ${descriptor.ns}:`);
        if (text === undefined)
            return;
        await this.deps.ctx.settings.update(descriptor.ns, parseSettingsPatch(text), descriptor.revision);
        this.deps.ui.appendNotice(`Updated ${descriptor.ns}. ${descriptor.applies === 'restart' ? 'Restart the TUI to apply it.' : 'Applied live.'}`);
    }
}
