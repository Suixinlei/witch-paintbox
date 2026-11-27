import { historySourceName, historyTitle } from '/dist/image-history-data.js';
import { imageProviderName } from '/dist/image-settings.js';
import { unpack } from '/dist/service-protocol.js';
import { mountRisuCardAnchors } from '/dist/risu-card-editor.js';
import { createPromptCopyButton } from '/dist/novelai-link.js';

const byId = id => document.getElementById(id);
const auth = byId('auth');
const cardForm = byId('card-form');
const prefsForm = byId('risu-preferences');
const cardSelect = byId('risu-card');
const historySelect = byId('history-scope');
const historyMore = byId('history-more');
const navigation = new Map(Array.from(document.querySelectorAll('[data-dashboard-page]'), link => [link.dataset.dashboardPage, link]));
const pagePicker = byId('page-picker');
pagePicker.append(...Array.from(navigation, ([page, link]) => new Option(link.textContent, page)));
pagePicker.addEventListener('change', () => { location.hash = pagePicker.value; });
let risuReady;
let activePage;
const sessionKey = 'witch-paintbox.admin-token';
const cardSelectionKey = 'witch-paintbox.admin-card';
let token = '';
let authBusy = false;
let liveTimer;
let liveFailures = 0;
let reconnectTimer;

function readToken() {
  try { return sessionStorage.getItem(sessionKey) ?? ''; }
  catch { return ''; }
}

function rememberToken(value) {
  try {
    if (value) sessionStorage.setItem(sessionKey, value);
    else sessionStorage.removeItem(sessionKey);
  } catch { /* The current page can still use its in-memory token. */ }
}
let risuState;
let cardDraft;
let unmountCardAnchors;
let cardRequest;
let artistPresets;
let historyRequest;
let historyCursor;
let historyUrls = [];

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}

function status(id, message = '', error = false) {
  const element = byId(id);
  element.textContent = message;
  element.toggleAttribute('data-error', error);
}

async function request(path, body, signal) {
  const response = await fetch('/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw Object.assign(new Error(error?.error || `服务请求失败（HTTP ${response.status}）。`), { status: response.status });
  }
  return response;
}

async function json(path, body, signal) {
  return (await request(path, body, signal)).json();
}

function details(id, fields, className = 'detail') {
  byId(id).replaceChildren(...fields.map(([label, value]) => {
    const row = node('div', undefined, className);
    row.append(node('dt', label), node('dd', value ?? '—'));
    return row;
  }));
}

function showSummary({ address, directory, revision, history, image, model, libraries }) {
  details('facts', Object.entries({
    四方角色锚点: libraries?.anchors, 世界书: libraries?.worldbooks, 通用服装: libraries?.outfits,
    氛围参考: libraries?.vibes, 历史图片: history,
  }), 'fact');
  details('storage', [['服务地址', address], ['数据目录', directory], ['全局配置', revision ? '已保存' : '待初始化'],
    ['当前生图通道', image?.provider], ['生图模型', image?.model], ['正文处理模型', model?.name || '待填写']]);
}

function appendPrompt(container, label, content) {
  if (!content?.trim()) return;
  container.append(node('h4', label), node('pre', content));
}

function promptGroup(title) {
  const group = node('details');
  group.append(node('summary', title));
  return group;
}

async function loadRisu() {
  try {
    risuState = await json('admin/risu');
    for (const [name, value] of Object.entries(risuState.preferences)) {
      const field = prefsForm.elements.namedItem(name);
      if (field.type === 'checkbox') field.checked = value;
      else field.value = value;
    }
    prefsForm.querySelector('fieldset').disabled = false;
    cardSelect.replaceChildren(new Option('选择角色卡', ''), ...risuState.cards.map(card => new Option(card.name, card.id)));
    status('card-status', risuState.cards.length ? `共 ${risuState.cards.length} 张角色卡。` : '服务尚未收录 Risu 角色卡。');
    let selected = '';
    try { selected = localStorage.getItem(cardSelectionKey) ?? ''; }
    catch { /* Card selection still works when browser storage is unavailable. */ }
    if (selected && risuState.cards.some(card => card.id === selected)) {
      cardSelect.value = selected;
      await loadCard();
    } else if (selected) {
      try { localStorage.removeItem(cardSelectionKey); } catch { /* Storage may be unavailable. */ }
    }
  } catch (error) {
    status('risu-status', error.message, true);
    status('card-status', error.message, true);
  }
}

