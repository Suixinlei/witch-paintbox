export function imagePlanningInput(plan, items) {
    if (!items)
        return plan.text;
    const positions = items.map(({ pointIds }, index) => pointIds.length === 1
        ? `【配图 ${index + 1}：在 ${pointIds[0]} 插入】`
        : `【配图 ${index + 1}：在 ${pointIds[0]} 到 ${pointIds[pointIds.length - 1]} 范围内插入；可用插入点：${pointIds.join(', ')}】`).join('\n');
    return `${plan.text}\n\n<指定插图位置锁定>\n本次为人工指定插图位置模式：\n以下清单每项生成 1 张配图。单点项必须使用该编号；范围项必须从该范围列出的可用插入点中选择 1 个编号作为 at。严禁选择清单以外的位置，严禁遗漏或重复同一项。\n${positions}\n</指定插图位置锁定>`;
}
