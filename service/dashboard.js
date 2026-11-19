const auth = document.getElementById('auth');
const input = document.getElementById('token');
const error = document.getElementById('error');
let token = '';

function details(id, fields, className) {
  const rows = fields.map(([name, value]) => {
    const row = document.createElement('div');
    row.className = className;
    const label = document.createElement('dt');
    label.textContent = name;
    const content = document.createElement('dd');
    content.textContent = value ?? '—';
    row.append(label, content);
    return row;
  });
  document.getElementById(id).replaceChildren(...rows);
}

async function refresh() {
  error.textContent = '';
  try {
    const response = await fetch('/v1/admin/summary', { headers: { Authorization: 'Bearer ' + token } });
    if (response.status === 401) throw new Error('服务访问令牌无效。');
    if (!response.ok) throw new Error('无法读取服务配置。');
    const { address, directory, revision, queue, history, image, model, libraries } = await response.json();
    details('facts', Object.entries({
      角色锚点: libraries?.anchors, 世界书: libraries?.worldbooks, 通用服装: libraries?.outfits,
      氛围参考: libraries?.vibes, 图片历史: history, 生图队列: queue.active ? `绘制中 · ${queue.queued} 排队` : '空闲',
    }), 'fact');
    details('model', [['模型', model?.name], ['传输', model?.transport], ['预设', model?.preset || '—'],
      ['连接状态', model?.configured ? '已配置' : '待配置']], 'detail');
    details('image', [['服务', image?.provider], ['模型', image?.model], ['密钥', image?.configured ? '已配置' : '未配置'],
      ['调度', '全局串行 · 同时 1 张']], 'detail');
    details('storage', [['服务地址', address], ['数据目录', directory], ['配置状态', revision ? '已落盘' : '待迁移']], 'detail');
    auth.hidden = true;
    document.getElementById('connection').hidden = false;
    document.getElementById('summary').hidden = false;
  } catch (reason) {
    auth.hidden = false;
    document.getElementById('connection').hidden = true;
    document.getElementById('summary').hidden = true;
    error.textContent = reason instanceof Error ? reason.message : '无法连接服务。';
  }
}

auth.addEventListener('submit', event => {
  event.preventDefault();
  token = input.value.trim();
  input.value = '';
  void refresh();
});
document.getElementById('refresh').addEventListener('click', refresh);