prefsForm.addEventListener('submit', async event => {
  event.preventDefault();
  const fields = prefsForm.querySelector('fieldset');
  const { enabled, maxIllustrations, dynamicSize, maxInputChars, statusPortraits } = prefsForm.elements;
  const revision = risuState.revision;
  fields.disabled = true;
  status('risu-status', '正在保存…');
  try {
    const saved = await json('admin/risu/preferences', { revision, preferences: {
      enabled: enabled.checked, maxIllustrations: maxIllustrations.valueAsNumber,
      dynamicSize: dynamicSize.checked, maxInputChars: maxInputChars.valueAsNumber,
      statusPortraits: statusPortraits.checked,
    } });
    risuState.revision = saved.revision;
    if (cardDraft?.revision === revision) cardDraft.revision = saved.revision;
    status('risu-status', '已保存 Risu 全局设置。');
  } catch (error) {
    status('risu-status', error.message, true);
  } finally { fields.disabled = false; }
});

function editable(label, record, key, multiline = false) {
  const wrapper = node('label', label);
  const field = node(multiline ? 'textarea' : 'input');
  if (multiline) field.rows = 3;
  field.value = typeof record[key] === 'string' ? record[key] : '';
  field.addEventListener('input', () => { record[key] = field.value; });
  wrapper.append(field);
  return wrapper;
}

function fieldsForArtistPresets(entry) {
  const label = node('label', 'NAI 画师预设');
  const select = node('select');
  const presets = artistPresets?.novelai ?? [];
  const selected = entry.artistPresetIds?.novelai ?? '';
  select.append(new Option('沿用全局画师词', ''), ...presets.map(({ id, name }) => new Option(name, id)));
  if (selected && !presets.some(({ id }) => id === selected)) {
    select.append(new Option(artistPresets ? '预设已不可用（沿用全局画师词）' : '已绑定预设', selected));
  }
  select.value = selected;
  select.disabled = !artistPresets;
  select.addEventListener('change', () => {
    if (select.value) entry.artistPresetIds = { novelai: select.value };
    else delete entry.artistPresetIds;
  });
  label.append(select);
  byId('card-artist-presets').replaceChildren(label);
}

async function loadArtistPresets() {
  try {
    artistPresets = await json('admin/risu/artist-presets');
    if (cardDraft) fieldsForArtistPresets(cardDraft.entry);
    status('card-artist-status');
  } catch (error) { status('card-artist-status', error.message, true); }
}

function fieldsForCard(entry) {
  const { card, library } = entry;
  cardForm.elements.cardName.value = card.name;
  cardForm.elements.description.value = card.desc ?? '';
  cardForm.elements.scenario.value = card.scenario ?? '';
  fieldsForArtistPresets(entry);
  unmountCardAnchors?.();
  const people = node('div');
  const root = people.attachShadow({ mode: 'open' });
  const style = node('link');
  style.rel = 'stylesheet';
  style.href = '/style.css';
  const anchors = node('div');
  root.append(style, anchors);
  unmountCardAnchors = mountRisuCardAnchors(anchors, () => library.anchors, async next => {
    const draft = cardDraft;
    if (!draft || draft.entry !== entry) throw new Error('角色卡已切换，请重新打开。');
    updateCardFields(entry);
    const saved = await json('admin/risu/cards', { revision: draft.revision,
      cards: [{ ...entry, library: { ...library, anchors: next } }] });
    if (risuState.revision === draft.revision) risuState.revision = saved.revision;
    draft.revision = saved.revision;
    library.anchors = next;
  });
  const backgrounds = promptGroup(`场景 Prompt · ${library.backgrounds.length} 项`);
  for (const scene of library.backgrounds) {
    backgrounds.append(editable('场景名称', scene, 'name'), editable('场景描述', scene, 'description', true));
  }
  if (!library.backgrounds.length) backgrounds.append(node('p', '本卡暂无场景资料。', 'muted'));
  byId('card-library').replaceChildren(people, backgrounds);
}

