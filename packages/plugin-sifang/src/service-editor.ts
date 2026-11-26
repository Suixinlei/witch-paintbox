import { AnchorConfig } from './anchor-config.js';
import { registerBuiltinLayers } from './builtin-layers.js';
import { ConfigTransfer } from './config-transfer.js';
import { initializeNativeLibraries } from './host-library.js';
import { initializeSettingsStorage } from './host-settings.js';
import { initializeEditorStorage } from './host-storage.js';
import { ImageConfig } from './image-config.js';
import { bindImageHistorySync } from './image-history.js';
import { IMAGE_PROVIDERS } from './image-settings.js';
import { ModelConfig } from './model-config.js';
import { bindPaintboxTheme } from './paintbox-theme.js';
import { bindServiceConfig, initializeServiceDraft, pullServiceConfig, serviceConfigStatus } from './service-config.js';
import { sendService, setEditorConnection, type ServiceConnection } from './service-client.js';
import { bindLocalPreferences, defaultSettings, isPaintboxTheme, readAutoImageDelay, readPetScale, readSettings, saveSettings } from './settings.js';
import { clientAppearanceView, imageWorkflowView, workflowStatus } from './views.js';

export async function mountServiceEditor(container: HTMLElement, connection: ServiceConnection,
  options: { css?: string } = {}): Promise<() => void> {
  setEditorConnection(connection);
  initializeEditorStorage();
  await Promise.all([initializeSettingsStorage(), initializeNativeLibraries()]);
  const context = { extensionSettings: {} };
  const controller = new AbortController();
  const { signal } = controller;
  bindLocalPreferences(context, signal);
  bindServiceConfig(context, signal);
  const root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
  let cleanup = () => {};
  try {
    const { revision } = await (await sendService('health', null, signal)).json();
    if (revision) await pullServiceConfig(signal);
    else initializeServiceDraft(connection);
    const unregisterLayers = registerBuiltinLayers();
    const image = new ImageConfig();
    const model = new ModelConfig();
    let anchors = new AnchorConfig();
    let outfits = new AnchorConfig();
    const select = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
    const preferenceFields = () => {
      const settings = readSettings(context);
      select('#service-workflow-fields').innerHTML = imageWorkflowView(settings);
      select('#service-appearance-fields').innerHTML = clientAppearanceView(settings);
    };
    const transfer = new ConfigTransfer(context, (kind, provider) => {
      if (kind === 'all' || kind === 'artists') image.reloadSaved(kind === 'artists');
      if (kind === 'presets') model.reloadSaved('presets', provider);
      if (kind === 'worldbooks') for (const channel of IMAGE_PROVIDERS) model.reloadSaved('worldbooks', channel);
      if (kind === 'all') {
        model.reloadSaved();
        anchors.destroy();
        outfits.destroy();
        anchors = new AnchorConfig();
        outfits = new AnchorConfig();
        mountLibraries();
        preferenceFields();
        refreshTheme();
        window.dispatchEvent(new Event('witch-paintbox:preferences-changed'));
      }
    }, () => image.hasPendingWrites || model.hasPendingWrites || anchors.hasPendingWrites || outfits.hasPendingWrites
      ? '请等待当前配置保存或角色图生成完成后再导入。' : undefined);
    const mountLibraries = () => {
      anchors.mount(select('#service-anchor-fields'), 'anchors', true);
      outfits.mount(select('#service-outfit-fields'), 'shared-outfits', true);
    };
    bindImageHistorySync(signal);
    root.innerHTML = `
      <section class="service-inline" aria-label="全局配置编辑">
        <p data-editor-status class="config-status service-sync" role="status"></p>
        <section id="service-image" class="service-editor-panel"><div data-image-settings></div></section>
        <div data-model-settings></div>
        <section id="service-anchors" data-editor-page="anchors" class="service-editor-panel"><div id="service-anchor-fields"></div></section>
        <section id="service-outfits" data-editor-page="outfits" class="service-editor-panel"><div id="service-outfit-fields"></div></section>
        <section id="service-workflow" data-editor-page="workflow" class="service-editor-panel"><h3>四方自动配图与图片留存</h3><div id="service-workflow-fields"></div></section>
        <section id="service-appearance" data-editor-page="preferences" class="service-editor-panel"><h3>客户端外观</h3><div id="service-appearance-fields"></div></section>
        <section id="service-transfer" data-editor-page="preferences" class="service-editor-panel"><h3>全局配置导入与导出</h3><div data-config-transfer></div></section>
      </section>`;
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    if (options.css === undefined) stylesheet.href = new URL('../style.css', import.meta.url).href;
    const loaded = new Promise<void>((resolve, reject) => {
      stylesheet.addEventListener('load', () => resolve(), { once: true });
      stylesheet.addEventListener('error', () => reject(new Error('全局配置样式未能加载。')), { once: true });
    });
    if (options.css !== undefined) {
      const style = document.createElement('style');
      style.textContent = options.css;
      root.prepend(style);
    } else root.prepend(stylesheet);
    cleanup = () => {
      image.destroy();
      model.destroy();
      anchors.destroy();
      outfits.destroy();
      transfer.unmount();
      unregisterLayers();
    };
    const refreshTheme = bindPaintboxTheme(container, () => readSettings(context).paintboxTheme, signal);
    const showStatus = () => { select('[data-editor-status]').textContent = serviceConfigStatus(); };
    window.addEventListener('witch-paintbox:service-config-status', showStatus, { signal });
    showStatus();
    image.mount(select('[data-image-settings]'));
    model.mount(select('[data-model-settings]'), 'service');
    mountLibraries();
    preferenceFields();
    transfer.mount(select('[data-config-transfer]'));

    const setScale = (value: number) => {
      const settings = readSettings(context);
      settings.petScale = readPetScale(value);
      const percent = String(Math.round(settings.petScale * 100));
      const slider = select<HTMLInputElement>('[name="petScale"]');
      slider.value = percent;
      slider.setAttribute('aria-valuetext', percent + '%');
      select<HTMLOutputElement>('[data-pet-scale-value]').value = percent + '%';
      saveSettings(context, settings);
    };
    root.addEventListener('click', event => {
      if (!(event.target instanceof Element) || transfer.isApplying) return;
      const button = event.target.closest<HTMLButtonElement>('button');
      if (!button) return;
      const { serviceJump, page, action } = button.dataset;
      if (serviceJump === 'worldbooks') location.hash = 'worldbooks';
      else if (page === 'model-api') location.hash = 'prompts';
      else if (page === 'features') location.hash = 'anchors';
      else if (action === 'reset-pet-scale') setScale(1);
      else if (action === 'reset-image-workflow') {
        const settings = readSettings(context);
        const defaults = defaultSettings();
        for (const key of ['autoProcessReplies', 'autoGenerateImages', 'autoImageDelay', 'imageRetentionDays'] as const) {
          Object.assign(settings, { [key]: defaults[key] });
        }
        saveSettings(context, settings);
        select('#service-workflow-fields').innerHTML = imageWorkflowView(settings);
        select('#service-workflow [data-feedback]').textContent = '已恢复默认生图设置。';
        select('#service-workflow [data-action="reset-image-workflow"]').focus();
      }
    }, { signal });
    root.addEventListener('input', event => {
      const field = event.target;
      if (!transfer.isApplying && field instanceof HTMLInputElement && field.name === 'petScale') setScale(Number(field.value) / 100);
    }, { signal });
    root.addEventListener('change', event => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
      if (transfer.isApplying) {
        if (field.closest('#service-workflow, #service-appearance')) preferenceFields();
        return;
      }
      const settings = readSettings(context);
      if (field instanceof HTMLInputElement) {
        if (field.name === 'autoImageDelay') {
          settings.autoImageDelay = readAutoImageDelay(field.valueAsNumber) ?? settings.autoImageDelay;
          field.value = String(settings.autoImageDelay);
        } else if (field.name === 'autoProcessReplies' || field.name === 'autoGenerateImages' || field.name === 'petLines' || field.name === 'petMotion') {
          settings[field.name] = field.checked;
        } else return;
      } else if (field.name === 'imageRetentionDays') {
        const value = Number(field.value);
        if (value !== 0 && value !== 1 && value !== 3 && value !== 7) return;
        settings.imageRetentionDays = value;
      } else if (field.name === 'paintboxTheme' && isPaintboxTheme(field.value)) settings.paintboxTheme = field.value;
      else return;
      saveSettings(context, settings);
      select('[data-workflow-status]').textContent = workflowStatus(settings);
      refreshTheme();
    }, { signal });
    window.addEventListener('pagehide', event => {
      image.maskKey();
      model.maskKey();
      if (event.persisted) return;
      controller.abort();
      cleanup();
    }, { signal });
    if (options.css === undefined) await loaded;
    return () => { controller.abort(); cleanup(); root.replaceChildren(); };
  } catch (error) {
    controller.abort();
    cleanup();
    root.replaceChildren();
    throw error;
  }
}
