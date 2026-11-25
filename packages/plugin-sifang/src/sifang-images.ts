import { imageChatContext, readAssistantMessages, watchChatRendering } from './chat-host.js';
import { servicePolicy } from './service-runtime.js';
import { markerEntries, type MarkerEntry, type AssistantImageMessage } from './image-marker-history.js';
import { automaticImages } from './automatic-images.js';
import { onImageHistoryChanged } from './image-history.js';
import { createSifangImageControl, type NativeImageView } from './sifang-image-control.js';
import { readServiceMarkerLatest, readServiceMarkerSaved } from './service-client.js';
import { sifangHost, type SifangFloor } from './sifang-host.js';
import { hasSifangFloor, readSifangFloor, readSifangFloors, isSifangFloorPending } from './sifang-chat.js';
import { clearSifangBatch, sifangBatchPicture } from './sifang-batch.js';
import { nativeTarget, type FloorTarget } from './pet-targets.js';
import { hostNoticeDue, resetHostNotices } from './host-notice.js';

interface NativeControl {
  id: string;
  entry: MarkerEntry;
  message: AssistantImageMessage;
  floor: SifangFloor;
  registered: boolean;
  view?: NativeImageView;
  pendingBlob?: Blob | null;
  needsPicture: boolean;
  updating: boolean;
  revision: number;
  sentRevision?: number;
  control: ReturnType<typeof createSifangImageControl>;
}

