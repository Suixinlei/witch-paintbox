// Hold only the latest batch. The native refresh can render it as soon as replaceText commits.
let pending;
export function stageSifangBatch(text, pictures) {
    // Saved bytes already live on the service. Keep only completion markers until the render consumes them.
    const markers = new Map();
    for (const [key, picture] of pictures)
        markers.set(key, picture.error ? picture : {});
    const batch = { text, pictures: markers };
    pending = batch;
    return () => { if (pending === batch)
        pending = undefined; };
}
export function sifangBatchPicture(text, key) {
    return key && pending?.text === text ? pending.pictures.get(key) : undefined;
}
export function clearSifangBatch() { pending = undefined; }
