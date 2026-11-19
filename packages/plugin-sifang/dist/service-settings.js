import { loadServiceConnection, saveServiceConnection } from './service-client.js';
import { currentPreferences, saveSifangAutoProcessMode, sifangAutoProcessMode } from './settings.js';
export function serviceSettingsView() {
    return `<section class="preference-section image-settings" aria-labelledby="paintbox-service-heading" data-paintbox-service>
    <header class="section-heading section-heading--plain">
      <h2 id="paintbox-service-heading" class="section-title">魔女画匣独立服务</h2>
      <p class="section-description">模型、画师串、资料库和自动出图设置在服务页管理。</p>
    </header>
    <label class="config-field"><span>服务地址</span>
      <input name="paintboxServiceUrl" type="url" placeholder="http://127.0.0.1:4783" autocomplete="off"></label>
    <label class="config-field"><span>访问令牌</span>
      <input name="paintboxServiceToken" type="password" autocomplete="off" spellcheck="false"></label>
    <div class="actions">
      <button type="button" class="secondary" data-service-action="connect">测试并保存</button>
      <a data-service-dashboard href="http://127.0.0.1:4783/" target="_blank" rel="noopener noreferrer">打开服务配置页</a>
    </div>
    <p class="config-status" role="status" data-service-status></p>
    <label class="preference-row">
      <span><strong>回复后自动写 Tag</strong><span id="sifang-auto-process-help">新回复稳定后自动生成配图提示词并写入楼层。开启或关闭只作用于当前四方客户端。</span></span>
      <select name="sifangAutoProcessReplies" aria-label="回复后自动写 Tag" aria-describedby="sifang-auto-process-help">
        <option value="service">跟随服务</option>
        <option value="enabled">开启</option>
        <option value="disabled">关闭</option>
      </select>
    </label>
    <p class="config-status" role="status" data-sifang-auto-process-status></p>
  </section>`;
}
export function bindServiceSettings(container, signal) {
    const url = container.querySelector('[name="paintboxServiceUrl"]');
    const token = container.querySelector('[name="paintboxServiceToken"]');
    const status = container.querySelector('[data-service-status]');
    const connect = container.querySelector('[data-service-action="connect"]');
    const dashboard = container.querySelector('[data-service-dashboard]');
    const autoProcess = container.querySelector('[name="sifangAutoProcessReplies"]');
    const autoStatus = container.querySelector('[data-sifang-auto-process-status]');
    function syncAutoProcess() {
        const mode = sifangAutoProcessMode();
        autoProcess.value = mode;
        autoStatus.classList.remove('is-error');
        autoStatus.textContent = mode === 'service'
            ? `跟随服务 · 当前${currentPreferences().autoProcessReplies ? '开启' : '关闭'}`
            : '';
    }
    syncAutoProcess();
    window.addEventListener('witch-paintbox:preferences-changed', syncAutoProcess, { signal });
    autoProcess.addEventListener('change', () => {
        const mode = autoProcess.value;
        if (mode !== 'service' && mode !== 'enabled' && mode !== 'disabled')
            return;
        try {
            saveSifangAutoProcessMode(mode);
        }
        catch {
            syncAutoProcess();
            autoStatus.classList.add('is-error');
            autoStatus.textContent = '无法保存自动写 Tag 设置。';
        }
    }, { signal });
    const saved = loadServiceConnection();
    url.value = saved?.url ?? '';
    if (saved) {
        dashboard.href = saved.url + '/';
        token.placeholder = '已保存，留空可复用';
    }
    status.textContent = saved ? '已保存独立服务连接。' : '尚未连接独立服务。';
    connect.addEventListener('click', async () => {
        connect.disabled = true;
        status.classList.remove('is-error');
        status.textContent = '正在测试独立服务…';
        try {
            await saveServiceConnection({ url: url.value, token: token.value || loadServiceConnection()?.token || '' }, signal);
            const current = loadServiceConnection();
            dashboard.href = current.url + '/';
            token.value = '';
            token.placeholder = '已保存，留空可复用';
            status.textContent = '独立服务已连接。';
        }
        catch (error) {
            if (!signal.aborted) {
                status.textContent = error instanceof Error ? error.message : '独立服务操作未完成。';
                status.classList.add('is-error');
            }
        }
        finally {
            connect.disabled = false;
        }
    }, { signal });
}
