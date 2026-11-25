import { imageChatContext } from './chat-host.js';
import type { createImageGallery, GalleryImage } from './image-gallery.js';
import { notifyImageHistorySaved, deleteImageHistory, historyWasDeleted, type ImageHistoryChange, type ImageHistoryEntry } from './image-history.js';
import { readServiceHistory, readServiceHistoryImage, readServiceMarkerSaved, requestServiceImage } from './service-client.js';
import type { MarkerEntry } from './image-marker-history.js';
import { currentPreferences } from './settings.js';
import { awaitSifangChatRefresh } from './sifang-chat.js';
import { emitPetEvent, petEnd, petFault, petTaskId } from './pet-events.js';
import type { BatchPicture } from './service-protocol.js';
import type { FloorTarget } from './pet-targets.js';

export interface NativeImageView {
  state: 'idle' | 'queued' | 'generating';
  status: string;
  blob?: Blob | null;
  /** The new picture keeps its place in the frame but stays hidden while the desktop pet flies it in. */
  veiled: boolean;
}

/** The native view is transient. History, gallery and requests keep the plugin's existing storage and queue. */
export function createSifangImageControl(entry: MarkerEntry, root: ShadowRoot, hooks: {
  current(): boolean;
  latest(): boolean;
  pending(): boolean;
  update(view: NativeImageView): void;
  /** The floor index, for the desktop pet's events. */
  floor(): number;
  /** Where the host's frame sits, read again and again for a while (a picture's flight); target() is the latest. */
  watch(): { target(): FloorTarget | null; stop(): void };
}, initial?: BatchPicture, options: { inlineImages?: () => boolean; pet?: boolean } = {}) {
  const controller = new AbortController();
  let request: AbortController | null = null;
  let phase: NativeImageView['state'] = 'idle';
  let status = '正在读取图片历史…';
  type SavedImage = Pick<ImageHistoryEntry, 'id' | 'createdAt'> & { blob?: Blob };
  let displayed: Pick<ImageHistoryEntry, 'id' | 'createdAt'> | undefined;
  // A failed save has no service copy; keep it downloadable while its frame exists.
  let unsaved: ImageHistoryEntry | undefined;
  function select(item?: SavedImage) {
    reloading?.abort(); reloading = undefined;
    displayed = item && { id: item.id, createdAt: item.createdAt };
  }
  let reloading: AbortController | undefined;
  let historyAvailable = false;
  let gallery: { view: ReturnType<typeof createImageGallery>; controller: AbortController; items: GalleryImage[] } | undefined;
  let openingGallery = false;
  let veils = 0;
  let veiled = false;
  const pendingHistory = new Set<ImageHistoryChange[]>();
  const historyKey = entry.historyKey;
  function show(blob?: Blob | null) {
    if (controller.signal.aborted) return;
    hooks.update({ state: phase, status, blob: options.inlineImages?.() === false ? null : blob, veiled });
  }
  function report(text: string, blob?: Blob | null) { status = text; show(blob); }
  const savedText = '已保存图片 · 点击查看历史';
  async function fetchHistory(key: string, signal: AbortSignal, latest = false) {
    const changes: ImageHistoryChange[] = [];
    pendingHistory.add(changes);
    try {
      const entries = await readServiceHistory(key, signal, latest);
      return entries.filter(entry => !changes.some(change => historyWasDeleted(entry, change)));
    } finally { pendingHistory.delete(changes); }
  }
  function closeGallery() {
    if (!gallery) return;
    const current = gallery;
    gallery = undefined;
    current.controller.abort();
    current.view.element.remove();
    current.items.forEach(item => URL.revokeObjectURL(item.url));
  }
  function showHistory(current: NonNullable<typeof gallery>, entries: ImageHistoryEntry[]) {
    const old = new Map(current.items.map(item => [item.entry.id, item]));
    current.items = entries.map(entry => {
      const item = old.get(entry.id);
      old.delete(entry.id);
      return item ?? { entry, url: URL.createObjectURL(entry.blob) };
    });
    current.view.setImages(current.items, displayed?.id ?? null);
    for (const item of old.values()) URL.revokeObjectURL(item.url);
  }
  async function openHistory() {
    if (!displayed || gallery || openingGallery || controller.signal.aborted) return;
    openingGallery = true;
    let create: typeof createImageGallery;
    try { create = (await import('./image-gallery.js')).createImageGallery; }
    catch (error) { if (!controller.signal.aborted) report(error instanceof Error ? error.message : '图片查看器加载失败。'); return; }
    finally { openingGallery = false; }
    if (controller.signal.aborted) return;
    const open = new AbortController();
    const view = create(entry.marker.summary, open.signal, {
      onSelect(id) {
        const item = gallery?.items.find(item => item.entry.id === id)?.entry;
        select(item);
        show(item?.blob ?? null);
      },
      async onDelete(id) {
        if (historyKey && id !== unsaved?.id) await deleteImageHistory(id);
        else remove({ deletedIds: [id] });
      },
    });
    const current = { view, controller: open, items: [] as GalleryImage[] };
    gallery = current;
    root.append(view.element);
    if (unsaved) showHistory(current, [unsaved]);
    view.open();
    view.element.addEventListener('close', closeGallery, { signal: open.signal, once: true });
    if (!historyKey) return;
    try {
      const entries = await fetchHistory(historyKey, open.signal, options.inlineImages?.() === false);
      if (gallery !== current) return;
      const local = unsaved;
      if (local && !entries.some(item => item.id === local.id)) entries.push(local);
      if (!entries.some(item => item.id === displayed?.id)) {
        const item = entries.at(-1);
        select(item);
        report(displayed ? savedText : '图片已清理，可重新生成。', item?.blob ?? null);
      }
      showHistory(current, entries);
    } catch (error) {
      if (!open.signal.aborted && !request) report(error instanceof Error ? error.message : '图片历史读取失败。');
    }
  }
  function remove(change: ImageHistoryChange) {
    if (!change.deletedIds?.length && change.before === undefined) return;
    if (unsaved && historyWasDeleted(unsaved, change)) unsaved = undefined;
    for (const changes of pendingHistory) changes.push(change);
    const entries = gallery?.items.map(item => item.entry).filter(item => !historyWasDeleted(item, change));
    if (displayed && historyWasDeleted(displayed, change)) {
      const item = entries?.at(-1);
      select(item);
      if (!request) status = displayed ? savedText : '图片已清理，可重新生成。';
      show(item?.blob ?? null);
      if (!displayed && historyKey) void refreshLatest();
    }
    if (gallery && entries && entries.length !== gallery.items.length) showHistory(gallery, entries);
  }
  // The desktop pet hides a new picture while it flies in; the frame shows it again after 4 s at the latest.
  function veil(stop: () => void) {
    const current = ++veils;
    veiled = true;
    show();
    const release = () => {
      if (veils !== current) return;
      stop();
      veiled = false;
      show();
    };
    setTimeout(release, 4000);
    return release;
  }

  /** The batch loader injects the saved picture here; a failure keeps automatic draws from billing twice. */
  let settled = false;
  let settleReady!: () => void;
  const ready = new Promise<void>(resolve => { settleReady = resolve; });
  function restore(entry: SavedImage | undefined, failure?: string): void {
    if (settled || controller.signal.aborted) return;
    settled = true;
    settleReady();
    historyAvailable = failure === undefined;
    if (!displayed) select(entry);
    if (!request) report(failure ?? (displayed ? savedText : ''), entry?.blob ?? null);
    else show(entry?.blob ?? null);
  }
  async function refreshLatest() {
    try {
      const entries: SavedImage[] = !historyKey ? [] : options.inlineImages?.() === false
        ? [...(await readServiceMarkerSaved([historyKey], controller.signal)).values()].filter((item): item is NonNullable<typeof item> => !!item)
        : await fetchHistory(historyKey, controller.signal, true);
      if (controller.signal.aborted) return;
      historyAvailable = true;
      if (displayed) return;
      const item = entries.at(-1);
      select(item);
      if (!request) report(displayed ? savedText : '', item?.blob ?? null);
      else show(item?.blob ?? null);
    } catch (error) {
      if (!controller.signal.aborted && !request) report(error instanceof Error ? error.message : '图片读取失败。');
    }
  }
  if (initial) {
    settled = true;
    settleReady();
    historyAvailable = true;
    select(initial.entry);
    if (initial.error) unsaved = initial.entry;
    report(initial.error ?? (displayed ? savedText : ''), initial.entry?.blob ?? null);
  }

  async function generate(autoSignal?: AbortSignal): Promise<void> {
    if (controller.signal.aborted || request || autoSignal?.aborted || !hooks.current()) return;
    const job = new AbortController();
    const cancel = () => job.abort();
    controller.signal.addEventListener('abort', cancel, { once: true });
    autoSignal?.addEventListener('abort', cancel, { once: true });
    request = job;
    phase = 'queued';
    report('正在加入队列…');
    // Manual clicks report progress and results in the native frame.
    const pet = autoSignal && options.pet !== false ? { id: petTaskId(), source: 'auto' as const, floor: hooks.floor() } : undefined;
    const finishPet = petEnd();
    function endPet(event: Omit<Parameters<typeof finishPet>[0], 'id' | 'type' | 'task' | 'source' | 'floor'>) {
      if (pet) finishPet({ ...pet, type: 'end', task: 'image', ...event });
    }
    try {
      if (pet) emitPetEvent({ ...pet, type: 'image', phase: 'start',
        turn: true, summary: entry.marker.summary, again: !!displayed });
      await ready;
      await awaitSifangChatRefresh();
      job.signal.throwIfAborted();
      if (!hooks.current()) { job.abort(); job.signal.throwIfAborted(); }
      const draft = {
        id: `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`,
        markerKey: historyKey ?? entry.key, scenePrompt: entry.marker.prompt,
        title: entry.marker.summary, sourceName: imageChatContext()?.name,
      };
      const result = await requestServiceImage({
        input: { scene: entry.marker.prompt, size: entry.marker.size },
        history: historyKey ? draft : undefined,
      }, job.signal, progress => {
        if (!hooks.current() || (progress.state === 'generating' && hooks.pending())) { job.abort(); return; }
        if (autoSignal && progress.state === 'generating' && (!currentPreferences().autoGenerateImages || !hooks.latest())) { job.abort(); return; }
        phase = progress.state;
        report(progress.state === 'queued' ? `等待绘制 · 队列第 ${progress.position} 位` : '正在绘制…');
        if (pet) emitPetEvent({ ...pet, type: 'image', phase: progress.state,
          position: progress.state === 'queued' ? progress.position : undefined, columns: progress.columns });
      });
      await awaitSifangChatRefresh();
      if (job.signal.aborted || controller.signal.aborted || !hooks.current()) {
        endPet({ result: 'dropped', paid: true, message: '' });
        return;
      }
      const { history: stored, ...picture } = result;
      const item: ImageHistoryEntry = { ...picture, ...draft, createdAt: stored?.createdAt ?? Date.now() };
      select(item);
      const failure = stored?.error;
      unsaved = !stored || failure ? item : undefined;
      const message = failure ? `图片已生成，但历史未保存：${failure}`
        : historyKey ? savedText : '图片仅保留在当前页面，可下载保存。';
      if (gallery) showHistory(gallery, [...gallery.items.map(item => item.entry), item]);
      report(message, item.blob);
      if (stored && !failure) notifyImageHistorySaved(stored.id);
      if (pet) {
        const place = hooks.watch();
        setTimeout(place.stop, 8000);
        endPet({ result: 'done', message: '', picture: {
          blob: result.blob, width: result.parameters.width, height: result.parameters.height, target: place.target, veil: () => veil(place.stop),
        } });
        emitPetEvent({ type: 'history', id: pet.id, saved: !failure, pageOnly: !historyKey, message });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        endPet({ result: 'dropped', serverMayContinue: phase !== 'queued', message: '' });
        return;
      }
      const cancelled = job.signal.aborted;
      report(cancelled ? '已取消本次等待，服务端任务可能仍在继续。' : error instanceof Error ? error.message : '生图未完成，请稍后重试。');
      endPet({ result: cancelled ? 'cancelled' : 'failed', message: status,
        fault: cancelled ? undefined : petFault(error), serverMayContinue: cancelled && phase !== 'queued' });
    } finally {
      endPet({ result: 'dropped', message: '' });
      controller.signal.removeEventListener('abort', cancel);
      autoSignal?.removeEventListener('abort', cancel);
      request = null;
      phase = 'idle';
      show();
    }
  }

  return {
    generate,
    async generateAutomatically(signal: AbortSignal) {
      await ready;
      if (signal.aborted || !historyAvailable || displayed || request) return;
      await generate(signal);
    },
    cancel() { request?.abort(); },
    open() { void openHistory(); },
    removeHistory: remove,
    async redisplay() {
      const selected = displayed;
      if (!selected || controller.signal.aborted || options.inlineImages?.() === false) return;
      if (unsaved?.id === selected.id) { show(unsaved.blob); return; }
      if (!historyKey || reloading) return;
      const load = new AbortController();
      reloading = load;
      try {
        const item = await readServiceHistoryImage(selected.id, load.signal);
        if (displayed === selected && !load.signal.aborted) show(item?.blob ?? null);
      } catch (error) {
        if (displayed === selected && !load.signal.aborted) report(error instanceof Error ? error.message : '图片读取失败。');
      } finally { if (reloading === load) reloading = undefined; }
    },
    restore,
    dispose() {
      if (!settled) { settled = true; settleReady(); }
      controller.abort(); reloading?.abort(); closeGallery();
      displayed = undefined; unsaved = undefined;
    },
  };
}
