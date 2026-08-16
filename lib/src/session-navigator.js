import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import { sessionPickerItems, } from './interaction.js';
async function mapWithConcurrency(items, limit, visit) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await visit(items[index]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
function updatedAt(events, createdAt) {
    return events.at(-1)?.time ?? createdAt;
}
export class SessionNavigator {
    deps;
    cache = new Map();
    loadAbort;
    constructor(deps) {
        this.deps = deps;
    }
    interrupt(reason = new Error('session loading cancelled')) {
        this.loadAbort?.abort(reason);
    }
    invalidate(id) {
        this.cache.delete(id);
    }
    hasCached(id) {
        return this.cache.has(id);
    }
    archivedIds() {
        return new Set(this.deps.ctx.workspaceRegistry.archivedSessionIds.map(String));
    }
    async chooseSession(archived = false) {
        this.deps.ui.setStatus(archived ? 'loading archived sessions…' : 'loading sessions…');
        const items = await this.loadForPicker(archived);
        if (items === undefined)
            return;
        if (items.length === 0) {
            this.deps.ui.appendNotice(archived ? 'No archived sessions.' : 'No sessions are available.');
            this.deps.ui.setStatus('ready');
            return;
        }
        const currentId = String(this.deps.getAgent().id);
        const choice = await this.deps.ui.chooseSearchable(archived ? 'Archived sessions' : 'Sessions', items, undefined, {
            initialValue: items.some(item => item.value === currentId) ? currentId : undefined,
            emptyText: 'No matching sessions',
        });
        if (choice === undefined || choice.value === currentId) {
            this.deps.ui.setStatus('ready');
            return;
        }
        await this.deps.requestSwitch(choice.value);
    }
    async chooseWorkspace() {
        this.deps.ui.setStatus('loading workspaces…');
        const abort = this.beginLoad();
        let snapshots;
        try {
            snapshots = await this.deps.ctx.sessionPersistence.listSnapshots(abort.signal);
            abort.signal.throwIfAborted();
        }
        catch (error) {
            if (abort.signal.aborted) {
                this.deps.ui.setStatus('workspace loading cancelled');
                return;
            }
            throw error;
        }
        finally {
            this.finishLoad(abort);
        }
        const archived = this.archivedIds();
        const workspaces = this.deps.ctx.workspaceRegistry.list();
        const visibleIds = snapshots
            .filter(snapshot => snapshot.header.origin !== 'subagent' && !archived.has(String(snapshot.header.id)))
            .map(snapshot => String(snapshot.header.id));
        const visibleIdSet = new Set(visibleIds);
        const groupedIds = new Set(workspaces.flatMap(workspace => workspace.sessionIds.map(String)));
        const groups = [
            ...workspaces.map(workspace => {
                const ids = workspace.sessionIds.map(String).filter(id => visibleIdSet.has(id));
                return {
                    value: String(workspace.id),
                    label: workspace.title,
                    description: `${ids.length} sessions · ${workspace.path}`,
                    ids: new Set(ids),
                };
            }),
            {
                value: 'ungrouped',
                label: 'Ungrouped sessions',
                description: `${visibleIds.filter(id => !groupedIds.has(id)).length} sessions`,
                ids: new Set(visibleIds.filter(id => !groupedIds.has(id))),
            },
        ].filter(group => group.ids.size > 0);
        if (groups.length === 0) {
            this.deps.ui.appendNotice('No workspace-grouped sessions are available.');
            return;
        }
        const group = await this.deps.ui.chooseSearchable('Workspaces', groups.map(item => ({
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
        const items = (await this.loadForPicker(false))?.filter(item => selected.ids.has(item.value));
        if (items === undefined)
            return;
        const currentId = String(this.deps.getAgent().id);
        const session = await this.deps.ui.chooseSearchable(selected.label, items, undefined, {
            initialValue: currentId,
            emptyText: 'No matching sessions',
        });
        if (session !== undefined && session.value !== currentId)
            await this.deps.requestSwitch(session.value);
    }
    beginLoad() {
        this.interrupt();
        const abort = new AbortController();
        this.loadAbort = abort;
        return abort;
    }
    finishLoad(abort) {
        if (this.loadAbort === abort)
            this.loadAbort = undefined;
    }
    async loadForPicker(archived) {
        const abort = this.beginLoad();
        try {
            return await this.loadPickerItems(abort.signal, archived);
        }
        catch (error) {
            if (abort.signal.aborted) {
                this.deps.ui.setStatus('session loading cancelled');
                return undefined;
            }
            throw error;
        }
        finally {
            this.finishLoad(abort);
        }
    }
    async loadPickerItems(signal, archivedOnly = false) {
        const snapshots = await this.deps.ctx.sessionPersistence.listSnapshots(signal);
        signal?.throwIfAborted();
        const archived = this.archivedIds();
        const visible = snapshots.filter(snapshot => snapshot.header.origin !== 'subagent'
            && archived.has(String(snapshot.header.id)) === archivedOnly);
        const visibleIds = new Set(visible.map(snapshot => String(snapshot.header.id)));
        for (const id of this.cache.keys()) {
            if (!visibleIds.has(id))
                this.cache.delete(id);
        }
        const agent = this.deps.getAgent();
        const currentId = String(agent.id);
        const sources = await mapWithConcurrency(visible, 8, snapshot => this.loadSource(snapshot, currentId, signal));
        if (!visibleIds.has(currentId)
            && agent.session.header.origin !== 'subagent'
            && archived.has(currentId) === archivedOnly) {
            sources.push(this.liveSource());
        }
        return sessionPickerItems(sources);
    }
    async loadSource(snapshot, currentId, signal) {
        signal?.throwIfAborted();
        const id = String(snapshot.header.id);
        if (id === currentId)
            return this.liveSource();
        const revision = String(snapshot.revision);
        const cached = this.cache.get(id);
        if (cached?.revision === revision)
            return cached.source;
        try {
            const inspected = await this.deps.ctx.sessionPersistence.inspect(snapshot.header.id, signal);
            const source = this.source(inspected.meta, inspected.events);
            this.cache.set(id, { revision, source });
            return source;
        }
        catch {
            signal?.throwIfAborted();
            return this.source(snapshot.header, [], { titleUnavailable: true });
        }
    }
    liveSource() {
        const agent = this.deps.getAgent();
        return this.source(agent.session.header, agent.session.events, {
            current: true,
            running: agent.status === 'running',
        });
    }
    source(header, events, state = {}) {
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
}
