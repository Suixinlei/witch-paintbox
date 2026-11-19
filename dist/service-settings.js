import { migrateServiceConfig, pullServiceConfig, serviceConfigStatus } from './service-config.js';
import { importServiceImages, loadServiceConnection, saveServiceConnection } from './service-client.js';
import { loadLocalImageHistoryPage, notifyImageHistorySaved } from './image-history.js';
export function serviceSettingsView() {
    return `<section class="preference-section image-settings" aria-labelledby="paintbox-service-heading" data-paintbox-service>
    <header class="section-heading section-heading--plain">
      <h3 id="paintbox-service-heading" class="section-title">魔女画匣独立服务</h3>
      <p class="section-description">连接后先迁移 API 配置与资料库。之后在画匣中保存的配置会同步到服务，图片历史保存在运行服务的设备上。</p>
    </header>
    <label class="config-field"><span>服务地址</span>
      <input name="paintboxServiceUrl" type="url" placeholder="http://127.0.0.1:4783" autocomplete="off"></label>
    <label class="config-field"><span>访问令牌</span>
      <input name="paintboxServiceToken" type="password" autocomplete="off" spellcheck="false"></label>
    <div class="actions">
      <button type="button" class="secondary" data-service-action="connect">测试并保存</button>
      <button type="button" class="secondary" data-service-action="upload">迁移当前配置与资料库</button>
      <button type="button" class="secondary" data-service-action="download">读取服务配置并替换当前配置</button>
      <button type="button" class="secondary" data-service-action="migrate">复制旧图片历史</button>
    </div>
    <p class="config-status" role="status" data-service-status></p>
  </section>`;
}
export function bindServiceSettings(container, signal) {
    const url = container.querySelector('[name="paintboxServiceUrl"]');
    const token = container.querySelector('[name="paintboxServiceToken"]');
    const status = container.querySelector('[data-service-status]');
    const connect = container.querySelector('[data-service-action="connect"]');
    const actions = Array.from(container.querySelectorAll('[data-service-action]'));
    const saved = loadServiceConnection();
    url.value = saved?.url ?? '';
    token.value = saved?.token ?? '';
    status.textContent = saved ? serviceConfigStatus() || '已保存独立服务连接。' : '尚未连接独立服务。';
    let busy = false;
    const syncButtons = () => {
        const connected = Boolean(loadServiceConnection());
        for (const button of actions)
            button.disabled = busy || button !== connect && !connected;
    };
    syncButtons();
    window.addEventListener('witch-paintbox:service-config-status', () => {
        if (!busy)
            status.textContent = serviceConfigStatus();
    }, { signal });
    container.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-service-action]');
        if (!button || busy)
            return;
        busy = true;
        syncButtons();
        status.classList.remove('is-error');
        try {
            if (button === connect) {
                status.textContent = '正在测试独立服务…';
                await saveServiceConnection({ url: url.value, token: token.value }, signal);
                status.textContent = '独立服务已连接，可迁移当前配置或读取服务已有配置。';
            }
            else if (button.dataset.serviceAction === 'upload') {
                status.textContent = '正在迁移配置与资料库…';
                await migrateServiceConfig(signal);
                status.textContent = '配置与资料库已迁到服务。';
            }
            else if (button.dataset.serviceAction === 'download') {
                status.textContent = '正在读取服务配置…';
                await pullServiceConfig(signal);
                status.textContent = '已读取服务配置与资料库。';
            }
            else {
                status.textContent = '正在复制旧图片历史…';
                let before = null;
                let count = 0;
                while (!signal.aborted) {
                    const page = await loadLocalImageHistoryPage(null, before, 2);
                    signal.throwIfAborted();
                    if (page.entries.length)
                        count += await importServiceImages(page.entries, signal);
                    if (!page.more || !page.next)
                        break;
                    before = page.next;
                }
                status.textContent = count ? `已复制 ${count} 张旧图片到独立服务。` : '服务中没有待复制的旧图片。';
                if (count)
                    notifyImageHistorySaved('legacy-import');
            }
        }
        catch (error) {
            if (!signal.aborted) {
                status.classList.add('is-error');
                status.textContent = error instanceof Error ? error.message : '独立服务操作未完成。';
            }
        }
        finally {
            busy = false;
            syncButtons();
        }
    }, { signal });
}
