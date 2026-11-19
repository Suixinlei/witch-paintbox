import { loadServiceConnection, saveServiceConnection } from './service-client.js';

export function serviceSettingsView(): string {
  return `<section class="preference-section image-settings" aria-labelledby="paintbox-service-heading" data-paintbox-service>
    <header class="section-heading section-heading--plain">
      <h2 id="paintbox-service-heading" class="section-title">魔女画匣独立服务</h2>
      <p class="section-description">模型、画师串、资料库和自动配图设置都在服务页管理。</p>
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
  </section>`;
}

export function bindServiceSettings(container: HTMLElement, signal: AbortSignal): void {
  const url = container.querySelector<HTMLInputElement>('[name="paintboxServiceUrl"]')!;
  const token = container.querySelector<HTMLInputElement>('[name="paintboxServiceToken"]')!;
  const status = container.querySelector<HTMLElement>('[data-service-status]')!;
  const connect = container.querySelector<HTMLButtonElement>('[data-service-action="connect"]')!;
  const dashboard = container.querySelector<HTMLAnchorElement>('[data-service-dashboard]')!;
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
      const current = loadServiceConnection()!;
      dashboard.href = current.url + '/';
      token.value = '';
      token.placeholder = '已保存，留空可复用';
      status.textContent = '独立服务已连接。';
    } catch (error) {
      if (!signal.aborted) {
        status.textContent = error instanceof Error ? error.message : '独立服务操作未完成。';
        status.classList.add('is-error');
      }
    } finally { connect.disabled = false; }
  }, { signal });
}
