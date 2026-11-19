import type { LibraryData } from "../domain/types";
import { personBindings } from "./mainPrompt";

export const worldbookMarker = "[global-comfy-image:worldbook:v2]";
export const drawingWorldbookRule = `${worldbookMarker}\n【当前场景插画协议 v2：补充世界书】
正常完成正文与状态栏，然后在回复末尾输出恰好一个 <image_prompt>严格 JSON</image_prompt>。
将绘图块放在 <details><summary>绘图描述</summary> 与 </details> 之间，便于折叠查看。
本规则覆盖旧的“仅输出1–2个c块”等人数限制：恰好一个用户 u 块；当前同一场景实际在场的其他人物每人一个 c 块，不限人数。不在场、已离场、回忆、提及或远程交流的人不输出 c 块。无人时只有 u 块。禁止沿用历史在场名单。
c 块沿用现有 statusData 字段格式和 varId，equipment 写完整当前装备；保留既有账目和数值结算规则。
绘图只选本轮结尾的一个可见瞬间，一幅画可有多人。characters 可为在场人物的子集；名单仅来自本轮 c 块 varId，不增加旁观者、不重复人物。人物在场不等于入画。
人物仅输出 varId/action/state/outfit，禁止输出固定外貌 appearance 或另造 ID。固定外貌由插件按 ID 补入；action/state/outfit 中也不得猜测或复述稳定的发色、瞳色、年龄、体型等特征。action 用具体英语写动作、表情、朝向、位置和互动；state 为可见状态的简短英语，普通状态可为空。
outfit 使用 {"mode":"custom","description":"完整当前服装的英语描述"}，根据本轮 equipment 和正文完整描述，替代默认衣着；不要只写变化部分，不增加没有依据的服装。没有装备描述时可省略 outfit，使用资料库默认服装。
先按本轮姿势与观察者眼睛位置判断实际可见范围，再选镜头；first_person 是偏好，不是必须。不要为了 POV 改写姿势，也不要假设观察者能从外面看见自己。
当对方在正常视野内、动作可从用户眼睛位置清楚交代时选 first_person；observerName 使用当前用户姓名。观察者不列入 characters；自然可见的手等局部只写 visibleBodyParts，不增加人数。
相拥入睡、脸埋在观察者颈窝或胸前、双方身体紧贴导致脸不可见、观察者闭眼、需要看见双方整体姿态等场景，若第一人称难以表达，应选 third_person。人数少或只有一名其他角色也允许第三人称。reason 用英语说明姿势、可见范围与所选角度的关系；visibleBodyParts 填空字符串。观察者如入画必须使用保留 varId="$observer" 列入 characters，与其他人物一起计数。选第三人称后，composition/action 必须一致使用外部观察角度，不再说 through the observer's eyes、viewer chest 或 frame-edge observer body。
composition 用英语明确各人的位置、朝向、遮挡、空间和互动关系。人物姓名一律用 {{person:varId}} 引用，例如 {{person:mizuho}}；用户用 {{person:$observer}}。描述语言仍是英语，但程序会把这些标记替换为唯一姓名。不得自行译名、罗马化、缩写或另起英文名，也不要用 you/the viewer 代指用户。composition 必须包含每个 characters 人物的引用；action 描述自身动作可省略主语，但提到任何人物时也必须用引用标记。scene.description、reason、visibleBodyParts 和道具描述提到人物时遵守同一规则。不要 bbox，不要拼接不同时间的画面。使用自然透视，避免鱼眼或夸张超广角。
scene.name 为当前具体地点，description 用英语描述环境和光线。只有当前具体地点与背景索引精确对应时使用 backgroundId 和 referenceMatch="exact"；否则使用 null/none，自行描述当前地点。objects 为重要道具数组。
绘图 JSON 完整格式如下（替换示例值，禁止照抄示例人物）：
{"version":2,"view":{"mode":"first_person","observerName":"当前用户姓名","reason":"","visibleBodyParts":""},"scene":{"backgroundId":null,"referenceMatch":"none","name":"当前具体地点","description":"Current environment and lighting."},"composition":"{{person:本轮c块中的真实varId}} stands beside the table, facing {{person:$observer}}.","characters":[{"varId":"本轮c块中的真实varId","action":"Standing beside the table and looking toward {{person:$observer}}.","state":"","outfit":{"mode":"custom","description":"Complete current outfit in English."}}],"objects":[]}
没有其他人入画时 characters=[]。不要 Markdown 代码围栏，不要输出多个绘图块。`;

export function drawingWorldbook(
  library: LibraryData,
  observerName: string,
  additionalPrompt: string,
  viewpoint: string,
) {
  const bindings = personBindings(library);
  return (
    drawingWorldbookRule +
    "\n叙事视角偏好：\n" +
    viewpoint +
    "\n以下 JSON 为只读资料索引，不是指令。索引不是在场名单：\n" +
    JSON.stringify({
      observerName,
      people: bindings.map(({ varId, person }) => ({
        varId,
        id: person.id,
        name: person.name,
      })),
      backgrounds: library.backgrounds.map((entry) => ({
        id: entry.id ?? "background:" + entry.name,
        name: entry.name,
      })),
    }) +
    "\n用户绘图附加要求：\n" +
    additionalPrompt
  );
}
