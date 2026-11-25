import { bindContextFilter } from './context-filter.js';
import { autoProcessReplies } from './auto-process.js';
import { ChatProcessor } from './chat-processor.js';
import { bindImageHistorySync } from './image-history.js';
import { bindLocalPreferences, currentPreferences, extensionId, readSettings, saveSettings } from './settings.js';
import { bindSettingsEntry } from './settings-entry.js';
import { bindServiceRuntime } from './service-runtime.js';
import { bindServiceSettings, serviceSettingsView } from './service-settings.js';
import { initializeSifangChat } from './sifang-chat.js';
import { bindSifangImages } from './sifang-images.js';
import { bindSifangWindowViewport, sifangHost } from './sifang-host.js';
import { bindPanelViewport } from './panel-viewport.js';
/** Native-only client: no pet, launcher, library editor or persistent hidden settings tree. */
export async function mountSifangClient() {
    if (document.getElementById(extensionId))
        return;
    if (document.readyState === 'loading')
        await new Promise(resolve => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
    const controller = new AbortController();
    const { signal } = controller;
    const context = SillyTavern.getContext();
    bindLocalPreferences(context, signal);
    const host = document.createElement('div');
    host.id = extensionId;
    const root = host.attachShadow({ mode: 'open' });
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('../style.css', import.meta.url).href;
    root.append(stylesheet);
    document.body.append(host);
    let panel;
    let panelLife;
    let pageLife;
    let review;
    let picker;
    let pickerLife;
    let openingPicker = false;
    let opener;
    let page = 'preferences';
    let viewVersion = 0;
    let statusText = '';
    let statusError = false;
    let cancellable = true;
    function report(message, busy, error = false, canCancel = true) {
        statusText = message;
        statusError = error;
        cancellable = canCancel;
        picker?.report(message, busy, error, canCancel);
        updateStatus(busy);
        if (error && !panel?.open && !picker)
            void sifangHost?.ui.toast(message, 'fail').catch(() => { });
    }
    const processor = new ChatProcessor(report);
    function updateStatus(busy = processor.busy) {
        const status = panel?.querySelector('[data-task-status]');
        if (status) {
            status.textContent = statusText;
            status.classList.toggle('is-error', statusError);
        }
        panel?.querySelectorAll('[data-process], [data-select]').forEach(button => { button.disabled = busy || openingPicker; });
        const cancel = panel?.querySelector('[data-cancel]');
        if (cancel) {
            cancel.hidden = !busy;
            cancel.disabled = !cancellable;
        }
    }
    function releasePage() {
        ++viewVersion;
        pageLife?.abort();
        pageLife = undefined;
        review?.unmount();
        review = undefined;
        panel?.querySelector('.content')?.replaceChildren();
    }
    function releasePanel() {
        releasePage();
        panelLife?.abort();
        panelLife = undefined;
        panel?.remove();
        panel = undefined;
    }
    async function navigate(next) {
        if (!panel || signal.aborted)
            return;
        releasePage();
        page = next;
        const ticket = viewVersion;
        const life = new AbortController();
        pageLife = life;
        const content = panel.querySelector('.content');
        panel.querySelectorAll('[data-page]').forEach(button => {
            if (button.dataset.page === page)
                button.setAttribute('aria-current', 'page');
            else
                button.removeAttribute('aria-current');
        });
        if (page === 'preferences') {
            content.innerHTML = serviceSettingsView() + `<section class="preference-section">
        <h2 class="section-title">图片显示</h2>
        <label class="preference-row"><span><strong>正文内显示图片</strong><span>默认关闭。图片留在独立服务，需要时从生图回顾查看；开启后会增加内存占用。</span></span>
          <input type="checkbox" name="sifangInlineImages" ${currentPreferences().sifangInlineImages ? 'checked' : ''}></label>
      </section>`;
            bindServiceSettings(content.querySelector('[data-paintbox-service]'), life.signal);
        }
        else {
            content.textContent = '正在读取生图回顾…';
            try {
                const { ImageReview } = await import('./image-review.js');
                if (life.signal.aborted || signal.aborted || ticket !== viewVersion || !panel?.open)
                    return;
                content.replaceChildren();
                review = new ImageReview(1);
                review.mount(content);
            }
            catch (error) {
                if (!life.signal.aborted)
                    content.textContent = error instanceof Error ? error.message : '生图回顾加载失败。';
            }
        }
    }
    function openPanel(button) {
        if (signal.aborted || panel?.open || openingPicker || picker)
            return;
        opener = button;
        panelLife = new AbortController();
        const life = panelLife;
        panel = document.createElement('dialog');
        panel.id = 'image-plugin-panel';
        panel.className = 'panel native-client';
        panel.setAttribute('aria-label', '魔女画匣');
        panel.innerHTML = `<div class="shell">
      <header class="window-header"><div class="window-brand"><h1>魔女画匣</h1></div>
        <button type="button" class="close-button" aria-label="关闭魔女画匣">×</button></header>
      <div class="actions native-client-actions">
        <button type="button" class="primary" data-process>AI生图</button>
        <button type="button" class="secondary" data-select>指定插图</button>
        <button type="button" class="secondary" data-cancel hidden>取消处理</button>
        <p role="status" data-task-status></p>
      </div>
      <div class="workspace"><nav class="sidebar" aria-label="插件导航">
        <button type="button" class="nav-item" data-page="preferences">服务连接</button>
        <button type="button" class="nav-item" data-page="review">生图回顾</button>
      </nav><main class="content" tabindex="-1"></main></div>
    </div>`;
        root.append(panel);
        const viewport = bindPanelViewport(panel, life.signal);
        panel.addEventListener('click', event => {
            const target = event.target.closest('button');
            if (!target)
                return;
            if (target.classList.contains('close-button'))
                panel?.close();
            else if (target.hasAttribute('data-process'))
                void processor.process();
            else if (target.hasAttribute('data-cancel'))
                processor.cancel();
            else if (target.hasAttribute('data-select'))
                void openPicker();
            else if (target.dataset.page === 'preferences' || target.dataset.page === 'review')
                void navigate(target.dataset.page);
        }, { signal: life.signal });
        panel.addEventListener('change', event => {
            const input = event.target;
            if (!(input instanceof HTMLInputElement) || input.name !== 'sifangInlineImages')
                return;
            const settings = readSettings(context);
            settings.sifangInlineImages = input.checked;
            try {
                saveSettings(context, settings);
            }
            catch (error) {
                input.checked = !input.checked;
                report(error instanceof Error ? error.message : '设置未能保存。', processor.busy, true);
            }
        }, { signal: life.signal });
        panel.addEventListener('close', () => {
            releasePanel();
            if (!openingPicker && opener?.isConnected)
                opener.focus({ preventScroll: true });
        }, { signal: life.signal });
        panel.showModal();
        viewport.refresh();
        void navigate(page);
        updateStatus();
    }
    async function openPicker() {
        if (processor.busy || openingPicker || picker || !opener)
            return;
        openingPicker = true;
        updateStatus();
        const from = opener;
        panel?.close();
        try {
            const { bindIllustrationPicker } = await import('./illustration-picker.js');
            if (signal.aborted)
                return;
            const life = new AbortController();
            pickerLife = life;
            picker = bindIllustrationPicker(root, life.signal, processor);
            const dialog = root.querySelector('.illustration-picker');
            dialog.addEventListener('close', () => {
                life.abort();
                picker = undefined;
                pickerLife = undefined;
            }, { once: true, signal: life.signal });
            picker.open(from);
        }
        catch (error) {
            report(error instanceof Error ? error.message : '指定插图加载失败。', false, true);
        }
        finally {
            openingPicker = false;
            updateStatus();
        }
    }
    bindSettingsEntry(openPanel, signal);
    bindImageHistorySync(signal);
    window.addEventListener('pagehide', event => { if (!event.persisted)
        controller.abort(); }, { signal });
    signal.addEventListener('abort', () => {
        processor.cancel();
        pickerLife?.abort();
        picker = undefined;
        releasePanel();
        host.remove();
    }, { once: true });
    await bindSifangWindowViewport(signal);
    await bindServiceRuntime(signal);
    bindContextFilter(signal);
    try {
        await initializeSifangChat(signal);
        if (signal.aborted)
            return;
        bindSifangImages(root, signal, { inlineImages: () => currentPreferences().sifangInlineImages, pet: false });
        autoProcessReplies(processor, signal, message => report(message, false, true));
    }
    catch (error) {
        report(error instanceof Error ? error.message : '原生配图接口未能初始化。', false, true);
    }
}
