import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAnchorPromptFields } from '../dist/anchor-resolver.js';

const anchor = (id, name, outfits, selectedOutfitId, appearance = `${name} appearance`, aliases = []) =>
  ({ id, name, aliases, appearance, negative: `${name} negative`, outfits, selectedOutfitId, portrait: null, updatedAt: 0 });
const outfit = (id, name, tags) => ({ id, name, tags });

const 金狮 = anchor('lion', '金狮', [outfit('o1', '森冠白蕾丝披风礼装', 'white lace corset, white cape')], 'o1');
const 笑斌 = anchor('laugh', '笑斌', [outfit('d1', '海祇鬼皇逆鳞猎装', 'scale hunting gear'),
  outfit('d2', '和风装束', 'japanese clothes')], 'd1');
const anchors = [金狮, 笑斌];

test('# resolves a character-owned outfit name the model wrote without its owner', () => {
  const { positive } = resolveAnchorPromptFields('@金狮, #森冠白蕾丝披风礼装, forest', anchors, []);
  assert.equal(positive, '金狮 appearance, white lace corset, white cape, forest');
});

test('# still prefers the shared library when both define the name', () => {
  const shared = [outfit('s1', '森冠白蕾丝披风礼装', 'shared lace dress')];
  const { positive } = resolveAnchorPromptFields('#森冠白蕾丝披风礼装', anchors, shared);
  assert.equal(positive, 'shared lace dress');
});

test('an unknown # outfit drops out and the character keeps its selected default', () => {
  const { positive, negative } = resolveAnchorPromptFields('@笑斌, #不存在的礼装, night', anchors, []);
  assert.equal(positive, '笑斌 appearance, scale hunting gear, , night');
  assert.equal(negative, '笑斌 negative');
});

test('an unknown # outfit inside a weight group no longer fails the draw', () => {
  const { positive } = resolveAnchorPromptFields('@笑斌, {#不存在的礼装}, night', anchors, []);
  assert.equal(positive, '笑斌 appearance, scale hunting gear, {}, night');
});

test('an empty # reference drops out instead of throwing', () => {
  const { positive } = resolveAnchorPromptFields('@笑斌, #, night', anchors, []);
  assert.equal(positive, '笑斌 appearance, scale hunting gear, , night');
});

test('@角色:未知服装 keeps falling back to the selected default', () => {
  const { positive } = resolveAnchorPromptFields('@笑斌:不存在的服装', anchors, []);
  assert.equal(positive, '笑斌 appearance, scale hunting gear');
});

test('#无服装 still keeps only the appearance', () => {
  const { positive } = resolveAnchorPromptFields('@笑斌, #无服装', anchors, []);
  assert.equal(positive, '笑斌 appearance, ');
});

test('a stored character name that begins with # keeps its legacy meaning', () => {
  const legacy = anchor('old', '#旧角色', [outfit('l1', '旧装', 'old dress')], 'l1');
  const { positive } = resolveAnchorPromptFields('#旧角色, night', [legacy], []);
  assert.equal(positive, '#旧角色 appearance, old dress, night');
});

test('a deactivated # outfit keeps its weight syntax and the default outfit', () => {
  const { positive } = resolveAnchorPromptFields('@笑斌, 0::#森冠白蕾丝披风礼装::', anchors, []);
  assert.equal(positive, '笑斌 appearance, scale hunting gear, 0::white lace corset, white cape::');
});
