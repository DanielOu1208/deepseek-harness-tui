function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/** Fold the durable tool-workflow records in a parent session. */
export function projectWorkflowActivity(events) {
    const runs = new Map();
    for (const event of events) {
        if (!event.type.startsWith('tool-workflow/'))
            continue;
        const data = record(event.data);
        if (data === undefined)
            continue;
        const runId = typeof data.runId === 'string' ? data.runId : undefined;
        if (runId === undefined)
            continue;
        if (event.type === 'tool-workflow/run-start') {
            runs.set(runId, {
                id: runId,
                name: typeof data.name === 'string' ? data.name : 'Workflow',
                startedAt: event.time,
                members: [],
            });
            continue;
        }
        const run = runs.get(runId);
        if (run === undefined)
            continue;
        if (event.type === 'tool-workflow/agent-start') {
            if (typeof data.seq !== 'number' || typeof data.childId !== 'string')
                continue;
            run.members.push({
                seq: data.seq,
                label: typeof data.label === 'string' ? data.label : `Agent ${String(data.seq)}`,
                ...(typeof data.phase === 'string' ? { phase: data.phase } : {}),
                childId: data.childId,
                outcome: 'running',
            });
            continue;
        }
        if (event.type === 'tool-workflow/agent-end') {
            if (typeof data.seq !== 'number')
                continue;
            const member = run.members.find(candidate => candidate.seq === data.seq);
            if (member !== undefined && (data.outcome === 'completed' || data.outcome === 'failed' || data.outcome === 'cancelled')) {
                member.outcome = data.outcome;
            }
            continue;
        }
        if (event.type === 'tool-workflow/run-end') {
            run.endedAt = event.time;
            if (typeof data.stopReason === 'string')
                run.stopReason = data.stopReason;
        }
    }
    return [...runs.values()].map(run => ({ ...run, members: run.members.map(member => ({ ...member })) }));
}
