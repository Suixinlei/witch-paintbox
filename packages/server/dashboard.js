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

// Pages in navigation order. `scope` names whose settings they hold, `editor` marks the
// pages the service editor draws, and `sections` lists what to show when the page is not its own section.
const scopes = {
  global: ['全局', '四方与 Risu 共用'],
  sifang: ['四方世界'],
  risu: ['Risu'],
  records: ['记录'],
};
const pages = [
  { id: 'overview', title: '服务概览', description: '各范围的状态和入口。' },
  { id: 'image', scope: 'global', title: '生图 API 与参数', editor: true,
    description: '绘图服务的连接、密钥、模型与采样参数。四方与 Risu 生图共用。' },
  { id: 'artists', scope: 'global', title: '画师词与试绘', editor: true,
    description: '画师预设的正面与负面提示词，并用当前配置试画一张。Risu 角色卡在「角色卡」页选用这里的预设。' },
  { id: 'model', scope: 'global', title: '模型连接', editor: true,
    description: '读正文、写配图提示词的模型接口，四方与 Risu 共用。' },
  { id: 'prompts', scope: 'global', title: '正文处理 Prompt', editor: true,
    description: '发给模型的预设：条目顺序与内容、世界书和角色资料等功能层、配图标记解析。' },
  { id: 'worldbooks', scope: 'global', title: '世界书', editor: true,
    description: '上传世界书并挂载条目，由「正文处理 Prompt」里的世界书层发送给模型。' },
  { id: 'outfits', scope: 'global', title: '通用服装', editor: true,
    description: '各角色共用的服装，用 #服装名 调用；四方角色和 Risu 人物都能使用。' },
  { id: 'transfer', scope: 'global', title: '配置导入与导出', editor: true,
    description: '把服务里保存的配置导出为 JSON 备份或分享，或导入一份配置文件。' },
  { id: 'anchors', scope: 'sifang', title: '角色锚点', editor: true,
    description: '四方世界角色的固定外貌、人设图和各自的服装库。Risu 的人物锚点在每张角色卡里单独维护。' },
  { id: 'sifang-workflow', scope: 'sifang', title: '自动配图', editor: true,
    description: '四方世界客户端在回复后的自动写 Tag 与自动出图，以及出图的等待间隔。' },
  { id: 'sifang-appearance', scope: 'sifang', title: '桌宠与外观', editor: true,
    description: '四方世界客户端的桌宠缇娅与画匣色调。色调同时作用于本管理台的配置面板。' },
  { id: 'risu-workflow', scope: 'risu', title: '自动配图',
    description: 'Risu 插件回复完成后的自动配图。模型、生图参数和画师预设沿用全局配置。' },
  { id: 'cards', scope: 'risu', title: '角色卡',
    description: '每张 Risu 角色卡自己的资料：卡片设定、画师预设、人物锚点和场景 Prompt。' },
  { id: 'history', scope: 'records', title: '生图历史', editor: true, sections: ['editor', 'history'],
    description: '服务保存的配图，按来源筛选。页面底部可以设置图片保留多久。' },
];
const pagesById = new Map(pages.map(page => [page.id, page]));
const pageSections = ['overview', 'editor', 'risu-workflow', 'cards', 'history'];
// Addresses of pages that were split or moved keep opening their closest successor.
const moved = new Map([['global', 'image'], ['workflow', 'risu-workflow'], ['preferences', 'transfer']]);

function scoped(tag, scope, className) {
  const element = node(tag, undefined, className);
  element.dataset.scope = scope;
  return element;
}

function buildNavigation() {
  const nav = document.querySelector('.page-nav');
  const link = page => {
    const anchor = node('a', page.title);
    anchor.href = '#' + page.id;
    anchor.dataset.dashboardPage = page.id;
    return anchor;
  };
  let group;
  let options = pagePicker;
  for (const page of pages) {
    if (!page.scope) { nav.append(link(page)); pagePicker.append(new Option(page.title, page.id)); continue; }
    if (group?.dataset.scope !== page.scope) {
      group = scoped('div', page.scope, 'page-nav-group');
      group.append(node('p', scopes[page.scope][0]));
      nav.append(group);
      options = Object.assign(document.createElement('optgroup'), { label: scopes[page.scope][0] });
      pagePicker.append(options);
    }
    group.append(link(page));
    options.append(new Option(page.title, page.id));
  }
}

