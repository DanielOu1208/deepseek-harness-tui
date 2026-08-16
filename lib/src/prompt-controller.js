import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { detectImageMediaType, readClipboardImage } from './clipboard-image.js';
import { OTHER_ANSWER_VALUE, questionLabelsFromValues, questionPickerItems, } from './interaction.js';
function questionTitle(question) {
    return [
        question.header ? `## ${question.header}` : undefined,
        question.question,
        question.detail,
    ].filter((part) => Boolean(part)).join('\n\n');
}
export class PromptController {
    deps;
    draftSaveTimer;
    pendingImages = [];
    interactionDisposers = [];
    constructor(deps) {
        this.deps = deps;
    }
    installInteractions() {
        const userQuestions = this.deps.ctx.get('userQuestions');
        const questionDispose = userQuestions?.registerProvider({
            ask: request => this.askQuestions(request),
        });
        if (questionDispose !== undefined)
            this.interactionDisposers.push(questionDispose);
        this.interactionDisposers.push(this.deps.ctx.on('approval/request', (request, next) => {
            const agent = this.deps.getAgent();
            if (agent === undefined || request.agent !== agent)
                return next();
            return this.askApproval(request);
        }));
    }
    disposeInteractions() {
        while (this.interactionDisposers.length > 0)
            this.interactionDisposers.pop()?.();
    }
    async askApproval(request) {
        const choice = await this.deps.ui.choose(`Permission request\n\nTool: ${request.toolName}${request.reason ? `\nReason: ${request.reason}` : ''}`, [
            { value: 'allow', label: 'Allow once', description: 'Run this action once' },
            { value: 'reject', label: 'Reject', description: 'Deny this action' },
        ], request.signal, { initialValue: 'reject', priority: 'required' });
        if (request.signal?.aborted)
            return 'cancelled';
        return choice?.value === 'allow' ? 'allowed-once' : choice?.value === 'reject' ? 'rejected' : 'cancelled';
    }
    async askQuestions(request) {
        if (request.agent !== undefined && request.agent !== this.deps.getAgent()) {
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
                    const custom = await this.deps.ui.promptText(`${title}\n\nType your answer:`, request.signal, { priority: 'required' });
                    if (custom === undefined)
                        throw new Error('question cancelled');
                    answers.push({ id: question.id, selected: [], custom });
                    continue;
                }
                const selected = await this.deps.ui.chooseMany(title, [
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
                const custom = await this.deps.ui.promptText(`${title}\n\nType the additional answer:`, request.signal, { priority: 'required' });
                if (custom === undefined)
                    throw new Error('question cancelled');
                answers.push({ id: question.id, selected: labels, custom });
                continue;
            }
            if (options.length > 0) {
                const choice = await this.deps.ui.choose(title, [
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
            const custom = await this.deps.ui.promptText(`${title}\n\nType your answer:`, request.signal, { priority: 'required' });
            if (custom === undefined)
                throw new Error('question cancelled');
            answers.push({ id: question.id, selected: [], custom });
        }
        return { answers };
    }
    cancelDraftSave() {
        if (this.draftSaveTimer === undefined)
            return;
        clearTimeout(this.draftSaveTimer);
        this.draftSaveTimer = undefined;
    }
    scheduleDraftSave(text) {
        const agent = this.deps.getAgent();
        if (agent === undefined || this.deps.isClosing())
            return;
        const sessionId = String(agent.id);
        this.cancelDraftSave();
        this.draftSaveTimer = setTimeout(() => {
            this.draftSaveTimer = undefined;
            void this.deps.draftStore.save(sessionId, text).catch(error => this.deps.ui.flashError(error));
        }, 150);
    }
    async persistCurrentDraft(text) {
        const agent = this.deps.getAgent();
        if (agent === undefined)
            return;
        this.cancelDraftSave();
        await this.deps.draftStore.save(String(agent.id), text ?? this.deps.ui.getComposerText());
    }
    async restoreCurrentDraft() {
        const agent = this.deps.getAgent();
        if (agent === undefined)
            return;
        this.cancelDraftSave();
        this.deps.ui.setComposerText(await this.deps.draftStore.load(String(agent.id)) ?? '');
    }
    async flushDrafts() {
        this.cancelDraftSave();
        await this.deps.draftStore.flush();
    }
    hasPendingImages() {
        return this.pendingImages.length > 0;
    }
    clearPendingImages() {
        this.pendingImages = [];
    }
    async addPendingImage(input) {
        const limits = this.deps.ctx.attachments.imageLimits;
        if (this.pendingImages.length >= limits.maxImagesPerMessage) {
            throw new Error(`a prompt can contain at most ${limits.maxImagesPerMessage} images`);
        }
        const total = this.pendingImages.reduce((sum, image) => sum + image.data.byteLength, 0) + input.data.byteLength;
        if (total > limits.maxMessageImageBytes) {
            throw new Error(`pending images exceed the ${limits.maxMessageImageBytes}-byte message limit`);
        }
        await this.deps.ctx.attachments.validateImage(input);
        this.pendingImages.push(input);
        this.deps.ui.appendNotice(`[image] ${input.name ?? 'attachment'} · ${input.mediaType} · ${input.data.byteLength} bytes`);
        this.deps.ui.setStatus(`${this.pendingImages.length} image${this.pendingImages.length === 1 ? '' : 's'} attached to the next prompt`);
    }
    async attachImagePath(path) {
        const agent = this.deps.getAgent();
        if (agent === undefined)
            throw new Error('no active DeepSeek session');
        const cwd = agent.session.header.cwd ?? resolve(this.deps.startupCwd ?? process.cwd());
        const absolute = resolve(cwd, path);
        const metadata = await stat(absolute);
        if (!metadata.isFile())
            throw new Error(`attachment is not a file: ${path}`);
        if (metadata.size > this.deps.ctx.attachments.imageLimits.maxImageBytes) {
            throw new Error(`image exceeds the ${this.deps.ctx.attachments.imageLimits.maxImageBytes}-byte limit`);
        }
        const data = new Uint8Array(await readFile(absolute));
        const mediaType = detectImageMediaType(data);
        if (mediaType === undefined)
            throw new Error('unsupported image; use PNG, JPEG, WebP, or GIF');
        await this.addPendingImage({ data, mediaType, name: basename(absolute) });
    }
    async pasteClipboardImage() {
        this.deps.ui.setStatus('reading image from clipboard…');
        const image = await (this.deps.readClipboardImage ?? readClipboardImage)();
        if (image === undefined) {
            this.deps.ui.appendNotice('No supported clipboard image was available. Use /attach <path> as a fallback.');
            this.deps.ui.setStatus('ready');
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
            const entered = await this.deps.ui.promptText('Image path (PNG, JPEG, WebP, or GIF):');
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
        const choice = await this.deps.ui.choose('Pending images', items);
        if (choice === undefined)
            return;
        if (choice.value === 'add') {
            const entered = await this.deps.ui.promptText('Image path (PNG, JPEG, WebP, or GIF):');
            if (entered?.trim())
                await this.attachImagePath(entered.trim());
            return;
        }
        if (choice.value === 'clear')
            this.clearPendingImages();
        else {
            const index = Number(choice.value.slice('remove:'.length));
            if (Number.isInteger(index))
                this.pendingImages.splice(index, 1);
        }
        this.deps.ui.setStatus(this.pendingImages.length === 0
            ? 'pending images cleared'
            : `${this.pendingImages.length} image${this.pendingImages.length === 1 ? '' : 's'} attached to the next prompt`);
    }
    async beginPrompt(text) {
        const agent = this.deps.getAgent();
        if (agent === undefined)
            throw new Error('no active DeepSeek session');
        const sessionId = String(agent.id);
        this.cancelDraftSave();
        await this.deps.draftStore.save(sessionId, text);
        return sessionId;
    }
    async completePrompt(sessionId) {
        this.clearPendingImages();
        const nextDraft = this.deps.ui.getComposerText();
        if (nextDraft === '')
            await this.deps.draftStore.delete(sessionId);
        else
            await this.deps.draftStore.save(sessionId, nextDraft);
    }
    async recoverPrompt(sessionId, submittedText) {
        const newerText = this.deps.ui.getComposerText();
        const restored = newerText === '' ? submittedText : `${submittedText}\n${newerText}`;
        this.deps.ui.setComposerText(restored);
        await this.deps.draftStore.save(sessionId, restored);
    }
    async promptMessage(text) {
        if (this.pendingImages.length === 0) {
            return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
        }
        const selection = this.deps.getSelection()?.current;
        if (selection === undefined)
            throw new Error('model selection is unavailable');
        const info = await this.deps.ctx.llm.resolveModelInfo(selection.provider, selection.model);
        if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
            throw new Error(`the current model ${selection.provider}/${selection.model} does not accept image input`);
        }
        await Promise.all(this.pendingImages.map(image => this.deps.ctx.attachments.validateImage(image)));
        const refs = [];
        for (const image of this.pendingImages)
            refs.push(await this.deps.ctx.attachments.saveImage(image));
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
        const choice = await this.deps.ui.choose(`Discard ${this.pendingImages.length} unsent image${this.pendingImages.length === 1 ? '' : 's'} and change sessions?`, [
            { value: 'keep', label: 'Stay here', description: 'Keep the pending images' },
            { value: 'discard', label: 'Discard and switch', description: 'Unsent image drafts are temporary' },
        ], undefined, { initialValue: 'keep' });
        return choice?.value === 'discard';
    }
}
