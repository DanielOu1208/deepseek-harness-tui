function mutationLocations(view) {
    if (view?.card === 'diff')
        return view.locations ?? [];
    if (view?.card === 'generic' && view.kind === 'edit')
        return view.locations ?? [];
    return [];
}
export function deriveDeliverables(records) {
    const seen = new Set();
    const output = [];
    for (const record of records) {
        if (record.failed)
            continue;
        for (const location of mutationLocations(record.callView)) {
            const path = location.path.trim();
            if (path === '' || seen.has(path))
                continue;
            seen.add(path);
            output.push({ path, firstSeq: record.seq, turn: record.turn });
        }
    }
    return output;
}
export function deliverableBasename(path) {
    const parts = path.split(/[\\/]/u).filter(Boolean);
    return parts.at(-1) ?? path;
}
