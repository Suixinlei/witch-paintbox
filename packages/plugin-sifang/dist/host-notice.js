/** The host answers a floor that is gone, switched away, or still being rewritten with a
 *  rejection, and it answers every event during that rewrite the same way. A notice per
 *  answer buries the page, so one message reaches the user at most once per cooldown. */
const COOLDOWN = 60_000;
const shown = new Map();
export function hostNoticeDue(text) {
    const now = Date.now();
    const at = shown.get(text);
    if (at !== undefined && now - at < COOLDOWN)
        return false;
    shown.set(text, now);
    return true;
}
/** Another save or chat has its own floors; its predecessor's failures are gone with it. */
export function resetHostNotices() {
    shown.clear();
}
