import { loadAnchors, type CharacterAnchor } from './anchor-store.js';
import { resolveAnchorPromptFields } from './anchor-resolver.js';
import { loadSharedOutfits, type SharedOutfit } from './shared-outfit-store.js';

export interface CharacterPrompt {
  positive: string;
  negative: string;
}

export interface PreparedImagePrompt {
  positive: string;
  negative: string;
  characters: CharacterPrompt[];
}

interface Separator { index: number; value: '|' | '~' }

/** Delimiters belong to the source protocol, never to tags expanded from storage. */
function separators(source: string): Separator[] | null {
  const found: Separator[] = [];
  const brackets: string[] = [];
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')', '<': '>' };
  let weighted = false;
  let invalid = false;
  let hasOperator = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') { index++; continue; }
    if (source.slice(index, index + 2) === '::') {
      // A closing :: belongs to the current numeric emphasis group. Plain
      // colons in copyright names and other tags never start such a group.
      if (weighted) { weighted = false; index++; continue; }
      if (/(?:^|[\s,，|~([{])[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(source.slice(0, index))) {
        weighted = true;
        index++;
        continue;
      }
    }
    if (character === '|' || character === '~') {
      hasOperator = true;
      if (!weighted && !brackets.length) found.push({ index, value: character });
    }
    if (weighted) continue;
    if (pairs[character]) brackets.push(pairs[character]);
    else if (')]}>'.includes(character) && brackets.pop() !== character) invalid = true;
  }
  // Ambiguous delimiters mean ordinary text, not a failed generation.
  if (hasOperator && (invalid || weighted || brackets.length)) return null;
  return found;
}

function parseScene(source: string, characterLimit: number): { positive: string; characters: CharacterPrompt[] } {
  const plain = { positive: source, characters: [] };
  if (!characterLimit) return plain;
  const operators = separators(source);
  if (!operators) return plain;
  const bars = operators.filter(item => item.value === '|');
  const tildes = operators.filter(item => item.value === '~');
  if (!bars.length || bars.length > characterLimit) return plain;
  let positive = source.slice(0, bars[0].index).trim();
  if (!positive || tildes.some(item => item.index < bars[0].index)) return plain;
  const characters: CharacterPrompt[] = [];
  for (const [index, bar] of bars.entries()) {
    const end = bars[index + 1]?.index ?? source.length;
    const negatives = tildes.filter(item => item.index > bar.index && item.index < end);
    if (negatives.length > 1) return plain;
    const positive = source.slice(bar.index + 1, negatives[0]?.index ?? end).trim();
    const negative = negatives.length ? source.slice(negatives[0].index + 1, end).trim() : '';
    if (!positive) return plain;
    characters.push({ positive, negative });
  }
  // Some planners put the cast count and environment in separate columns.
  // Fold that extra column into the scene only when the named cast accounts for every character.
  const counts = positive.split(/[,，]/).map(tag => /^([1-9]\d*)(?:girls?|boys?|others?)$/i.exec(tag.trim()));
  const castSize = counts.every(Boolean) ? counts.reduce((sum, count) => sum + Number(count?.[1]), 0) : 0;
  const [environment, ...cast] = characters;
  if (castSize > 1 && cast.length === castSize && !environment.negative
    && !/^@|^(?:\d+(?:girls?|boys?|others?))\b/i.test(environment.positive)
    && cast.every(character => character.positive.startsWith('@'))) {
    positive += ', ' + environment.positive;
    return { positive, characters: cast };
  }
  return { positive, characters };
}

export interface PromptLibrary {
  anchors: CharacterAnchor[];
  outfits: SharedOutfit[];
}

export async function readPromptLibrary(scene: string): Promise<PromptLibrary> {
  const anchors = /[\p{Script=Han}@]/u.test(scene) ? await loadAnchors() : [];
  return {
    anchors: anchors.map(anchor => ({ ...anchor, portrait: null })),
    outfits: scene.includes('#') ? loadSharedOutfits() : [],
  };
}

/** Recognize optional columns, then expand positive fields from one library snapshot. */
export async function prepareImagePrompt(scene: string, globalNegative: string, artistPositive = '', characterLimit = 22,
  library?: PromptLibrary): Promise<PreparedImagePrompt> {
  const parsed = parseScene(scene, characterLimit);
  const { anchors, outfits } = library ?? await readPromptLibrary(scene);
  const expand = (positive: string) => resolveAnchorPromptFields(positive, anchors, outfits);
  const expanded = expand(parsed.positive);
  const mergeNegative = (original: string, anchored: string) => anchored
    ? [original, anchored].filter(text => text.trim()).join(', ') : original;
  return {
    // Artist tags are not protocol input and are added to the global field only.
    positive: [artistPositive, expanded.positive].filter(text => text.trim()).join(', '),
    negative: mergeNegative(globalNegative, expanded.negative),
    characters: parsed.characters.map(character => {
      const expanded = expand(character.positive);
      return { positive: expanded.positive, negative: mergeNegative(character.negative, expanded.negative) };
    }),
  };
}
