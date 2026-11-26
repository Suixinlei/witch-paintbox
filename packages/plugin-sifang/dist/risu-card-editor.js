import { AnchorConfig } from './anchor-config.js';
async function decode(anchor) {
    let portrait = null;
    if (anchor.portrait) {
        const [header, data] = anchor.portrait.split(',');
        const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
        portrait = new Blob([bytes], { type: header.slice(5, header.indexOf(';')) });
    }
    return { ...anchor, portrait };
}
async function encode(anchor) {
    const portrait = anchor.portrait ? await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(anchor.portrait);
    }) : null;
    return { ...anchor, portrait };
}
/** Use the same character and outfit editor for a Risu card's isolated library. */
export function mountRisuCardAnchors(container, read, save) {
    const editor = new AnchorConfig({
        load: () => Promise.all(read().map(decode)),
        async save(anchor) {
            const encoded = await encode(anchor);
            await save([...read().filter(item => item.id !== anchor.id), encoded]);
        },
        async remove(id) { await save(read().filter(item => item.id !== id)); },
    });
    editor.mount(container, 'anchors', true);
    return () => editor.destroy();
}