const pagePicker = byId('page-picker');
buildNavigation();
const navigation = new Map(pages.map(page => [page.id, document.querySelector(`.page-nav [data-dashboard-page="${page.id}"]`)]));
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
let summary;
let risuOverview;
let risuOverviewRequest;
let risuState;
let cardDraft;
let unmountCardAnchors;
let cardPeopleView;
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

function status(target, message = '', error = false) {
  const element = typeof target === 'string' ? byId(target) : target;
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

function scopeCard(scope, note, rows) {
  const [name] = scopes[scope];
  const card = scoped('section', scope, 'scope-card');
  const title = node('h3', name);
  if (note) title.append(node('small', note));
  const links = node('nav');
  links.setAttribute('aria-label', name + '的页面');
  for (const page of pages.filter(item => item.scope === scope)) {
    const link = node('a', page.title);
    link.href = '#' + page.id;
    links.append(link);
  }
  const head = node('header', undefined, 'scope-head');
  head.append(title, links);
  const facts = node('dl', undefined, 'scope-facts');
  for (const [label, value] of rows) {
    const row = node('div');
    row.append(node('dt', label), node('dd', value ?? '—'));
    facts.append(row);
  }
  card.append(head, facts);
  return card;
}

function renderOverview(risuError = '') {
  const libraries = summary?.libraries;
  const preferences = summary?.preferences;
  const { image, model, history } = summary ?? {};
  const sifangFlow = !preferences ? '—' : preferences.autoProcessReplies && preferences.autoGenerateImages ? '正文完成 → 模型写 Tag → 自动出图'
    : preferences.autoProcessReplies ? '正文完成 → 模型写 Tag，图片手动生成'
    : preferences.autoGenerateImages ? '新配图标记自动出图，不自动写 Tag' : '已关闭';
  const risu = risuError ? undefined : risuOverview;
  const risuAutomatic = risu?.preferences.enabled
    ? `已开启 · 每楼最多 ${risu.preferences.maxIllustrations} 张${risu.preferences.dynamicSize ? ' · 动态画幅' : ''}` : '已关闭';
  const risuCards = risu?.cards.length
    ? `${risu.cards.length} 张 · ${risu.cards.map(card => `${card.name}（${card.people} 人 · ${card.backgrounds} 处场景）`).join('、')}`
    : '还没有角色卡';
  byId('scopes').replaceChildren(
    scopeCard('global', scopes.global[1], [
      ['生图', image ? `${image.provider} · ${image.model}${image.configured ? '' : '（未保存密钥）'}` : '待初始化'],
      ['画师预设', image ? `${image.artists} 套` : '—'],
      ['正文处理模型', model ? `${model.name || '待填写'}${model.preset ? ` · 预设「${model.preset}」` : ''}` : '待初始化'],
      ['资料', libraries ? `世界书 ${libraries.worldbooks} 本 · 通用服装 ${libraries.outfits} 套 · 氛围参考 ${libraries.vibes} 张` : '—'],
    ]),
    scopeCard('sifang', '', [
      ['角色锚点', libraries ? `${libraries.anchors} 人` : '—'],
      ['自动配图', sifangFlow],
    ]),
    scopeCard('risu', '', [
      ['自动配图', risu ? risuAutomatic : risuError ? '读取失败' : '正在读取…'],
      ['角色卡', risu ? risuCards : risuError ?? '正在读取…'],
    ]),
    scopeCard('records', '', [
      ['历史图片', history === undefined ? '—' : `${history} 张`],
      ['自动清理', preferences ? preferences.imageRetentionDays ? `保留 ${preferences.imageRetentionDays} 天` : '关闭' : '—'],
    ]),
  );
  details('storage', [['服务地址', summary?.address], ['数据目录', summary?.directory],
    ['服务配置', summary ? summary.revision ? '已保存' : '待初始化' : '—']]);
}

async function refreshOverview() {
  risuOverviewRequest?.abort();
  const controller = new AbortController();
  risuOverviewRequest = controller;
  try {
    const data = await json('admin/risu', undefined, controller.signal);
    if (controller.signal.aborted) return;
    risuOverview = data;
    renderOverview();
  } catch (error) {
    if (!controller.signal.aborted && !deny(error)) renderOverview(error.message);
  }
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
    status('risu-status', '已保存 Risu 自动配图。');
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

function renderScenes(entry) {
  const scenes = entry.library.backgrounds;
  byId('card-scenes').replaceChildren(...scenes.map(sceneRow));
  byId('card-scene-count').textContent = `${scenes.length} 项`;
}

function sceneRow(scene, index) {
  const row = node('div', undefined, 'scene-row');
  const remove = node('button', '删除', 'secondary scene-remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', `删除场景 ${index + 1}`);
  remove.addEventListener('click', () => confirmSceneRemoval(row));
  row.append(node('span', String(index + 1), 'scene-index'), editable('场景名称', scene, 'name'), editable('场景描述', scene, 'description', true), remove);
  return row;
}

function confirmSceneRemoval(row) {
  if (row.querySelector('.scene-confirm')) return;
  const confirm = node('div', undefined, 'scene-confirm');
  confirm.setAttribute('role', 'alert');
  const remove = node('button', '确认删除', 'secondary scene-remove');
  const cancel = node('button', '取消', 'secondary');
  remove.type = cancel.type = 'button';
  remove.addEventListener('click', () => {
    const entry = cardDraft?.entry;
    const index = [...byId('card-scenes').children].indexOf(row);
    if (index === -1 || !entry) return;
    entry.library.backgrounds.splice(index, 1);
    renderScenes(entry);
    cardStatus('已从表单移除一个场景，点击「保存场景 Prompt」后生效。', false, 'scenes');
  });
  cancel.addEventListener('click', () => { confirm.remove(); row.querySelector('.scene-remove').focus(); });
  confirm.append(node('span', '删除这个场景？保存场景 Prompt 后生效。'), remove, cancel);
  row.append(confirm);
  remove.focus();
}

byId('card-scene-add').addEventListener('click', () => {
  if (!cardDraft) return;
  cardDraft.entry.library.backgrounds.push({ name: '', description: '' });
  renderScenes(cardDraft.entry);
  byId('card-scenes').lastElementChild.querySelector('input').focus();
});

// Card messages show at the top; the panel whose button was used repeats the ones about saving.
function cardStatus(message = '', error = false, panel) {
  status('card-status', message, error);
  for (const line of cardForm.querySelectorAll('.panel-status')) status(line);
  if (message && panel) status(cardForm.querySelector(`[data-card-panel="${panel}"] .panel-status`), message, error);
}

function fieldsForCard(entry) {
  const { card, library } = entry;
  cardForm.elements.cardName.value = card.name;
  cardForm.elements.description.value = card.desc ?? '';
  cardForm.elements.scenario.value = card.scenario ?? '';
  fieldsForArtistPresets(entry);
  renderScenes(entry);
  byId('card-people-count').textContent = `${library.anchors.length} 人`;
  unmountCardAnchors?.();
  // The editor draws into its own shadow tree so the plugin stylesheet cannot reach the dashboard.
  const people = byId('card-people');
  if (!people.shadowRoot) {
    const style = node('link');
    style.rel = 'stylesheet';
    style.href = '/style.css';
    people.attachShadow({ mode: 'open' }).append(style);
  }
  const anchors = node('div');
  cardPeopleView?.remove();
  cardPeopleView = anchors;
  people.shadowRoot.append(anchors);
  unmountCardAnchors = mountRisuCardAnchors(anchors, () => library.anchors, async next => {
    const draft = cardDraft;
    if (!draft || draft.entry !== entry) throw new Error('角色卡已切换，请重新打开。');
    updateCardFields(entry);
    const saved = await json('admin/risu/cards', { revision: draft.revision,
      cards: [{ ...entry, library: { ...library, anchors: next } }] });
    if (risuState.revision === draft.revision) risuState.revision = saved.revision;
    draft.revision = saved.revision;
    library.anchors = next;
    byId('card-people-count').textContent = `${next.length} 人`;
  });
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
  byId('card-history').hidden = byId('card-reload').hidden = !id;
  cardStatus(id ? '正在读取本卡资料…' : `共 ${risuState?.cards.length ?? 0} 张角色卡。`);
  if (!id) return;
  const controller = new AbortController();
  cardRequest = controller;
  try {
    const data = await json('admin/risu/card', { id, withRevision: true }, controller.signal);
    if (controller.signal.aborted) return;
    fieldsForCard(data.entry);
    cardDraft = data;
    cardForm.hidden = false;
    cardStatus();
  } catch (error) {
    if (!controller.signal.aborted) cardStatus(error.message, true);
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
    cardStatus('已载入表单，点击「保存卡片资料」或「保存场景 Prompt」提交。');
  } catch (error) { cardStatus(error.message, true); }
});
cardForm.addEventListener('submit', async event => {
  event.preventDefault();
  const draft = cardDraft;
  if (!draft) return;
  updateCardFields(draft.entry);
  // Enter in a field submits too, where there is no submitter to name the panel.
  const origin = event.submitter ?? document.activeElement;
  const panel = origin?.closest?.('[data-card-panel]')?.dataset.cardPanel;
  const report = (message, error = false) => cardStatus(message, error, panel);
  const blank = draft.entry.library.backgrounds.findIndex(scene => !scene.name.trim());
  if (blank !== -1) {
    report(`第 ${blank + 1} 个场景还没有名称，请填写后再保存。`, true);
    byId('card-scenes').children[blank]?.querySelector('input')?.focus();
    return;
  }
  const id = cardSelect.value;
  const fields = cardForm.querySelector('fieldset');
  fields.disabled = cardSelect.disabled = true;
  report('正在保存本卡资料…');
  try {
    const { revision } = await json('admin/risu/cards', { revision: draft.revision, cards: [draft.entry] });
    if (risuState.revision === draft.revision) risuState.revision = revision;
    draft.revision = revision;
    const card = risuState.cards.find(item => item.id === id);
    if (card) card.name = draft.entry.card.name;
    cardSelect.selectedOptions[0].text = draft.entry.card.name;
    if (byId('card-advanced').open) byId('card-json').value = JSON.stringify(draft.entry, null, 2);
    report('已保存本卡资料。');
  } catch (error) { report(error.message, true); }
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
  const page = pagesById.has(requested) ? requested : moved.get(requested) ?? 'overview';
  if (page !== requested) history.replaceState(null, '', '#' + page);
  if (activePage === page) return;
  activePage = page;
  const info = pagesById.get(page);
  const scope = info.scope ? scopes[info.scope][0] : '';
  pagePicker.value = page;
  for (const [name, tab] of navigation) {
    if (name === page) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  const heading = byId('page-heading');
  heading.textContent = info.title;
  const content = byId('page-content');
  content.dataset.page = page;
  content.dataset.scope = info.scope ?? '';
  byId('page-scope').textContent = scope;
  byId('page-description').textContent = info.description ?? '';
  document.title = (scope ? scope + ' · ' : '') + info.title + ' · 魔女画匣';
  const shown = info.sections ?? (info.editor ? ['editor'] : [page]);
  for (const section of pageSections) byId(section).hidden = !shown.includes(section);
  byId('service-editor').dataset.page = page;
  if (page === 'cards') void loadArtistPresets();
  if (page === 'overview') void refreshOverview();
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
  const container = byId('service-editor');
  const retry = byId('retry-editor');
  retry.hidden = true;
  status('editor-error', '正在读取服务配置…');
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
    summary = await json('admin/summary');
    renderOverview();
    status('error');
  } catch (error) { status('error', error.message, true); }
  void refreshOverview();
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
    summary = await json('admin/summary', undefined, AbortSignal.timeout(8000));
    renderOverview();
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
