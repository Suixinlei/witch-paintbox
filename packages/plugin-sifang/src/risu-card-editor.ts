import { AnchorConfig } from './anchor-config.js';
import type { CharacterAnchor } from './anchor-store.js';

export type PortableAnchor = Omit<CharacterAnchor, 'portrait'> & { portrait: string | null };

async function decode(anchor: PortableAnchor): Promise<CharacterAnchor> {
  let portrait: Blob | null = null;
  if (anchor.portrait) {
    const [header, data] = anchor.portrait.split(',');
    const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
    portrait = new Blob([bytes], { type: header.slice(5, header.indexOf(';')) });
  }
  return { ...anchor, portrait };
}

async function encode(anchor: CharacterAnchor): Promise<PortableAnchor> {
  const portrait = anchor.portrait ? await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(anchor.portrait!);
  }) : null;
  return { ...anchor, portrait };
}

/** Use the same character and outfit editor for a Risu card's isolated library. */
export function mountRisuCardAnchors(container: HTMLElement, read: () => PortableAnchor[],
  save: (anchors: PortableAnchor[]) => Promise<void>): () => void {
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
