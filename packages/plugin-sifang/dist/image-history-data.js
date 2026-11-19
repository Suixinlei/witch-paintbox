/** Positive tags for display and manual character selection, not for recreating a request. */
export function imageHistoryPositive(entry) {
    return [entry.positive, ...(entry.characters ?? []).map(character => character.positive)]
        .filter(Boolean).join(',\n');
}
export function historyScope(markerKey) {
    try {
        const key = JSON.parse(markerKey);
        if (Array.isArray(key) && typeof key[0] === 'string')
            return key[0];
    }
    catch { /* Legacy records without an identifiable card remain in All images. */ }
    return 'unassigned';
}
export function historySourceName(scope, sourceName) {
    if (sourceName?.trim() && sourceName !== '当前群聊')
        return sourceName;
    try {
        const key = JSON.parse(scope);
        if (Array.isArray(key) && key[1] !== undefined && key[1] !== null) {
            if (key[0] === 'group')
                return `群聊 · ${key[1]}`;
            if (key[0] === 'character')
                return String(key[1]).replace(/\.png$/i, '');
        }
    }
    catch { /* Images created without an open card have no card identity. */ }
    return '未归属图片';
}
export function historyTitle(entry) {
    if (entry.title)
        return entry.title;
    try {
        const key = JSON.parse(entry.markerKey);
        const raw = key[key.length - 3];
        if (typeof raw === 'string')
            return /^<img>\s*\[([^\]\r\n]+)\]/.exec(raw)?.[1] ?? '配图';
    }
    catch { /* Keep old images viewable even when their title cannot be recovered. */ }
    return '配图';
}
export function historyWasDeleted(entry, change) {
    return Boolean(change.deletedIds?.includes(entry.id) || change.before !== undefined && entry.createdAt < change.before);
}
