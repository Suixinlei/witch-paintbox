import type { ImageHistoryEntry } from './image-history-data.js';

/** Copy resolved scene and character captions without artist tags. */
export function createPromptCopyButton(entry: ImageHistoryEntry, message: (text: string, error?: boolean) => void): HTMLButtonElement | null {
  const prompt = entry.copyPrompt ?? '';
  if (!prompt.trim()) return null;
  const link = document.createElement('button');
  link.type = 'button';
  link.textContent = '复制 Prompt';
  link.title = '复制已解析角色和服装的 Prompt，不附加画师串。';
  link.addEventListener('click', () => {
    try {
      void navigator.clipboard.writeText(prompt).then(
        () => message('已复制 Prompt（角色和服装已解析，不含画师串）。'),
        () => message('复制失败，请从生成属性中手动复制 Prompt。', true),
      );
    } catch {
      message('复制失败，请从生成属性中手动复制 Prompt。', true);
    }
  });
  return link;
}
