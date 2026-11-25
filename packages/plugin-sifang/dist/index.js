import { isSifangEnvironment } from './sifang-host.js';
// Native clients never import the desktop pet or the local configuration editors.
async function start() {
    if (isSifangEnvironment())
        await (await import('./sifang-entry.js')).mountSifangClient();
    else
        await import('./tavern-entry.js');
}
void start().catch(error => {
    console.error('[魔女画匣] 插件启动失败。', error);
    const toast = window.toastr;
    toast?.error('魔女画匣未能启动，请检查插件版本和独立服务连接。');
});
