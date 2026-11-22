import { imageChatContext, readAssistantMessages, watchChatRendering } from './chat-host.js';
import { servicePolicy } from './service-runtime.js';
import { markerEntries, type MarkerEntry, type AssistantImageMessage } from './image-marker-history.js';
import { automaticImages } from './automatic-images.js';
import { onImageHistoryChanged, type ImageHistoryEntry } from './image-history.js';
import { createSifangImageControl, type NativeImageView } from './sifang-image-control.js';
import { readServiceMarkerLatest, readServiceMarkerSaved } from './service-client.js';
import type { WireHistoryEntry } from './service-protocol.js';
import { sifangHost, type SifangFloor } from './sifang-host.js';
import { readSifangFloor, readSifangFloors, isSifangFloorPending } from './sifang-chat.js';
import { clearSifangBatch, sifangBatchPicture } from './sifang-batch.js';
import { nativeTarget, type FloorTarget } from './pet-targets.js';

interface NativeControl {
  id: string;
  entry: MarkerEntry;
  message: AssistantImageMessage;
  floor: SifangFloor;
  registered: boolean;
  view?: NativeImageView;
  lastBlob?: Blob | null;
  updating: boolean;
  revision: number;
  control: ReturnType<typeof createSifangImageControl>;
}

/** Render through the host's real paragraph blocks, while keeping the existing plugin image lifecycle. */
export function bindSifangImages(root: ShadowRoot, signal: AbortSignal): void {
  const host = sifangHost;
  if (!host || signal.aborted) return;
  const controls = new Map<string, NativeControl>();
  const registered = new Map<string, { floor: SifangFloor; signature: string }>();
  // Registrations the host refused (floor gone, save switched, or still generating).
  // They are retried only when that floor itself changes, never on every render.
  const rejected = new Map<string, { signature: string; floor: number }>();
  let version = 0;
  let rendering = false;
  let dirty = false;
  let errorText = '';

  const report = (error: unknown) => {
    if (signal.aborted) return;
    const text = error instanceof Error ? error.message : '配图显示接口未能完成操作。';
    if (text === errorText) return;
    errorText = text;
    void host.ui.toast(text, 'fail').catch(() => {});
  };
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
    if (isSifangFloorPending(item.floor.saveId, item.floor.node) || item.floor.busy || item.updating || !item.registered || !item.view || signal.aborted) return;
    item.updating = true;
    try {
      let sent = -1;
      while (!signal.aborted && item.registered && isCurrent(item) && item.view && sent !== item.revision) {
        sent = item.revision;
        const view = item.view;
        const sendBlob = view.blob !== item.lastBlob;
        await host!.ui.imageMarker({ saveId: item.floor.saveId, node: item.floor.node, id: item.id,
          state: view.state, status: view.status, veiled: view.veiled, ...(sendBlob ? { blob: view.blob } : {}) });
        if (sendBlob) item.lastBlob = view.blob;
      }
    } catch (error) { report(error); }
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

  /** Restoring a whole chat used to cost one request per marker; with thousands of floors even
   * batched pictures would exhaust memory, so only the latest floor moves image bytes. */
  const restored = new Map<string, ImageHistoryEntry | undefined>();
  const saved = new Map<string, WireHistoryEntry | undefined>();
  const embedKeys = new Set<string>();
  const metaKeys = new Set<string>();
  const waitingControls = new Map<string, Set<NativeControl>>();
  let loading = false;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const EMBED_CHUNK = 12;
  const META_CHUNK = 256;
  function wantLatest(item: NativeControl): void {
    const key = item.entry.historyKey;
    if (!key) { item.control.restore(undefined); return; }
    if (restored.has(key)) { item.control.restore(restored.get(key)); return; }
    if (saved.has(key)) { item.control.restoreSaved(saved.get(key) !== undefined); return; }
    const waiters = waitingControls.get(key);
    if (waiters) { waiters.add(item); return; } // Already queued or in flight.
    waitingControls.set(key, new Set([item]));
    (item.message.messageId === imageChatContext()?.latestMessageId ? embedKeys : metaKeys).add(key);
    if (!loading && loadTimer === undefined) loadTimer = setTimeout(() => { loadTimer = undefined; void load(); }, 60);
  }
  async function load(): Promise<void> {
    if (loading || signal.aborted) return;
    loading = true;
    try {
      while (!signal.aborted && (embedKeys.size || metaKeys.size)) {
        const embed = embedKeys.size > 0; // The latest floor's pictures come first.
        const source = embed ? embedKeys : metaKeys;
        const chunk = [...source].slice(0, embed ? EMBED_CHUNK : META_CHUNK);
        chunk.forEach(key => source.delete(key));
        try {
          if (embed) {
            const groups = await readServiceMarkerLatest(chunk, signal);
            for (const key of chunk) {
              const entry = groups.get(key);
              restored.set(key, entry);
              saved.set(key, entry);
              waitingControls.get(key)?.forEach(item => item.control.restore(entry));
              waitingControls.delete(key);
            }
          } else {
            const groups = await readServiceMarkerSaved(chunk, signal);
            for (const key of chunk) {
              const meta = groups.get(key);
              saved.set(key, meta);
              waitingControls.get(key)?.forEach(item => item.control.restoreSaved(meta !== undefined));
              waitingControls.delete(key);
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          report(error);
          const text = error instanceof Error ? error.message : '图片读取失败。';
          for (const key of chunk) {
            waitingControls.get(key)?.forEach(item => {
              if (embed) item.control.restore(undefined, text);
              else item.control.restoreSaved(false, text);
            });
            waitingControls.delete(key);
          }
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
          item.registered = false; item.control.dispose(); controls.delete(key);
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
              update(view) { created.view = view; ++created.revision; void update(created); },
              floor: () => created.message.messageId,
              watch: () => watchFrame(created),
            }, batch);
            controls.set(entry.key, created);
            // A batch picture already seeded the control; otherwise it joins the shared restore queue.
            if (!batch) wantLatest(created);
            item = created;
          }
          item.entry = entry; item.message = message; item.floor = floor;
          const groupKey = JSON.stringify([floor.saveId, floor.node]);
          const group = groups.get(groupKey) ?? { floor, items: [] };
          group.items.push(item); groups.set(groupKey, group);
        }
        if (signal.aborted) return;
        if (ticket !== version) { dirty = true; continue; }
        for (const [key, previous] of registered) {
          if (groups.has(key)) continue;
          const current = floors.get(previous.floor.floor);
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
            // only after this floor changes (its text, or an event naming it).
            if (floor.busy || rejected.get(key)?.signature === signature) continue;
            items.forEach(item => { item.registered = false; });
            try {
              await host!.ui.imageMarkers({ saveId: floor.saveId, node: floor.node, expectedRaw: floor.raw, markers });
            } catch (error) {
              rejected.set(key, { signature, floor: floor.floor });
              report(error);
              continue;
            }
            rejected.delete(key);
            if (signal.aborted) {
              await host!.ui.imageMarkers({ saveId: floor.saveId, node: floor.node, expectedRaw: floor.raw, markers: [] }).catch(() => {});
              return;
            }
            registered.set(key, { floor, signature });
            items.forEach(item => { item.lastBlob = undefined; });
          }
          if (signal.aborted || ticket !== version) { dirty = true; break; }
          items.forEach(item => { item.registered = true; void update(item); });
        }
        if (ticket === version && !signal.aborted) {
          const handled = new Set(candidates.filter(({ message, entry }) => sifangBatchPicture(message.text, entry.historyKey))
            .map(({ entry }) => entry.key));
          automatic.update(candidates, enabled, handled);
          if (handled.size) clearSifangBatch();
          errorText = '';
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
    // A different save's keys never match this chat again; drop its queues without
    // disturbing the departing controls, which the next render disposes anyway.
    if (event === 'CHAT_CHANGED') {
      restored.clear(); saved.clear(); embedKeys.clear(); metaKeys.clear(); waitingControls.clear(); rejected.clear();
    }
    // GENERATION_ENDED is included: a floor that stopped being busy may register now.
    if (['CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'GENERATION_ENDED'].includes(event ?? '')) {
      const targeted = event !== 'CHAT_CHANGED' && messageId !== undefined;
      for (const group of registered.values()) {
        if (!targeted || group.floor.floor === messageId) group.signature = '';
      }
      for (const [key, record] of rejected) {
        if (!targeted || record.floor === messageId) rejected.delete(key);
      }
    }
    if (event === 'GENERATION_ENDED' || event === 'GENERATION_STOPPED') automatic.settled();
    schedule();
  });
  const offHistory = onImageHistoryChanged(change => {
    // Saved or cleaned images make the cached newest pictures stale; deletions only drop the affected keys.
    if (change.savedId !== undefined || change.before !== undefined) { restored.clear(); saved.clear(); }
    else if (change.deletedIds?.length) {
      const deleted = new Set(change.deletedIds);
      for (const [key, entry] of restored) if (entry && deleted.has(entry.id)) restored.set(key, undefined);
      for (const [key, entry] of saved) if (entry && deleted.has(entry.id)) saved.set(key, undefined);
    }
    controls.forEach(item => item.control.removeHistory(change));
  });
  window.addEventListener('witch-paintbox:service-changed', () => {
    clearSifangBatch();
    for (const item of controls.values()) {
      item.registered = false;
      item.control.dispose();
    }
    controls.clear();
    restored.clear(); saved.clear(); embedKeys.clear(); metaKeys.clear(); waitingControls.clear(); rejected.clear();
    for (const item of registered.values()) item.signature = '';
    schedule();
  }, { signal });
  window.addEventListener('witch-paintbox:model-settings-changed', schedule, { signal });
  window.addEventListener('witch-paintbox:preferences-changed', schedule, { signal });
  window.addEventListener('storage', schedule, { signal });
  signal.addEventListener('abort', () => {
    ++version; offImage(); offChat(); offHistory(); automatic.dispose();
    clearTimeout(loadTimer);
    for (const item of controls.values()) { item.registered = false; item.control.dispose(); }
    controls.clear();
    for (const { floor } of registered.values()) {
      void host.ui.imageMarkers({ saveId: floor.saveId, node: floor.node, expectedRaw: floor.raw, markers: [] }).catch(() => {});
    }
    registered.clear();
  }, { once: true });
  schedule();
}
