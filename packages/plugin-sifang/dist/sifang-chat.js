import { requireSifangHost } from './sifang-host.js';
import { hostNoticeDue, resetHostNotices } from './host-notice.js';
const listeners = new Set();
const snapshots = new WeakMap();
const DISPLAY_FLOORS = 3;
const DISPLAY_REPLIES = 2;
let floors = [];
let floorIndex = [];
let save = null;
let identity = null;
let valid = false;
let saving = false;
let streaming = false;
let activity = 0;
const invalidNodes = new Set();
const invalidFloors = new Set();
let revision = 0;
let lifecycle;
let initializing;
let currentRefresh;
let needsFullRefresh = true;
let layoutDirty = true;
function chatId(value) { return JSON.stringify(['sifang', value.id, value.volume]); }
function sameSave(a, b) { return a.id === b.id && a.volume === b.volume; }
function belongs(floor, value) { return floor.saveId === value.id && floor.volume === value.volume; }
/** Only character metadata comes from the compatibility context; body text is always native. */
function characterIdentity() {
    const context = globalThis.SillyTavern?.getContext();
    const character = context?.characters?.[Number(context.characterId)];
    const name = character?.name || context?.name2;
    const key = character?.avatar || name;
    return key ? { scope: JSON.stringify(['character', key]), name: name || key } : null;
}
function checkFloor(floor) {
    if (!Number.isInteger(floor.floor) || floor.floor < 0 || !floor.node || !floor.saveId
        || typeof floor.raw !== 'string' || typeof floor.busy !== 'boolean') {
        throw new Error('独立前端楼层接口版本不匹配，请更新独立前端。');
    }
}
function requireIdle(floor) {
    if (saving || floor?.busy)
        throw new Error('请等当前回复与保存完成后再处理。');
}
function emit(messageId, event) {
    for (const listener of listeners) {
        try {
            listener(messageId, event);
        }
        catch { /* A view cannot undo a persisted floor. */ }
    }
}
function refresh(event, messageId) {
    if (messageId !== undefined && event !== 'CHAT_CHANGED')
        invalidFloors.add(messageId);
    else
        needsFullRefresh = true;
    if (event !== 'MESSAGE_UPDATED')
        layoutDirty = true;
    const ticket = ++revision;
    const previous = currentRefresh;
    const run = () => ticket === revision && !lifecycle?.aborted ? readFloors(event, messageId, ticket) : Promise.resolve();
    const pending = { promise: previous && !previous.settled ? previous.promise.then(run, run) : run(), settled: false };
    currentRefresh = pending;
    void pending.promise.then(() => { pending.settled = true; }, () => { pending.settled = true; });
    return pending.promise;
}
async function readFloors(event, messageId, ticket) {
    const host = requireSifangHost();
    const seenActivity = activity;
    const before = await host.game.save();
    if (lifecycle?.aborted || ticket !== revision)
        return;
    if (!before?.id) {
        valid = false;
        floorIndex = [];
        floors = [];
        save = null;
        identity = null;
        emit(undefined, 'CHAT_CHANGED');
        return;
    }
    if (save && !sameSave(save, before)) {
        valid = false;
        emit(undefined, 'CHAT_CHANGED');
    }
    // An edit keeps the floor layout. Check the native reply instead of copying the full directory.
    const cached = floors.find(item => item.floor === messageId);
    if (event === 'MESSAGE_UPDATED' && valid && !needsFullRefresh && !layoutDirty && cached
        && invalidFloors.size === 1 && [...invalidNodes].every(node => node === cached.node)) {
        const updated = await host.game.floor(cached.floor);
        if (lifecycle?.aborted || ticket !== revision)
            return;
        if (updated && belongs(updated, before) && updated.node === cached.node && updated.floor === cached.floor && updated.role === cached.role) {
            checkFloor(updated);
            floors[floors.indexOf(cached)] = updated;
            invalidFloors.delete(cached.floor);
            invalidNodes.delete(cached.node);
            streaming = activity !== seenActivity || floors.some(floor => floor.busy);
            emit(messageId, event);
            return;
        }
    }
    const line = await host.game.floors();
    if (lifecycle?.aborted || ticket !== revision)
        return;
    // User messages (including consecutive sends) must not evict the previous
    // illustrated reply. Keep the small tail plus the two latest AI replies.
    const replyNodes = new Set(line.filter(item => item.role === 'assistant').slice(-DISPLAY_REPLIES).map(item => item.node));
    const recent = line.filter((item, index) => index >= line.length - DISPLAY_FLOORS || replyNodes.has(item.node));
    const reuse = !needsFullRefresh && valid && save && sameSave(save, before);
    const loaded = await Promise.all(recent.map(item => {
        const cached = reuse && floors.find(floor => floor.floor === item.floor && floor.node === item.node && floor.role === item.role);
        return cached && !invalidFloors.has(item.floor) && !invalidNodes.has(item.node) ? cached : host.game.floor(item.floor);
    }));
    const after = await host.game.save();
    if (lifecycle?.aborted || ticket !== revision)
        return;
    if (!after || !sameSave(before, after)) {
        valid = false;
        emit(undefined, 'CHAT_CHANGED');
        throw new Error('存档已切换，正在等待当前正文同步。');
    }
    const next = loaded.filter((floor) => floor !== null);
    next.forEach(checkFloor);
    if (next.length !== recent.length || next.some((floor, index) => !belongs(floor, before) || floor.node !== recent[index].node)) {
        throw new Error('楼层已变化，正在等待当前正文同步。');
    }
    const switched = !save || !sameSave(save, after);
    floorIndex = line.map(({ floor, node, role }) => ({ floor, node, role }));
    floors = next.sort((a, b) => a.floor - b.floor);
    save = after;
    identity = characterIdentity();
    valid = true;
    needsFullRefresh = false;
    layoutDirty = false;
    streaming = activity !== seenActivity || next.some(floor => floor.busy);
    invalidNodes.clear();
    invalidFloors.clear();
    emit(messageId, switched ? 'CHAT_CHANGED' : event);
}
/** Subscribe before the first read, so changes during initialization invalidate its snapshot. */
export async function initializeSifangChat(signal) {
    if (signal.aborted)
        return;
    if (lifecycle === signal && initializing)
        return initializing;
    const host = requireSifangHost();
    lifecycle = signal;
    const events = {
        floor: 'GENERATION_ENDED', swipe: 'MESSAGE_SWIPED', edit: 'MESSAGE_UPDATED',
        remove: 'MESSAGE_DELETED', save: 'CHAT_CHANGED',
    };
    const unsubs = Object.entries(events).map(([native, event]) => host.on(native, payload => {
        if (signal.aborted)
            return;
        ++activity;
        const data = payload;
        const messageId = typeof data?.floor === 'number' ? data.floor
            : native === 'edit' && typeof data?.node === 'string' ? floors.find(floor => floor.node === data.node)?.floor : undefined;
        const changedSave = save && (data?.saveId && data.saveId !== save.id
            || data && 'volume' in data && data.volume !== save.volume);
        if (native === 'save' || changedSave) {
            valid = false;
            resetHostNotices();
            emit(undefined, 'CHAT_CHANGED');
        }
        else if (native === 'edit' || native === 'swipe' || native === 'remove') {
            // Only the changed floor is unavailable during its read. Other floors'
            // queued images keep their valid identity and are not cancelled.
            if (messageId !== undefined)
                invalidFloors.add(messageId);
            if (typeof data?.node === 'string')
                invalidNodes.add(data.node);
            if (Array.isArray(data?.removed))
                data.removed.forEach(node => { if (typeof node === 'string')
                    invalidNodes.add(node); });
        }
        void refresh(event, messageId).catch(error => {
            if (signal.aborted)
                return;
            // The floor being rewritten is unreadable for every event of that rewrite, and the
            // cache keeps its previous text until the new one lands. Only a failure that does
            // not concern the floor in flight is worth telling the user about, once per minute.
            if (messageId === floors.at(-1)?.floor)
                return;
            const text = error instanceof Error ? error.message : '正文同步失败。';
            if (hostNoticeDue(text))
                void host.ui.toast(text, 'fail').catch(() => { });
        });
    }));
    unsubs.push(host.on('stream', () => { if (!signal.aborted) {
        streaming = true;
        ++activity;
    } }));
    signal.addEventListener('abort', () => {
        unsubs.forEach(stop => stop());
        if (lifecycle !== signal)
            return;
        ++revision;
        valid = false;
        streaming = false;
        floorIndex = [];
        floors = [];
        save = null;
        identity = null;
        initializing = undefined;
        currentRefresh = undefined;
        invalidNodes.clear();
        invalidFloors.clear();
        resetHostNotices();
    }, { once: true });
    initializing = refresh('CHAT_CHANGED').catch(error => {
        // Settings can open before a game has been bound. Keep subscriptions alive
        // so the first native save/floor event can populate the empty cache.
        if (error instanceof Error && error.message.includes('no session bound'))
            return;
        throw error;
    });
    return initializing;
}
export function sifangFloorChoices() {
    if (!valid || !save)
        return [];
    const { id: saveId, volume } = save;
    return floorIndex.map(item => ({ ...item, saveId, volume, name: floors.find(f => f.node === item.node)?.name ?? identity?.name }));
}
export function hasSifangFloor(target) {
    return Boolean(valid && save && belongs(target, save) && floorIndex.some(item => item.floor === target.floor && item.node === target.node));
}
export function sifangSnapshotNode(snapshot) {
    return snapshots.get(snapshot)?.floor.node;
}
export function readSifangFloors() {
    return valid ? floors.filter(floor => !invalidNodes.has(floor.node) && !invalidFloors.has(floor.floor)) : [];
}
export function readSifangFloor(floor) {
    if (!valid || invalidFloors.has(floor))
        return undefined;
    return floors.find(item => item.floor === floor && !invalidNodes.has(item.node));
}
/** An edited floor can be temporarily unreadable while its unchanged markers are being reloaded. */
export function isSifangFloorPending(saveId, node) {
    return Boolean(valid && save?.id === saveId && currentRefresh && !currentRefresh.settled
        && floors.some(floor => floor.node === node && (invalidNodes.has(node) || invalidFloors.has(floor.floor))));
}
/** Follow replacements of the pending read; callers then check the final marker identity normally. */
export async function awaitSifangChatRefresh() {
    if (currentRefresh?.settled)
        return;
    while (currentRefresh) {
        const pending = currentRefresh;
        try {
            await pending.promise;
        }
        catch (error) {
            if (currentRefresh === pending)
                throw error;
        }
        if (currentRefresh === pending)
            return;
    }
}
export function sifangImageChatContext() {
    return valid && save && identity
        ? { ...identity, chatId: chatId(save), latestMessageId: floors.at(-1)?.floor ?? -1 } : null;
}
export function readSifangAssistantMessages() {
    const context = sifangImageChatContext();
    if (!context)
        return [];
    return readSifangFloors().filter(floor => floor.role === 'assistant').map(floor => ({
        scope: context.scope, chatId: context.chatId, messageId: floor.floor,
        swipeId: Math.max(0, floor.version - 1), historyId: floor.node, turnId: floor.node, text: floor.raw,
    }));
}
export function watchSifangChat(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}
function snapshotFor(floor, latestNode) {
    const snapshot = Object.freeze({
        chatId: chatId({ id: floor.saveId, volume: floor.volume, name: '' }), messageId: floor.floor,
        swipeId: Math.max(0, floor.version - 1), text: floor.raw,
    });
    snapshots.set(snapshot, { floor, latestNode });
    return snapshot;
}
export async function isSifangChatReady() {
    try {
        const ticket = activity;
        const latest = await requireSifangHost().game.floor();
        if (ticket !== activity)
            return false;
        if (latest)
            checkFloor(latest);
        requireIdle(latest);
        if (!latest?.busy)
            streaming = false;
        return Boolean(valid && !streaming && save && latest?.role === 'assistant' && belongs(latest, save)
            && !invalidNodes.has(latest.node) && !invalidFloors.has(latest.floor));
    }
    catch {
        return false;
    }
}
export async function captureSifangAssistant(target) {
    if (target) {
        await awaitSifangChatRefresh();
        const floor = readSifangFloor(target.floor) ?? (hasSifangFloor(target) ? await requireSifangHost().game.floor(target.floor) : null);
        if (!floor || floor.role !== 'assistant' || floor.node !== target.node
            || floor.saveId !== target.saveId || floor.volume !== target.volume) {
            throw new Error('所选楼层已变化，请重新选择。');
        }
        if (!floor.raw.trim())
            throw new Error('所选 AI 回复为空。');
        const snapshot = snapshotFor(floor);
        await assertSifangSnapshot(snapshot);
        return snapshot;
    }
    await awaitSifangChatRefresh();
    const host = requireSifangHost();
    const latest = await host.game.floor();
    if (latest)
        checkFloor(latest);
    requireIdle(latest);
    if (!latest || !save || !belongs(latest, save))
        throw new Error('当前聊天还没有可处理的 AI 回复。');
    if (latest.role !== 'assistant')
        throw new Error('最新一楼是用户消息，请等 AI 回复完成后再处理。');
    const floor = readSifangFloors().find(item => item.node === latest.node && item.floor === latest.floor && item.raw === latest.raw);
    if (!floor)
        throw new Error('最新回复已变化，请稍后重试。');
    requireIdle(floor);
    if (!floor.raw.trim())
        throw new Error('最新 AI 回复为空。');
    return snapshotFor(latest, latest.node);
}
export async function assertSifangSnapshot(snapshot) {
    const state = snapshots.get(snapshot);
    if (!state)
        throw new Error('聊天或原回复已发生变化，本次结果没有写回。');
    const saved = state.floor;
    const host = requireSifangHost();
    const [active, latest, target] = await Promise.all([
        host.game.save(), host.game.floor(), state.latestNode === undefined ? host.game.floor(saved.floor) : undefined,
    ]);
    const current = state.latestNode === undefined ? target : latest;
    if (current)
        checkFloor(current);
    if (latest)
        checkFloor(latest);
    requireIdle(latest);
    requireIdle(current ?? null);
    if (!active || !current || !belongs(saved, active) || !belongs(current, active) || !latest || !belongs(latest, active)
        || current.role !== 'assistant' || current.floor !== saved.floor || current.node !== saved.node
        || current.version !== saved.version || current.raw !== snapshot.text) {
        throw new Error('聊天或原回复已发生变化，本次结果没有写回。');
    }
    return saved;
}
export async function replaceSifangAssistant(snapshot, text, signal) {
    const saved = await assertSifangSnapshot(snapshot);
    signal?.throwIfAborted();
    if (text === snapshot.text)
        return snapshot;
    const beforeWrite = revision;
    saving = true;
    let committed;
    try {
        committed = await requireSifangHost().game.replaceText({
            saveId: saved.saveId, node: saved.node, volume: saved.volume, expectedRaw: snapshot.text, raw: text,
        });
        checkFloor(committed);
        if (committed.floor !== saved.floor || committed.role !== 'assistant' || committed.node !== saved.node || committed.saveId !== saved.saveId || committed.volume !== saved.volume || committed.raw !== text) {
            throw new Error('独立前端未返回原楼层的保存确认，请重新打开该楼层检查。');
        }
    }
    finally {
        saving = false;
    }
    // A host may deliver its edit event before or after the write acknowledgement.
    // Let an in-flight event win; otherwise install the acknowledged body directly.
    await awaitSifangChatRefresh();
    const index = floors.findIndex(floor => floor.floor === saved.floor && floor.node === saved.node);
    if (valid && save && belongs(committed, save) && index >= 0) {
        if (beforeWrite === revision) {
            floors[index] = committed;
            emit(committed.floor, 'MESSAGE_UPDATED');
        }
        else if (floors[index].raw === saved.raw) {
            // A different floor changed during the write. Recheck this floor before applying anything.
            await refresh('MESSAGE_UPDATED', saved.floor);
        }
    }
    return snapshotFor(committed, snapshots.get(snapshot)?.latestNode);
}