function updateCardFields(entry) {
  const { cardName, description, scenario } = cardForm.elements;
  entry.card.name = cardName.value.trim();
  if ('desc' in entry.card || description.value) entry.card.desc = description.value;
  if ('scenario' in entry.card || scenario.value) entry.card.scenario = scenario.value;
}

async function loadCard() {
  cardRequest?.abort();
  unmountCardAnchors?.();
  cardDraft = undefined;
  cardForm.hidden = true;
  byId('card-advanced').open = false;
  const id = cardSelect.value;
  byId('card-history').hidden = !id;
  status('card-status', id ? '正在读取本卡资料…' : `共 ${risuState?.cards.length ?? 0} 张角色卡。`);
  if (!id) return;
  const controller = new AbortController();
  cardRequest = controller;
  try {
    const data = await json('admin/risu/card', { id, withRevision: true }, controller.signal);
    if (controller.signal.aborted) return;
    fieldsForCard(data.entry);
    cardDraft = data;
    cardForm.hidden = false;
    status('card-status');
  } catch (error) {
    if (!controller.signal.aborted) status('card-status', error.message, true);
  }
}

cardSelect.addEventListener('change', () => {
  try {
    if (cardSelect.value) localStorage.setItem(cardSelectionKey, cardSelect.value);
    else localStorage.removeItem(cardSelectionKey);
  } catch { /* Card selection still works when browser storage is unavailable. */ }
  void loadCard();
});
byId('card-reload').addEventListener('click', loadCard);
byId('card-advanced').addEventListener('toggle', event => {
  if (!event.currentTarget.open || !cardDraft) return;
  updateCardFields(cardDraft.entry);
  byId('card-json').value = JSON.stringify(cardDraft.entry, null, 2);
});
byId('card-apply-json').addEventListener('click', () => {
  try {
    const entry = JSON.parse(byId('card-json').value);
    if (entry.card?.chaId !== cardSelect.value) throw new Error('角色卡 ID 必须与当前角色卡一致。');
    if (!Array.isArray(entry.library?.anchors) || !Array.isArray(entry.library?.backgrounds)
      || [...entry.library.anchors, ...entry.library.backgrounds].some(item => typeof item?.name !== 'string')) {
      throw new Error('本卡 JSON 必须包含人物与场景列表，各条目须有名称。');
    }
    fieldsForCard(entry);
    cardDraft.entry = entry;
    byId('card-advanced').open = false;
    status('card-status', '已载入表单，点击「保存本卡资料」提交。');
  } catch (error) { status('card-status', error.message, true); }
});
cardForm.addEventListener('submit', async event => {
  event.preventDefault();
  const draft = cardDraft;
  if (!draft) return;
  updateCardFields(draft.entry);
  const id = cardSelect.value;
  const fields = cardForm.querySelector('fieldset');
  fields.disabled = cardSelect.disabled = true;
  status('card-status', '正在保存本卡资料…');
  try {
    const { revision } = await json('admin/risu/cards', { revision: draft.revision, cards: [draft.entry] });
    if (risuState.revision === draft.revision) risuState.revision = revision;
    draft.revision = revision;
    const card = risuState.cards.find(item => item.id === id);
    if (card) card.name = draft.entry.card.name;
    cardSelect.selectedOptions[0].text = draft.entry.card.name;
    if (byId('card-advanced').open) byId('card-json').value = JSON.stringify(draft.entry, null, 2);
    status('card-status', '已保存本卡资料。');
  } catch (error) { status('card-status', error.message, true); }
  finally { fields.disabled = cardSelect.disabled = false; }
});

