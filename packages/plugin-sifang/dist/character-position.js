export function validCharacterPosition(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const { x, y } = value;
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
}
/** Read metadata only at the start of a source character column, before library expansion. */
export function readCharacterPosition(source) {
    if (!/^@position\s*\(/i.test(source))
        return { positive: source };
    const match = /^@position\(\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*\)\s*,?\s*/i.exec(source);
    const center = match && { x: Number(match[1]), y: Number(match[2]) };
    if (!center || !validCharacterPosition(center))
        throw withFault(new Error('角色位置无效：请使用 @position(x,y)，坐标范围为 0～1。'), 'setup');
    const positive = source.slice(match[0].length).trim();
    if (!positive)
        throw withFault(new Error('角色位置后缺少人物提示词。'), 'setup');
    return { positive, center };
}
/** V4/V4.5 use cell centers on a 5×5 grid; V5 supports continuous positions. */
export function modelCharacterPosition(center, model) {
    const coordinate = (value) => model.startsWith('nai-diffusion-5') ? value
        : (Math.min(4, Math.floor(value * 5)) + 0.5) / 5;
    return { x: coordinate(center.x), y: coordinate(center.y) };
}
export const CHARACTER_POSITION_INSTRUCTION = `<角色站位协议>
本次配图的 prompt 必须采用“全局 | 角色一 | 角色二”的独立角色分栏；每栏只描述一个入画人物，全局只写人数、场景、画风、光照及整体构图，不放任何角色的专属外貌或服装。
根据每张图的实际构图，为每个角色栏在最开头输出 @position(x,y)，再写该角色的引用、服装、动作与表情。x/y 是该人物在画面内可见主体的中心，范围 0～1；左上角为 (0,0)，右下角为 (1,1)，中间为 (0.5,0.5)。左右一律指画面左右，不是人物自身左右。
先确定镜头、姿势、前后、遮挡及互动，再分配位置；不要机械地把所有人物等距排成一行。相拥或重叠人物允许坐标接近；前后关系仍用英文描述，y 不代表景深。人物栏尽量按画面从上到下、从左到右排列，坐标、角色动作和全局构图必须一致。仅为实际入画人物建栏，不为第一人称画外观察者单独建栏。
示例：2girls, garden, side by side | @position(0.3,0.5) girl, @角色甲, on the left, holding a cup | @position(0.7,0.5) girl, @角色乙, on the right, waving ~ glasses
保留原有 JSON、插入点、尺寸和图片标记输出格式；@position 只写在 prompt 内各角色栏开头，不增加 JSON 字段。
</角色站位协议>`;
import { withFault } from './pet-events.js';
