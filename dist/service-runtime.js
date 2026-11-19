import { setClientPreferences } from './settings.js';
import { loadServiceConnection, sendService } from './service-client.js';
let policy;
export function servicePolicy() { return policy; }
export async function bindServiceRuntime(signal) {
    let pending = false;
    async function refresh() {
        const connection = loadServiceConnection();
        if (!connection || pending || signal.aborted)
            return;
        pending = true;
        try {
            const response = await sendService('client/preferences', null, signal, connection, 5000);
            const next = await response.json();
            const current = loadServiceConnection();
            if (signal.aborted || current?.url !== connection.url || current.token !== connection.token)
                return;
            if (JSON.stringify(next) === JSON.stringify(policy))
                return;
            policy = next;
            setClientPreferences(next.preferences);
            window.dispatchEvent(new Event('witch-paintbox:model-settings-changed'));
        }
        catch { /* Connection input and image requests report failures directly. */ }
        finally {
            pending = false;
        }
    }
    window.addEventListener('witch-paintbox:service-changed', () => { void refresh(); }, { signal });
    document.addEventListener('visibilitychange', () => { if (!document.hidden)
        void refresh(); }, { signal });
    const timer = setInterval(() => { if (!document.hidden)
        void refresh(); }, 15_000);
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });
    await refresh();
}