function historyItem(entry, blob) {
  const card = node('article', undefined, 'history-item');
  const title = historyTitle(entry);
  const url = URL.createObjectURL(blob);
  historyUrls.push(url);
  const image = node('img');
  image.src = url;
  image.loading = 'lazy';
  image.alt = title;
  const view = node('a');
  view.href = url;
  view.target = '_blank';
  view.rel = 'noopener noreferrer';
  view.setAttribute('aria-label', `打开原图 · ${title}`);
  view.append(image);
  const content = node('section');
  const source = historySelect.querySelectorAll('option');
  const name = Array.from(source).find(option => option.value === entry.scope)?.text
    ?? historySourceName(entry.scope, entry.sourceName);
  const { model, width, height } = entry.parameters;
  content.append(node('h3', title), node('p', [
    name, new Date(entry.createdAt).toLocaleString('zh-CN'), imageProviderName(entry.provider ?? 'novelai'), model, width && height && `${width}×${height}`,
  ].filter(Boolean).join(' · '), 'muted'));
  const prompts = promptGroup('本次 Prompt');
  const novelaiStatus = node('p', '', 'muted');
  novelaiStatus.setAttribute('role', 'status');
  const novelaiLink = createPromptCopyButton(entry, (text, error = false) => {
    novelaiStatus.textContent = text.replace('生成属性', '本次 Prompt');
    novelaiStatus.classList.toggle('is-error', error);
  });
  if (novelaiLink) content.append(novelaiLink, novelaiStatus);
  prompts.className = 'history-details';
  appendPrompt(prompts, '原始场景', entry.scenePrompt);
  appendPrompt(prompts, '实际正向', entry.positive);
  appendPrompt(prompts, '实际负向', entry.negative);
  for (const [index, character] of (entry.characters ?? []).entries()) {
    appendPrompt(prompts, `角色 ${index + 1} · 正向`, character.positive);
    appendPrompt(prompts, `角色 ${index + 1} · 负向`, character.negative);
  }
  if (prompts.children.length === 1) prompts.append(node('p', '这张图片没有已保存的 Prompt。', 'muted'));
  content.append(prompts);
  card.append(view, content);
  return card;
}

async function loadHistory({ reset = true, reloadScopes = false, scope = historySelect.value } = {}) {
  historyRequest?.abort();
  const controller = new AbortController();
  historyRequest = controller;
  const { signal } = controller;
  const list = byId('history-list');
  if (reset) {
    list.replaceChildren();
    historyUrls.forEach(url => URL.revokeObjectURL(url));
    historyUrls = [];
    historyCursor = null;
  }
  historyMore.hidden = true;
  status('history-status', '正在读取生图历史…');
  try {
    if (reloadScopes) {
      const sources = await json('history/categories', undefined, signal);
      if (signal.aborted) return;
      const options = new Map(sources.map(entry => [entry.scope, entry.name]));
      for (const card of risuState?.cards ?? []) options.set(`risu:${card.id}`, `Risu · ${card.name}`);
      historySelect.replaceChildren(new Option('全部来源', ''), ...Array.from(options, ([key, name]) => new Option(name, key)));
    }
    if (scope && !Array.from(historySelect.options).some(option => option.value === scope)) {
      historySelect.add(new Option(historySourceName(scope), scope));
    }
    historySelect.value = scope;
    const response = await request('history/page', { scope: scope || null, before: historyCursor, limit: 6 }, signal);
    const { value, blobs } = await unpack(await response.blob());
    if (signal.aborted) return;
    list.append(...value.entries.map((entry, index) => historyItem(entry, blobs[index])));
    historyCursor = value.more ? value.next : null;
    historyMore.hidden = !historyCursor;
    status('history-status', list.children.length ? '' : '此来源暂无已保存的图片。');
  } catch (error) {
    if (!signal.aborted) {
      historyMore.hidden = !historyCursor;
      status('history-status', error.message, true);
    }
  }
}

historySelect.addEventListener('change', () => { void loadHistory(); });
historyMore.addEventListener('click', () => { void loadHistory({ reset: false }); });
byId('history-refresh').addEventListener('click', () => { void loadHistory({ reloadScopes: true }); });
byId('card-history').addEventListener('click', () => {
  void loadHistory({ reloadScopes: true, scope: 'risu:' + cardSelect.value });
  location.hash = 'history';
});

