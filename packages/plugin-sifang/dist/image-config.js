import { isServiceEditor } from './service-client.js';
import { flushServiceConfig } from './service-config.js';
import { isSifangEnvironment } from './sifang-host.js';
import { loadImageSettings, saveImageSettings } from './image-settings.js';
import { imageSettingsView } from './image-view.js';
import { NAI_SIZE_PRESETS, validateImageConnection } from './novelai.js';
import { VibePanel } from './vibe-panel.js';
import { generateConfiguredImage } from './image-provider.js';
import { imageFileExtension } from './raster-image.js';
import { imageChatContext } from './chat-host.js';
import { saveImageHistory, notifyImageHistorySaved, onImageHistoryChanged } from './image-history.js';
import { createImageGallery } from './image-gallery.js';
import { emitPetEvent, petEnd, petFault, petTaskId } from './pet-events.js';
import { isImageSizeModeSaving, loadModelSettings, saveImageSizeMode } from './model-settings.js';
import { imageSizeMode } from './image-size-mode.js';
/** Check one draft connection the same way NovelAI will send it. */
function validateConnectionFor(connection) {
    return validateImageConnection(connection);
}
const OFFICIAL_NAME = 'NovelAI 官方';
function newId() {
    return `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}
export class ImageConfig {
    settings = null;
    loadError = '';
    connection = { channel: 'official', url: '', key: '', appendSuffix: true };
    connectionId = '';
    connectionName = '';
    artistName = '';
    container = null;
    listeners = null;
    request = null;
    advancedOpen = isServiceEditor();
    vibePanel = null;
    imageUrl = '';
    imageRecord = null;
    previewGallery = null;
    stopImageHistory = onImageHistoryChanged(change => {
        const record = this.imageRecord;
        if (!record || !(change.deletedIds?.includes(record.id) || change.before !== undefined && record.createdAt < change.before))
            return;
        this.releaseOutput();
        if (!this.request)
            this.generationMessage = '本机图片已清理。';
        this.syncGeneration();
    });
    imageFilename = 'witch-paintbox.png';
    generationMessage = '';
    generationFailed = false;
    generationPhase = 'queued';
    writing = false;
    pendingSaves = 0;
    saveRevision = 0;
    get hasPendingWrites() { return this.writing || this.pendingSaves > 0; }
    constructor() {
        this.reloadSaved();
    }
    reloadSaved(artistsOnly = false) {
        if (artistsOnly && this.settings) {
            const saved = loadImageSettings();
            this.settings = { ...this.settings, artists: saved.artists, positive: saved.positive, negative: saved.negative, activeArtistId: saved.activeArtistId };
            this.artistName = saved.artists.find(item => item.id === saved.activeArtistId)?.name ?? '';
            this.render();
            return;
        }
        this.settings = null;
        this.loadError = '';
        this.connection = { channel: 'official', url: '', key: '', appendSuffix: true };
        this.connectionId = this.connectionName = this.artistName = '';
        try {
            this.settings = loadImageSettings();
            this.connection = { ...this.settings.connection };
            this.connectionId = this.settings.activeConnectionId;
            this.connectionName = this.settings.connectionProfiles.find(item => item.id === this.connectionId)?.name ?? '';
            this.artistName = this.settings.artists.find(item => item.id === this.settings.activeArtistId)?.name ?? '';
        }
        catch (error) {
            this.loadError = error.message;
        }
        this.render();
    }
    mount(container) {
        this.unmount();
        this.container = container;
        this.listeners = new AbortController();
        const { signal } = this.listeners;
        container.addEventListener('input', event => this.edit(event), { signal });
        container.addEventListener('change', event => { void this.select(event); }, { signal });
        container.addEventListener('click', event => { void this.click(event); }, { signal });
        window.addEventListener('witch-paintbox:model-settings-changed', () => this.syncImageSizeMode(), { signal });
        window.addEventListener('witch-paintbox:image-size-mode-saving', () => this.syncImageSizeMode(), { signal });
        this.render();
    }
    unmount() {
        this.maskKey();
        this.listeners?.abort();
        this.previewGallery?.element.remove();
        this.previewGallery = null;
        this.container = null;
    }
    maskKey() {
        const input = this.container?.querySelector('[data-connection="key"]');
        if (input)
            input.type = 'password';
        const toggle = this.container?.querySelector('[data-action="toggle-key"]');
        if (toggle) {
            toggle.textContent = '显示';
            toggle.setAttribute('aria-pressed', 'false');
        }
    }
    destroy() {
        this.vibePanel?.destroy();
        this.stopImageHistory();
        this.unmount();
        this.request?.abort();
        this.releaseOutput();
    }
    isConnectionSaved() {
        const profile = this.settings?.connectionProfiles.find(item => item.id === this.connectionId);
        return !!profile && profile.name === this.connectionName
            && profile.channel === this.connection.channel && profile.url === this.connection.url
            && profile.appendSuffix === this.connection.appendSuffix
            && profile.key === this.connection.key && this.settings?.activeConnectionId === profile.id;
    }
    render() {
        if (!this.container)
            return;
        if (!this.settings) {
            const message = document.createElement('p');
            message.setAttribute('role', 'alert');
            message.textContent = this.loadError;
            this.container.replaceChildren(message);
            return;
        }
        this.container.innerHTML = imageSettingsView({ ...this.settings, connection: this.connection, activeConnectionId: this.connectionId }, { connectionName: this.connectionName, artistName: this.artistName, connectionSaved: this.isConnectionSaved(), refreshing: false, advancedOpen: this.advancedOpen });
        this.mountVibes();
        this.syncParameters();
        this.syncImageSizeMode();
        this.syncGeneration();
    }
    message(area, text, error = false) {
        const node = this.container?.querySelector(`[data-${area}-status]`);
        if (!node)
            return;
        node.textContent = text;
        node.classList.toggle('is-error', error);
    }
    async persist(area) {
        const settings = this.settings;
        const revision = ++this.saveRevision;
        this.pendingSaves++;
        try {
            await saveImageSettings(structuredClone(settings));
            if (isServiceEditor())
                await flushServiceConfig();
            if (revision === this.saveRevision && this.settings === settings)
                this.message(area, '已保存。');
        }
        catch (error) {
            if (revision === this.saveRevision && this.settings === settings)
                this.message(area, error.message, true);
        }
        finally {
            this.pendingSaves--;
        }
    }
    async write(action) {
        if (this.writing)
            return;
        this.writing = true;
        const controls = Array.from(this.container?.querySelectorAll('input, select, textarea, button') ?? []);
        const disabled = controls.map(control => control.disabled);
        controls.forEach(control => { control.disabled = true; });
        try {
            await action();
        }
        finally {
            this.writing = false;
            controls.forEach((control, index) => { if (control.isConnected)
                control.disabled = disabled[index]; });
            this.syncImageSizeMode();
        }
    }
    edit(event) {
        if (this.writing)
            return;
        const field = event.target;
        if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement))
            return;
        const settings = this.settings;
        const connectionField = field.dataset.connection;
        if (connectionField === 'appendSuffix' && field instanceof HTMLInputElement) {
            this.connection.appendSuffix = field.checked;
            this.syncConnection();
            return;
        }
        if (connectionField === 'channel' || connectionField === 'url' || connectionField === 'key') {
            if (connectionField === 'channel')
                this.connection.channel = field.value === 'custom' ? 'custom' : 'official';
            else
                this.connection[connectionField] = field.value;
            this.syncConnection();
            return;
        }
        if (field.dataset.field === 'connectionName') {
            this.connectionName = field.value;
            this.syncConnection();
            return;
        }
        if (field.dataset.field === 'artistName') {
            this.artistName = field.value;
            return;
        }
        if (field.dataset.field === 'positive' || field.dataset.field === 'negative') {
            settings[field.dataset.field] = field.value;
            void this.persist('artist');
            return;
        }
        const parameter = field.dataset.parameter;
        const parameters = settings.parameters;
        if (!parameter || !Object.hasOwn(parameters, parameter))
            return;
        if (parameter === 'width' || parameter === 'height')
            this.syncSizePreset();
        if (field instanceof HTMLInputElement && !field.checkValidity())
            return;
        switch (parameter) {
            case 'model':
            case 'sampler':
            case 'noiseSchedule':
                parameters[parameter] = field.value;
                if (parameter === 'model')
                    this.vibePanel?.setModel(field.value);
                break;
            case 'sm':
            case 'smDyn':
                parameters[parameter] = field.checked;
                break;
            case 'width':
            case 'height':
            case 'steps':
            case 'scale':
            case 'seed':
            case 'cfgRescale':
                if (field.value === '')
                    return;
                parameters[parameter] = Number(field.value);
                break;
        }
        this.syncParameters();
        void this.persist('settings');
    }
    syncConnection() {
        const saved = this.isConnectionSaved();
        const line = this.container?.querySelector('.credential-line');
        if (line)
            line.dataset.saved = String(saved);
        const button = this.container?.querySelector('[data-action="save-connection"]');
        if (button)
            button.disabled = saved;
        const url = this.container?.querySelector('[data-custom-url]');
        if (url)
            url.hidden = this.connection.channel !== 'custom';
        this.message('connection', saved ? '已保存。' : '当前密钥配置尚未保存。');
    }
    syncParameters() {
        const p = this.settings.parameters;
        const legacy = p.model === 'nai-diffusion-3';
        if (!legacy)
            p.sm = p.smDyn = false;
        if (!p.sm)
            p.smDyn = false;
        if (p.model.startsWith('nai-diffusion-5') || (!legacy && p.noiseSchedule === 'native'))
            p.noiseSchedule = 'karras';
        for (const key of ['sm', 'smDyn']) {
            const input = this.container?.querySelector(`[data-parameter="${key}"]`);
            if (input) {
                input.disabled = !legacy || (key === 'smDyn' && !p.sm);
                input.checked = p[key];
            }
        }
        const schedule = this.container?.querySelector('[data-parameter="noiseSchedule"]');
        if (schedule) {
            schedule.disabled = p.model.startsWith('nai-diffusion-5') || p.sampler === 'k_dpm_fast';
            schedule.value = p.noiseSchedule;
            const native = schedule.querySelector('option[value="native"]');
            if (native)
                native.disabled = !legacy;
        }
    }
    syncSizePreset() {
        const width = this.container?.querySelector('[data-parameter="width"]');
        const height = this.container?.querySelector('[data-parameter="height"]');
        const select = this.container?.querySelector('[data-field="sizePreset"]');
        if (width && height && select) {
            select.value = NAI_SIZE_PRESETS.find(item => item.width === width.valueAsNumber && item.height === height.valueAsNumber)?.value ?? 'custom';
        }
    }
    syncImageSizeMode() {
        if (!this.settings || !this.container)
            return;
        let mode = 'fixed', error = '';
        try {
            mode = imageSizeMode(loadModelSettings('novelai'));
        }
        catch (failure) {
            error = failure.message;
        }
        for (const button of Array.from(this.container.querySelectorAll('[data-size-mode]'))) {
            button.setAttribute('aria-pressed', String(button.dataset.sizeMode === mode));
            button.disabled = this.writing || isImageSizeModeSaving() || Boolean(error);
        }
        const label = this.container.querySelector('[data-size-selection-label]');
        if (label)
            label.textContent = mode === 'ai' ? '兜底尺寸' : '预设尺寸';
        this.message('size-mode', error || (isImageSizeModeSaving() ? '正在同步画幅模式…' : mode === 'ai'
            ? '按每张配图返回的 size 选择画幅；缺少或不支持的尺寸使用下方兜底尺寸。'
            : '所有配图使用下方画幅。切换模式会互斥启用当前模型 API 预设中的同名格式条目。'), Boolean(error));
    }
    async select(event) {
        if (this.writing)
            return;
        const field = event.target;
        if (!(field instanceof HTMLSelectElement))
            return;
        const settings = this.settings;
        if (field.dataset.field === 'sizePreset') {
            const preset = NAI_SIZE_PRESETS.find(item => item.value === field.value);
            if (preset) {
                for (const dimension of ['width', 'height']) {
                    settings.parameters[dimension] = preset[dimension];
                    const input = this.container?.querySelector(`[data-parameter="${dimension}"]`);
                    if (input)
                        input.value = String(preset[dimension]);
                }
                void this.persist('settings');
            }
            return;
        }
        if (field.dataset.field !== 'connectionProfile' && field.dataset.field !== 'artistPreset')
            return;
        try {
            await this.write(async () => {
                if (field.dataset.field === 'connectionProfile') {
                    const profile = settings.connectionProfiles.find(item => item.id === field.value);
                    if (profile) {
                        const connection = { channel: profile.channel, url: profile.url, key: profile.key, appendSuffix: profile.appendSuffix };
                        const next = { ...settings, connection, activeConnectionId: profile.id };
                        await saveImageSettings(next);
                        this.settings = next;
                        this.connection = { ...connection };
                    }
                    else {
                        this.connection = { channel: 'official', url: '', key: '', appendSuffix: true };
                    }
                    this.connectionId = profile?.id ?? '';
                    this.connectionName = profile?.name ?? '';
                    this.render();
                }
                if (field.dataset.field === 'artistPreset') {
                    const preset = settings.artists.find(item => item.id === field.value);
                    const next = {
                        ...settings, activeArtistId: preset?.id ?? '',
                        positive: preset?.positive ?? settings.positive, negative: preset?.negative ?? settings.negative,
                    };
                    await saveImageSettings(next);
                    this.settings = next;
                    this.artistName = preset?.name ?? '';
                    this.render();
                }
            });
        }
        catch (error) {
            this.message(field.dataset.field === 'connectionProfile' ? 'connection' : 'artist', error.message, true);
            field.value = field.dataset.field === 'connectionProfile' ? this.connectionId : settings.activeArtistId;
        }
    }
    async click(event) {
        const target = event.target;
        if (!(target instanceof Element))
            return;
        const action = target.closest('button[data-action]')?.dataset.action;
        if (!action || this.writing)
            return;
        try {
            switch (action) {
                case 'toggle-key': {
                    const input = this.container.querySelector('[data-connection="key"]');
                    const button = target.closest('button');
                    input.type = input.type === 'password' ? 'text' : 'password';
                    button.textContent = input.type === 'password' ? '显示' : '隐藏';
                    button.setAttribute('aria-pressed', String(input.type === 'text'));
                    break;
                }
                case 'save-connection':
                    await this.write(() => this.saveConnection());
                    break;
                case 'toggle-advanced':
                    this.toggleAdvanced();
                    break;
                case 'select-size-mode': {
                    if (isImageSizeModeSaving())
                        return;
                    const mode = target.closest('button')?.dataset.sizeMode;
                    if (mode === 'fixed' || mode === 'ai') {
                        await this.write(() => saveImageSizeMode('novelai', mode));
                    }
                    break;
                }
                case 'save-artist':
                case 'update-artist':
                case 'delete-artist':
                    await this.write(() => this.saveArtist(action));
                    break;
                case 'generate':
                    void this.generate();
                    break;
                case 'preview-output':
                    this.openPreview();
                    break;
                case 'cancel-generation':
                    this.request?.abort();
                    break;
            }
        }
        catch (error) {
            this.message(action === 'save-connection' ? 'connection'
                : action === 'select-size-mode' ? 'size-mode' : 'artist', error.message, true);
        }
    }
    async saveConnection() {
        const connection = validateConnectionFor(this.connection);
        // Store the entered URL so disabling suffix completion does not keep an appended path.
        if (connection.channel === 'custom')
            connection.url = this.connection.url.trim();
        const name = this.connectionName.trim() || (connection.channel === 'official' ? OFFICIAL_NAME : new URL(connection.url).host);
        const id = this.connectionId || newId();
        const settings = this.settings;
        if (settings.connectionProfiles.some(item => item.id !== id && item.name === name)) {
            throw new Error('已有同名连接配置，请选中它后保存，或使用其他名称。');
        }
        const profile = { ...connection, id, name };
        const next = {
            ...settings, connection, activeConnectionId: id,
            connectionProfiles: settings.connectionProfiles.some(item => item.id === id)
                ? settings.connectionProfiles.map(item => item.id === id ? profile : item)
                : [...settings.connectionProfiles, profile],
        };
        await saveImageSettings(next);
        if (isServiceEditor())
            await flushServiceConfig();
        this.settings = next;
        this.connection = { ...connection };
        this.connectionName = name;
        this.connectionId = id;
        this.render();
        this.message('connection', '已保存。');
    }
    async saveArtist(action) {
        const settings = this.settings;
        const current = settings.artists.find(item => item.id === settings.activeArtistId);
        let next;
        if (action === 'delete-artist') {
            if (!current)
                throw new Error('请先选择要删除的配置。');
            next = { ...settings, artists: settings.artists.filter(item => item.id !== current.id), activeArtistId: '' };
        }
        else {
            const name = this.artistName.trim();
            if (!name)
                throw new Error('请填写配置名称。');
            if (action === 'update-artist' && !current)
                throw new Error('请先选择要更新的配置。');
            const id = action === 'update-artist' ? current.id : newId();
            if (settings.artists.some(item => item.id !== id && item.name === name)) {
                throw new Error('已有同名配置，请使用“更新”，或填写其他名称后保存。');
            }
            const preset = { id, name, positive: settings.positive, negative: settings.negative };
            next = {
                ...settings, activeArtistId: id,
                artists: action === 'update-artist' ? settings.artists.map(item => item.id === id ? preset : item) : [...settings.artists, preset],
            };
        }
        await saveImageSettings(next);
        if (isServiceEditor())
            await flushServiceConfig();
        this.settings = next;
        if (action === 'delete-artist')
            this.artistName = '';
        else
            this.artistName = this.artistName.trim();
        this.render();
        this.message('artist', action === 'delete-artist' ? '配置已删除，当前填写的提示词仍保留。' : '配置已保存。');
    }
    validParameters() {
        const fields = this.container?.querySelectorAll('[data-parameter]') ?? [];
        for (const field of Array.from(fields)) {
            if (field.checkValidity())
                continue;
            const drawer = field.closest('details');
            if (drawer)
                drawer.open = true;
            field.reportValidity();
            return false;
        }
        return true;
    }
    releaseOutput() {
        this.previewGallery?.close();
        this.previewGallery?.setImages([], null);
        if (this.imageUrl)
            URL.revokeObjectURL(this.imageUrl);
        this.imageUrl = '';
        this.imageRecord = null;
    }
    clearOutput() {
        this.releaseOutput();
        this.generationMessage = '';
        this.generationFailed = false;
    }
    mountVibes() {
        this.vibePanel?.destroy();
        this.vibePanel = null;
        const host = this.container?.querySelector('[data-vibe-host]');
        if (!host || !this.advancedOpen)
            return;
        this.vibePanel = new VibePanel();
        this.vibePanel.mount(host, this.settings.parameters.model);
    }
    toggleAdvanced() {
        this.advancedOpen = !this.advancedOpen;
        const wrap = this.container?.querySelector('.advanced-features');
        const toggle = wrap?.querySelector('[data-action="toggle-advanced"]');
        const panel = wrap?.querySelector('.advanced-panel');
        if (!wrap || !toggle || !panel)
            return;
        wrap.dataset.open = String(this.advancedOpen);
        toggle.setAttribute('aria-expanded', String(this.advancedOpen));
        panel.hidden = !this.advancedOpen;
        this.mountVibes();
    }
    async generate() {
        if (this.request)
            return;
        if (!this.validParameters())
            return;
        this.generationFailed = false;
        if (!this.isConnectionSaved()) {
            this.generationMessage = '请先保存当前密钥配置。';
            this.generationFailed = true;
            this.syncGeneration();
            emitPetEvent({ type: 'end', id: petTaskId(), task: 'image', source: 'config', result: 'failed', fault: 'setup', message: this.generationMessage });
            return;
        }
        const request = new AbortController();
        this.request = request;
        this.generationPhase = 'queued';
        this.generationMessage = '正在加入队列…';
        this.syncGeneration();
        const snapshot = structuredClone(this.settings);
        const pet = petTaskId();
        const endPet = petEnd();
        const petImage = { type: 'end', id: pet, task: 'image', source: 'config' };
        emitPetEvent({ type: 'image', id: pet, source: 'config', phase: 'start', provider: 'novelai' });
        const source = imageChatContext();
        const id = newId();
        const draft = {
            id, title: '绘图工坊 · 试绘', sourceName: source?.name,
            markerKey: JSON.stringify([source?.scope ?? 'unassigned', source?.chatId ?? '', 'workshop', id]),
            scenePrompt: snapshot.positive,
        };
        try {
            const result = await generateConfiguredImage(snapshot, snapshot.positive, request.signal, progress => {
                if (request.signal.aborted)
                    return;
                this.generationPhase = progress.state;
                this.generationMessage = progress.state === 'queued' ? `等待绘制 · 队列第 ${progress.position} 位` : '正在生成图片…';
                emitPetEvent({ type: 'image', id: pet, source: 'config', phase: progress.state,
                    position: progress.state === 'queued' ? progress.position : undefined, columns: progress.columns });
                this.syncGeneration();
            }, '', { history: draft, workshop: {
                    parameters: snapshot.parameters, negative: snapshot.negative,
                } });
            if (request.signal.aborted) {
                endPet({ ...petImage, result: 'dropped', paid: true, message: '' });
                return;
            }
            const url = URL.createObjectURL(result.blob);
            this.releaseOutput();
            this.imageUrl = url;
            this.imageFilename = `witch-paintbox-${result.seed ?? Date.now()}.${imageFileExtension(result.blob)}`;
            this.generationMessage = result.seed === undefined ? '生成完成。' : `生成完成 · 种子 ${result.seed}`;
            endPet({ ...petImage, result: 'done', message: this.generationMessage, picture: {
                    blob: result.blob, width: result.parameters.width, height: result.parameters.height,
                    target: () => this.container?.querySelector('[data-output] img') ?? null,
                } });
            const { history: stored, ...image } = result;
            const entry = { ...image, ...draft, createdAt: stored?.createdAt ?? Date.now() };
            this.imageRecord = entry;
            this.pendingSaves++;
            try {
                if ((isSifangEnvironment() || isServiceEditor())) {
                    if (!stored || stored.error)
                        throw new Error(stored?.error ?? '独立服务未确认保存。');
                    notifyImageHistorySaved(stored.id);
                }
                else
                    await saveImageHistory(entry);
                emitPetEvent({ type: 'history', id: pet, saved: true, message: this.generationMessage });
            }
            catch (error) {
                this.generationMessage = `图片已生成，但未能保存到回顾：${error instanceof Error ? error.message : '存储不可用'}`;
                emitPetEvent({ type: 'history', id: pet, saved: false, message: this.generationMessage });
            }
            finally {
                this.pendingSaves--;
            }
        }
        catch (error) {
            this.generationFailed = !request.signal.aborted;
            this.generationMessage = request.signal.aborted
                ? this.generationPhase === 'queued' ? '已取消排队。' : '已取消等待，服务端任务可能仍在继续。'
                : error.message;
            endPet({ ...petImage, result: request.signal.aborted ? 'cancelled' : 'failed', message: this.generationMessage,
                fault: request.signal.aborted ? undefined : petFault(error), serverMayContinue: request.signal.aborted && this.generationPhase !== 'queued' });
        }
        finally {
            endPet({ ...petImage, result: 'dropped', message: '' });
            this.request = null;
            this.syncGeneration();
        }
    }
    openPreview() {
        const entry = this.imageRecord;
        if (!entry || !this.imageUrl || !this.container || !this.listeners)
            return;
        const gallery = this.previewGallery ??= createImageGallery(entry.title ?? '试绘图片', this.listeners.signal, {});
        if (gallery.element.parentElement !== this.container)
            this.container.append(gallery.element);
        gallery.setImages([{ entry, url: this.imageUrl }], entry.id);
        gallery.open();
    }
    syncGeneration() {
        if (!this.container || !this.settings)
            return;
        const busy = this.request !== null;
        const button = this.container.querySelector('[data-action="generate"]');
        button.disabled = busy;
        button.querySelector('strong').textContent = busy ? this.generationPhase === 'queued' ? '已加入队列' : '正在生成…' : this.imageUrl ? '再次生成图片' : '点击生成图片';
        const cancel = this.container.querySelector('[data-action="cancel-generation"]');
        cancel.hidden = !busy;
        cancel.textContent = this.generationPhase === 'queued' ? '取消排队' : '取消等待';
        const message = this.container.querySelector('[data-generation-status]');
        message.textContent = this.generationMessage;
        message.classList.toggle('is-error', this.generationFailed);
        const output = this.container.querySelector('[data-output]');
        if (this.imageUrl && output.dataset.url !== this.imageUrl) {
            const image = document.createElement('img');
            image.src = this.imageUrl;
            image.alt = '本次生成的图片';
            const preview = document.createElement('button');
            preview.type = 'button';
            preview.dataset.action = 'preview-output';
            preview.setAttribute('aria-label', '全屏查看本次生成的图片');
            preview.append(image);
            const download = document.createElement('a');
            download.href = this.imageUrl;
            download.download = this.imageFilename;
            download.textContent = '保存图片';
            output.replaceChildren(preview, download);
            output.dataset.url = this.imageUrl;
        }
        else if (!this.imageUrl && output.dataset.url) {
            output.replaceChildren();
            delete output.dataset.url;
        }
    }
}
