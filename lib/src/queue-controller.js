import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { queueItemLabel, queueItems } from './queue.js';
function message(text) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}
export class QueueController {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    find(item) {
        const agent = this.deps.getAgent();
        return [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
            .find(candidate => String(candidate.id) === item.id);
    }
    async choose() {
        while (!this.deps.isClosing()) {
            const agent = this.deps.getAgent();
            const items = queueItems(agent.inbox.nextStep, agent.inbox.nextTurn);
            if (items.length === 0) {
                this.deps.ui.appendNotice('Queue is empty. Use /queue <prompt> to add a follow-up turn.');
                return;
            }
            const choice = await this.deps.ui.chooseSearchable('Queued work', items.map(item => ({
                value: item.id,
                label: queueItemLabel(item),
                description: `${item.placement === 'next-step' ? 'Steer' : 'Follow-up'} · ${item.id}${item.editable ? '' : ' · image message'}`,
                searchText: `${item.id} ${item.text}`,
            })));
            if (choice === undefined)
                return;
            const selected = items.find(item => item.id === choice.value);
            if (selected === undefined || this.find(selected) === undefined) {
                this.deps.ui.flashStatus('That queue item is no longer pending.');
                continue;
            }
            const actions = [
                ...(selected.editable
                    ? [{ value: 'edit', label: 'Edit text…', description: 'Replace this queued message in place' }]
                    : []),
                { value: 'remove', label: 'Remove', description: 'Cancel this queued message' },
                { value: 'back', label: 'Back', description: 'Return to the queue' },
            ];
            const action = await this.deps.ui.choose('Queue item', actions, undefined, { initialValue: 'back' });
            if (action === undefined || action.value === 'back')
                continue;
            if (action.value === 'edit') {
                const text = await this.deps.ui.promptText('Replacement queue text:');
                if (text === undefined || text.trim() === '')
                    continue;
                if (!agent.inbox.replace(selected.id, message(text.trim()))) {
                    this.deps.ui.flashStatus('That queue item was already claimed or removed.');
                }
                else {
                    this.deps.ui.setStatus('queued message updated');
                }
                continue;
            }
            const confirmation = await this.deps.ui.choose('Remove this queued message?', [
                { value: 'cancel', label: 'Cancel', description: 'Keep the message queued' },
                { value: 'remove', label: 'Remove message', description: 'This cannot be undone' },
            ], undefined, { initialValue: 'cancel' });
            if (confirmation?.value !== 'remove')
                continue;
            if (!agent.inbox.remove(selected.id)) {
                this.deps.ui.flashStatus('That queue item was already claimed or removed.');
            }
            else {
                this.deps.ui.setStatus('queued message removed');
            }
        }
    }
}