function showPage(focus = false) {
  const requested = location.hash.slice(1);
  const page = navigation.has(requested) ? requested : requested === 'global' ? 'image' : 'overview';
  const link = navigation.get(page);
  if (activePage === page) return;
  activePage = page;
  pagePicker.value = page;
  for (const [name, tab] of navigation) {
    if (name === page) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  const heading = byId('page-heading');
  heading.textContent = link.textContent;
  document.title = link.textContent + ' · 魔女画匣';
  byId('global').hidden = !link.hasAttribute('data-editor');
  byId('global-editor').dataset.page = page;
  byId('risu-workflow').hidden = page !== 'workflow';
  for (const section of ['overview', 'cards', 'history']) byId(section).hidden = section !== page;
  if (page === 'cards') void loadArtistPresets();
  if (focus) {
    heading.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  if (page === 'history' && !historyRequest) {
    void risuReady.then(() => {
      if (activePage === 'history' && !historyRequest) void loadHistory({ reloadScopes: true });
    });
  }
}

window.addEventListener('hashchange', () => {
  if (!byId('dashboard').hidden) showPage(true);
});

async function loadEditor() {
  const container = byId('global-editor');
  const retry = byId('retry-editor');
  retry.hidden = true;
  status('editor-error', '正在读取全局配置…');
  try {
    const { mountServiceEditor } = await import('/dist/service-editor.js');
    await mountServiceEditor(container, { url: location.origin, token });
    status('editor-error');
  } catch (error) {
    status('editor-error', error.message, true);
    retry.hidden = false;
  }
}

byId('retry-editor').addEventListener('click', loadEditor);

async function refresh() {
  try {
    showSummary(await json('admin/summary'));
    status('error');
  } catch (error) { status('error', error.message, true); }
  if (!risuState) await loadRisu();
  if (activePage === 'cards') await loadArtistPresets();
}

const deny = error => error.status === 401 || error.status === 403;

function logout() {
  rememberToken('');
  location.reload();
}

function queueText({ active, queued }) {
  return `执行中 ${active} · 等待 ${queued}`;
}

async function monitor() {
  clearTimeout(liveTimer);
  try {
    const data = await json('admin/status', undefined, AbortSignal.timeout(8000));
    liveFailures = 0;
    byId('live-connection').textContent = data.configured ? '在线 · 接收请求' : '在线 · 待配置';
    byId('live-prompt').textContent = queueText(data.prompt);
    byId('live-draw').textContent = queueText(data.draw);
    byId('live-check').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
  } catch (error) {
    if (deny(error)) { logout(); return; }
    liveFailures++;
    byId('live-connection').textContent = liveFailures < 3 ? '状态更新延迟 · 正在重试' : '连接中断 · 正在重连';
    byId('live-prompt').textContent = byId('live-draw').textContent = '—';
    byId('live-check').textContent = error.name === 'TimeoutError'
      ? '状态查询超时，正在重试。'
      : `状态查询失败：${error.message}`;
  }
  liveTimer = setTimeout(monitor, 1000);
}

async function connect(candidate, restoring = false) {
  if (authBusy || !candidate) return;
  authBusy = true;
  clearTimeout(reconnectTimer);
  const submit = auth.querySelector('button');
  submit.disabled = true;
  token = candidate;
  status('error', '正在连接…');
  try {
    showSummary(await json('admin/summary', undefined, AbortSignal.timeout(8000)));
    rememberToken(candidate);
    auth.reset();
    auth.hidden = true;
    byId('dashboard').hidden = byId('refresh').hidden = byId('logout').hidden = false;
    status('error');
    void monitor();
    risuReady = loadEditor().then(loadRisu);
    showPage();
  } catch (error) {
    token = '';
    if (deny(error)) rememberToken('');
    if (restoring && !deny(error)) {
      status('error', '服务暂时不可达，正在恢复本标签页的登录。', true);
      reconnectTimer = setTimeout(() => { void connect(candidate, true); }, 3000);
    } else status('error', deny(error) ? error.message : '无法连接服务，请稍后重试。', true);
  } finally {
    authBusy = false;
    submit.disabled = false;
  }
}

auth.addEventListener('submit', event => {
  event.preventDefault();
  void connect(byId('token').value.trim());
});
byId('logout').addEventListener('click', logout);
const savedToken = readToken();
if (savedToken) void connect(savedToken, true);
byId('refresh').addEventListener('click', refresh);
window.addEventListener('witch-paintbox:service-config-saved', refresh);
