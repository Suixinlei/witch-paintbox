import { assertChatSnapshot, captureLatestAssistant, imageChatContext, replaceAssistantMessage } from './chat-host.js';
import { applyImageInsertions, createImageInsertionPlan, createSelectedImageInsertionPlan, selectImageInsertionPoints } from './image-insertion.js';
import { normalizeIllustrationItems } from './illustration-selection.js';
import { MAX_IMAGE_MARKERS, parseImageMarkers } from './image-markers.js';
import { isImageSizeModeSaving, loadModelSettings } from './model-settings.js';
import { runConfiguredModel } from './model-service.js';
import { stageSifangBatch } from './sifang-batch.js';
import { notifyImageHistorySaved } from './image-history.js';
import { imagePlanningInput } from './image-planning.js';
import { isSifangEnvironment } from './sifang-host.js';
import { captureSifangAssistant, readSifangFloor, sifangSnapshotNode } from './sifang-chat.js';
import { emitPetEvent, petFault, petTaskId, withFault } from './pet-events.js';
import { imageSizeMode } from './image-size-mode.js';
import { currentPreferences } from './settings.js';
function processingSettings() {
    if (isImageSizeModeSaving())
        throw withFault(new Error('画幅模式正在同步，请完成后再开始 AI 生图。'), 'setup');
    const settings = loadModelSettings();
    if (!settings.parseImageMarkers)
        throw withFault(new Error('请先在模型 API 预设区开启“解析配图标记”。'), 'setup');
    if (![...settings.head, ...settings.tail].some(entry => entry.enabled && !entry.marker && entry.content.trim())) {
        throw withFault(new Error('请先导入或填写处理正文的预设，并保存配置。'), 'setup');
    }
    return settings;
}
async function captureSelection(targeted = false, expected) {
    const snapshot = expected ?? await captureLatestAssistant();
    const { excludedTags } = currentPreferences();
    const plan = targeted ? createSelectedImageInsertionPlan(snapshot.text, excludedTags) : createImageInsertionPlan(snapshot.text, excludedTags);
    if (!plan.points.length)
        throw withFault(new Error('当前正文没有可用的行间插入点。'), 'format');
    const capacity = MAX_IMAGE_MARKERS - parseImageMarkers(snapshot.text).length;
    if (!capacity)
        throw withFault(new Error('当前楼层已有 64 处图片标记，请先移除部分标记。'), 'format');
    return Object.freeze({ snapshot, plan, capacity });
}
export class ChatProcessor {
    report;
    request = null;
    committing = false;
    constructor(report) {
        this.report = report;
    }
    get busy() { return this.request !== null; }
    cancel() { if (!this.committing)
        this.request?.abort(); }
    async prepareSelection(target) {
        if (this.busy)
            throw new Error('请先完成或取消当前 AI 处理。');
        if (!isSifangEnvironment())
            processingSettings();
        const selection = await captureSelection(true, target && await captureSifangAssistant(target));
        if (this.busy)
            throw new Error('请先完成或取消当前 AI 处理。');
        return selection;
    }
    async process(selection, options = {}) {
        if (this.request)
            return false;
        const controller = new AbortController();
        const cancel = () => { if (!this.committing)
            controller.abort(); };
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted)
            cancel();
        this.request = controller;
        const pet = petTaskId();
        let floor;
        let discardBatch;
        this.report('正在核对回复…', true);
        emitPetEvent({ type: 'process', id: pet, phase: 'reading', cancellable: true });
        try {
            const native = isSifangEnvironment();
            const settings = native ? undefined : processingSettings();
            controller.signal.throwIfAborted();
            const prepared = selection ?? (native ? undefined : await captureSelection(false, options.snapshot));
            const snapshot = prepared?.snapshot ?? options.snapshot ?? await captureLatestAssistant();
            if (prepared && prepared.plan.original !== snapshot.text) {
                throw withFault(new Error('所选正文已变化，请重新打开指定插图。'), 'format');
            }
            if (selection || options.snapshot)
                await assertChatSnapshot(snapshot);
            controller.signal.throwIfAborted();
            this.report(`正在处理第 ${snapshot.messageId + 1} 楼…`, true);
            floor = snapshot.messageId;
            emitPetEvent({ type: 'process', id: pet, phase: 'thinking', floor, cancellable: true });
            let result;
            if (native) {
                const { requestServicePlan } = await import('./service-client.js');
                const preferences = currentPreferences();
                let draw;
                if (options.draw === 'manual' || (options.draw && preferences.autoGenerateImages)) {
                    const context = imageChatContext();
                    const historyId = sifangSnapshotNode(snapshot);
                    if (!context || context.chatId !== snapshot.chatId || !historyId)
                        throw withFault(new Error('当前楼层无法确认配图身份，请重新打开存档。'), 'host');
                    draw = { scope: context.scope, chatId: context.chatId, historyId,
                        sourceName: context.name, delay: options.draw === 'manual' ? 0 : preferences.autoImageDelay };
                }
                const reply = await requestServicePlan({
                    original: snapshot.text, excludedTags: preferences.excludedTags, items: selection?.items, draw,
                }, controller.signal);
                result = reply.result;
                if (draw && readSifangFloor(snapshot.messageId)?.node === sifangSnapshotNode(snapshot))
                    discardBatch = stageSifangBatch(result.text, reply.pictures);
            }
            else {
                const original = prepared.plan;
                const items = selection ? normalizeIllustrationItems(original, selection.items) : undefined;
                const plan = items ? selectImageInsertionPoints(original, items.flatMap(item => [...item.pointIds])) : original;
                const candidate = await runConfiguredModel({
                    messages: [{ role: 'user', content: imagePlanningInput(plan, items) }], sourceText: snapshot.text, signal: controller.signal,
                }, text => {
                    this.report(`AI 处理中 · 已返回 ${text.length} 字符`, true);
                    emitPetEvent({ type: 'process', id: pet, phase: 'thinking', floor, chars: text.length, cancellable: true });
                }, settings);
                result = applyImageInsertions(plan, candidate, items);
            }
            controller.signal.throwIfAborted();
            if (!result.added.length)
                throw withFault(new Error('AI 未返回配图数据，原文未变。'), 'format');
            this.committing = true;
            this.report('正在按插入点保存配图标记…', true, false, false);
            emitPetEvent({ type: 'process', id: pet, phase: 'saving', floor, cancellable: false });
            await replaceAssistantMessage(snapshot, result, controller.signal);
            if (discardBatch) {
                discardBatch = undefined;
                notifyImageHistorySaved('sifang-batch');
            }
            const fallbackCount = settings && imageSizeMode(settings) === 'ai' ? result.added.filter(marker => !marker.size).length : 0;
            const sizeNotice = fallbackCount ? `其中 ${fallbackCount} 处未提供有效尺寸，生图时使用设置中的画幅。` : result.warnings.join(' ');
            const pictures = 'pictures' in result && Array.isArray(result.pictures) ? result.pictures : null;
            const failures = pictures?.filter(picture => !picture.entry || picture.error).length ?? 0;
            const drawn = pictures ? ` 已返回 ${pictures.filter(picture => picture.entry).length} 张图片。${failures ? `有 ${failures} 张生成或保存遇到问题，可在画框查看。` : ''}` : '';
            const message = `已保存 ${result.added.length} 处配图标记，原正文与 HTML 前端已保留。${sizeNotice}${drawn}`;
            this.report(message, false);
            emitPetEvent({ type: 'end', id: pet, task: 'process', result: 'done', floor, added: result.added.length, message });
            return true;
        }
        catch (error) {
            const aborted = controller.signal.aborted;
            const message = aborted ? '已取消 AI 处理。' : error.message;
            this.report(message, false, !aborted);
            emitPetEvent({ type: 'end', id: pet, task: 'process', result: aborted ? 'cancelled' : 'failed', floor, message,
                fault: aborted ? undefined : petFault(error) });
            return false;
        }
        finally {
            discardBatch?.();
            options.signal?.removeEventListener('abort', cancel);
            this.committing = false;
            if (this.request === controller)
                this.request = null;
        }
    }
}
