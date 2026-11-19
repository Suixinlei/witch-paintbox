// Hold only the latest batch. The native refresh can render it as soon as replaceText commits.
let pending;
export function stageSifangBatch(text, pictures) {
    const batch = { text, pictures };
    pending = batch;
    return () => { if (pending === batch)
        pending = undefined; };
}
export function sifangBatchPicture(text, key) {
    return key && pending?.text === text ? pending.pictures.get(key) : undefined;
}
export function clearSifangBatch() { pending = undefined; }
