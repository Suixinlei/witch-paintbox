import type { ManualSettings } from "../domain/types";
import { text, template } from "../shared/text";
export function validateExtraction(settings: ManualSettings) {
  if (!["model", "submodel"].includes(settings.extractionModel))
    throw new Error("请选择主力模型或辅助模型");
  if (
    !text(settings.extractionSystem) ||
    !text(settings.extractionInputTemplate)
  )
    throw new Error("请配置抽取系统提示词和输入模板；插件没有内置提示词");
  if (!/\{\{\s*context\s*\}\}/.test(settings.extractionInputTemplate))
    throw new Error(
      "抽取输入模板需要 {{context}}，用于角色、世界书和近期聊天资料",
    );
  template(settings.extractionSystem, {
    instructions: settings.instructions,
    existingLibrary: "",
  });
  template(settings.extractionInputTemplate, {
    context: "",
    instructions: settings.instructions,
    existingLibrary: "",
  });
}