/** Render through the host's real paragraph blocks, while keeping the existing plugin image lifecycle. */
export function bindSifangImages(root: ShadowRoot, signal: AbortSignal, options: { inlineImages?: () => boolean; pet?: boolean } = {}): void {
  const host = sifangHost;
  if (!host || signal.aborted) return;
  let inlineImages = options.inlineImages?.() !== false;
  const controls = new Map<string, NativeControl>();
  const registered = new Map<string, { floor: SifangFloor; signature: string }>();
  // Floors the host refused (gone, switched away, or still being rewritten). A refusal
  // lasts until that floor is written again: it is retried on a slow backoff instead of
  // on every chat event, and it reaches the user once, not once per event.
  const refused = new Map<string, {
    signature: string; floor: number; at: number; told: boolean; retry?: ReturnType<typeof setTimeout>;
  }>();
  let version = 0;
  let rendering = false;
  let dirty = false;

  /** A floor the host is rewriting answers every event with a rejection; ask it again slowly. */
  const REFUSE_RETRY = 5_000;
  const floorKey = (floor: Pick<SifangFloor, 'saveId' | 'node'>): string => JSON.stringify([floor.saveId, floor.node]);
  const report = (error: unknown) => {
    if (signal.aborted) return;
    const text = error instanceof Error ? error.message : '配图显示接口未能完成操作。';
    if (!hostNoticeDue(text)) return;
    void host.ui.toast(text, 'fail').catch(() => {});
  };
  function forgetRefusal(key: string): void {
    const record = refused.get(key);
    if (record?.retry) clearTimeout(record.retry);
    refused.delete(key);
  }
  function forgetRefusals(): void {
    for (const record of refused.values()) if (record.retry) clearTimeout(record.retry);
    refused.clear();
  }
  /** Remember a refused floor and say so once per refusal, however often the host repeats itself.
   *  The retry timer asks again on its own: a quiet chat must not leave the floor unregistered. */
  function refuse(key: string, floor: SifangFloor, signature: string, error: unknown): void {
    const previous = refused.get(key);
    if (previous?.retry) clearTimeout(previous.retry);
    const told = previous?.told ?? false;
    // The floor being rewritten is the last one: the host refuses it until the new text
    // lands, and the retry registers it then. Only an unexpected floor is worth a notice.
    const expected = floor.floor === imageChatContext()?.latestMessageId;
    refused.set(key, { signature, floor: floor.floor, at: Date.now(), told: told || !expected });
    const record = refused.get(key)!;
    record.retry = setTimeout(() => {
      record.retry = undefined;
      if (refused.get(key) !== record) return;
      // The backoff has been served; let the next pass ask again even without a new event.
      record.at = 0; record.signature = '';
      schedule();
    }, REFUSE_RETRY);
    if (!told && !expected) report(error);
  }
  function isCurrent(item: NativeControl): boolean {
    if (signal.aborted || controls.get(item.entry.key) !== item || servicePolicy()?.parseImageMarkers === false) return false;
    if (isSifangFloorPending(item.floor.saveId, item.floor.node)) return true;
    const context = imageChatContext();
    const floor = readSifangFloor(item.floor.floor);
    if (context?.chatId !== item.message.chatId || context.scope !== item.message.scope
      || floor?.role !== 'assistant' || floor.node !== item.floor.node
      || Math.max(0, floor.version - 1) !== item.message.swipeId) return false;
    return floor.raw === item.message.text
      || markerEntries({ ...item.message, text: floor.raw }).some(entry => entry.key === item.entry.key);
  }
  const automatic = automaticImages({
    mounted: ({ entry }) => { const item = controls.get(entry.key); return Boolean(item && item.registered && !isSifangFloorPending(item.floor.saveId, item.floor.node) && isCurrent(item)); },
    async generate({ entry }, signal) { await controls.get(entry.key)?.control.generateAutomatically(signal); },
  }, () => 1);

  async function update(item: NativeControl): Promise<void> {
    const key = floorKey(item.floor);
    if (isSifangFloorPending(item.floor.saveId, item.floor.node) || item.floor.busy || refused.has(key)
      || item.updating || !item.registered || !item.view || signal.aborted) return;
    item.updating = true;
    try {
      while (!signal.aborted && item.registered && isCurrent(item) && item.view && item.sentRevision !== item.revision) {
        const revision = item.revision;
        const view = item.view;
        const blob = item.pendingBlob;
        await host!.ui.imageMarker({ saveId: item.floor.saveId, node: item.floor.node, id: item.id,
          state: view.state, status: view.status, veiled: view.veiled, ...(blob !== undefined ? { blob } : {}) });
        item.sentRevision = revision;
        if (item.pendingBlob === blob) item.pendingBlob = undefined;
      }
    } catch (error) {
      // The floor went away mid-update. Stop sending its view and let registration retry it.
      refuse(key, item.floor, '', error);
      const entry = registered.get(key);
      if (entry) entry.signature = '';
    }
    finally { item.updating = false; }
  }

  /** Where the host drew a frame, read ten times a second while the desktop pet may fly a picture into it
   *  (a host without the call gives none: the picture goes back into the paintbox). */
  function watchFrame(item: NativeControl): { target(): FloorTarget | null; stop(): void } {
    const ui = host!.ui;
    let latest: FloorTarget | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = typeof ui.imageMarkerRect !== 'function';
    const tick = async () => {
      if (stopped || signal.aborted) return;
      try {
        const box = await ui.imageMarkerRect!({ saveId: item.floor.saveId, node: item.floor.node, id: item.id });
        latest = box ? nativeTarget(box) : null;
      } catch { latest = null; }
      if (!stopped && !signal.aborted) timer = setTimeout(tick, 100);
    };
    void tick();
    return { target: () => latest, stop() { stopped = true; clearTimeout(timer); } };
  }

  async function idFor(key: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return `wp-${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`;
  }

  // Only queued controls are retained. The host owns the pixels once its frame receives them.
  const waiting = new Set<NativeControl>();
  let loading = false;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  function wantLatest(item: NativeControl) {
    if (!item.entry.historyKey) { item.control.restore(undefined); return; }
    waiting.add(item);
    if (!loading && loadTimer === undefined) loadTimer = setTimeout(() => { loadTimer = undefined; void load(); }, 60);
  }
  async function load() {
    loading = true;
    try {
      while (waiting.size && !signal.aborted) {
        const items = [...waiting].slice(0, 3);
        for (const item of items) waiting.delete(item);
        try {
          const keys = [...new Set(items.map(item => item.entry.historyKey!))];
          const entries = inlineImages ? await readServiceMarkerLatest(keys, signal) : await readServiceMarkerSaved(keys, signal);
          for (const item of items) item.control.restore(entries.get(item.entry.historyKey!));
        } catch (error) {
          if (signal.aborted) return;
          report(error);
          for (const item of items) item.control.restore(undefined, error instanceof Error ? error.message : '图片读取失败。');
        }
      }
    } finally { loading = false; }
  }

  async function render(): Promise<void> {
    if (rendering || signal.aborted) return;
    rendering = true;
    try {
      while (dirty && !signal.aborted) {
        dirty = false;
        const ticket = version;
        const enabled = servicePolicy()?.parseImageMarkers !== false;
        const messages = enabled ? readAssistantMessages() : [];
        const floors = new Map(readSifangFloors().map(floor => [floor.floor, floor]));
        const candidates = messages.flatMap(message => markerEntries(message).map(entry => ({ message, entry })));
        const wanted = new Set(candidates.map(item => item.entry.key));
        for (const [key, item] of controls) {
          if (wanted.has(key)) continue;
          waiting.delete(item); item.pendingBlob = undefined; item.registered = false; item.control.dispose(); controls.delete(key);
        }
        const groups = new Map<string, { floor: SifangFloor; items: NativeControl[] }>();
        for (const { message, entry } of candidates) {
          const floor = floors.get(message.messageId);
          if (!floor || floor.raw !== message.text) continue;
          let item = controls.get(entry.key);
          if (!item) {
            const id = await idFor(entry.key);
            if (signal.aborted || ticket !== version) break;
            const created = { id, entry, message, floor, registered: false, updating: false, revision: 0 } as NativeControl;
            const batch = sifangBatchPicture(message.text, entry.historyKey);
            created.control = createSifangImageControl(entry, root, {
              current: () => isCurrent(created),
              pending: () => isSifangFloorPending(created.floor.saveId, created.floor.node),
              latest: () => imageChatContext()?.latestMessageId === created.message.messageId,
              update({ blob, ...view }) {
                if (blob !== undefined) created.pendingBlob = blob;
                created.view = view; ++created.revision; void update(created);
              },
              floor: () => created.message.messageId,
              watch: () => watchFrame(created),
            }, batch?.error ? batch : undefined, options);
            created.needsPicture = !batch?.error;
            controls.set(entry.key, created);
            item = created;
          }
          item.entry = entry; item.message = message; item.floor = floor;
          const groupKey = JSON.stringify([floor.saveId, floor.node]);
          const group = groups.get(groupKey) ?? { floor, items: [] };
          group.items.push(item); groups.set(groupKey, group);
        }
        if (signal.aborted) return;
        if (ticket !== version) { dirty = true; continue; }
        for (const key of refused.keys()) if (!groups.has(key)) forgetRefusal(key);
        for (const [key, previous] of registered) {
          if (groups.has(key)) continue;
          const current = floors.get(previous.floor.floor) ?? (hasSifangFloor(previous.floor) ? previous.floor : undefined);
          // Only a floor that still exists in the active save needs an explicit release;
          // the host drops transient registrations when the save or the floor goes away,
          // and calls for vanished targets are what it answers with a rejection.
          if (current?.saveId === previous.floor.saveId && current.volume === previous.floor.volume
            && current.node === previous.floor.node) {
            await host!.ui.imageMarkers({ saveId: current.saveId, node: current.node, expectedRaw: current.raw, markers: [] }).catch(() => {});
          }
          registered.delete(key);
        }
        for (const [key, { floor, items }] of groups) {
          const markers = items.map(item => ({ id: item.id, start: item.entry.marker.start, end: item.entry.marker.end, summary: item.entry.marker.summary }));
          const signature = JSON.stringify([floor.raw, markers]);
          if (registered.get(key)?.signature !== signature) {
            // A busy or refused floor must not block every other floor's pictures; retry
            // it on the backoff, never once per chat event.
            const refusal = refused.get(key);
            if (floor.busy || refusal && (refusal.signature === signature || Date.now() - refusal.at < REFUSE_RETRY)) continue;
            items.forEach(item => { item.registered = false; });
            try {
              await host!.ui.imageMarkers({ saveId: floor.saveId, node: floor.node, expectedRaw: floor.raw, markers });
            } catch (error) {
              refuse(key, floor, signature, error);
              continue;
            }
            forgetRefusal(key);
            if (signal.aborted) {
              await host!.ui.imageMarkers({ saveId: floor.saveId, node: floor.node, expectedRaw: floor.raw, markers: [] }).catch(() => {});
              return;
            }
            for (const item of items) ++item.revision;
            const replacing = registered.has(key);
            registered.set(key, { floor, signature });
            if (replacing) for (const item of items) if (item.pendingBlob === undefined) void item.control.redisplay();
          }
          if (signal.aborted || ticket !== version) { dirty = true; break; }
          for (const item of items) {
            item.registered = true;
            if (item.needsPicture) { item.needsPicture = false; wantLatest(item); }
            void update(item);
          }
        }
        if (ticket === version && !signal.aborted) {
          const handled = new Set(candidates.filter(({ message, entry }) => sifangBatchPicture(message.text, entry.historyKey))
            .map(({ entry }) => entry.key));
          automatic.update(candidates, enabled, handled);
          if (handled.size) clearSifangBatch();
        }
      }
    } catch (error) { report(error); }
    finally { rendering = false; if (dirty && !signal.aborted) void render(); }
  }
  function schedule() { ++version; dirty = true; void render(); }

  const offImage = host.on('image-marker', value => {
    const event = value as { action?: string; saveId?: string; node?: string; marker?: { id?: string; start?: number; end?: number }; raw?: string } | null;
    if (!event || signal.aborted) return;
    const item = [...controls.values()].find(item => item.id === event.marker?.id && item.floor.saveId === event.saveId && item.floor.node === event.node);
    if (!item || !isCurrent(item) || event.raw !== item.message.text
      || item.entry.marker.start !== event.marker?.start || item.entry.marker.end !== event.marker?.end) return;
    if (event.action === 'generate') void item.control.generate();
    else if (event.action === 'open') item.control.open();
    else if (event.action === 'cancel') item.control.cancel();
  });
  const offChat = watchChatRendering((messageId, _change, event) => {
    // Refusals belong to the departing save.
    if (event === 'CHAT_CHANGED') {
      forgetRefusals(); resetHostNotices();
    }
    // GENERATION_ENDED is included: a floor that stopped being busy may register now.
    if (['CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'GENERATION_ENDED'].includes(event ?? '')) {
      const targeted = event !== 'CHAT_CHANGED' && messageId !== undefined;
      for (const group of registered.values()) {
        if (!targeted || group.floor.floor === messageId) group.signature = '';
      }
      // A refused floor may be writable again, but the backoff still decides when to ask,
      // and the refusal keeps its report so a rewrite cannot repeat the same notice.
      for (const [key, record] of refused) {
        if (!targeted || record.floor === messageId) record.signature = '';
      }
    }
    if (event === 'GENERATION_ENDED' || event === 'GENERATION_STOPPED') automatic.settled();
    schedule();
  });
  const offHistory = onImageHistoryChanged(change => {
    controls.forEach(item => item.control.removeHistory(change));
  });
  window.addEventListener('witch-paintbox:service-changed', () => {
    clearSifangBatch();
    for (const item of controls.values()) {
      item.registered = false;
      item.control.dispose();
    }
    controls.clear();
    waiting.clear();
    forgetRefusals(); resetHostNotices();
    for (const item of registered.values()) item.signature = '';
    schedule();
  }, { signal });
  window.addEventListener('witch-paintbox:model-settings-changed', schedule, { signal });
  window.addEventListener('witch-paintbox:preferences-changed', () => {
    const next = options.inlineImages?.() !== false;
    if (next !== inlineImages) {
      inlineImages = next;
      for (const item of controls.values()) { item.registered = false; item.control.dispose(); }
      controls.clear(); waiting.clear();
      for (const item of registered.values()) item.signature = '';
    }
    schedule();
  }, { signal });
  window.addEventListener('storage', schedule, { signal });
  signal.addEventListener('abort', () => {
    ++version; offImage(); offChat(); offHistory(); automatic.dispose();
    clearTimeout(loadTimer); clearSifangBatch(); waiting.clear();
    for (const item of controls.values()) { item.registered = false; item.control.dispose(); }
    controls.clear();
    for (const { floor } of registered.values()) {
      void host.ui.imageMarkers({ saveId: floor.saveId, node: floor.node, expectedRaw: floor.raw, markers: [] }).catch(() => {});
    }
    registered.clear();
    forgetRefusals();
  }, { once: true });
  schedule();
}
