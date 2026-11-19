# 主模型绘图与本轮在场名单

从 2.2.0 起，新任务默认使用主模型绘图模式。沿用协议 v3 的任务、资料存储及 ComfyUI 文本工作流；2.2.1 注入的消息内绘图块采用独立协议 v2，仍兼容已有 v1 绘图块。旧任务保留原设置快照；关闭“由主模型输出绘图块”可使用旧的单次 DeepSeek 模式，不作失败回退。

## 人物 ID

人物资料可填写 `varId`，为空时沿用原 `id`。这是与状态栏的对应，不按姓名猜测、不自动改写资料。人物 ID、varId、背景及服装引用比较时忽略大小写和首尾空格，最终计划恢复资料库原有 ID 写法；聊天身份与资源路径不作大小写转换。界面“基本资料”可以编辑；仅大小写不同的重复 ID/映射同样报错，不任意选一条。旧资料的外观和服装保持原样。无稳定 ID 的人物需先补齐映射。

当前场景在场名单仅取本条原始回复中的 `<statusData>c|varId:…|equipment:…|…</statusData>`。必须恰好有一个 `u` 块；其他人物零个或多个，不能重复。没有状态块、不完整块、未知入画 ID 均停止，不累加历史名单。未入画人物可以没有资料映射；入画人物必须有。

## 动态世界书

`beforeRequest` 仅在自动生图开启、主模型模式启用、请求模式为 `model` 时注入一条系统消息：世界书补充规则、当前用户姓名、最新人物 varId/ID/姓名和场景索引、附加要求及视角偏好。索引不包含固定外观，不代表在场名单。不改写角色卡或全局世界书。规则覆盖旧的“1–2 个 c 块”限制，保留原有状态栏字段与数值结算要求。重复处理请求替换本插件之前注入的规则；卸载时移除监听器。

主模型正常写正文和状态栏，最后将绘图块放进 `<details><summary>绘图描述</summary>…</details>`，供折叠查看。它会占用主模型输出预算；插件不修改全局输出长度。不具有本协议的历史回复不能直接在新模式补图，可选择旧模式处理。

## 绘图块 v2

每条回复恰好一个完整块，严格 JSON，不带代码围栏：

```xml
<image_prompt>
{"version":2,"view":{"mode":"first_person","observerName":"当前用户姓名","reason":"","visibleBodyParts":""},"scene":{"backgroundId":null,"referenceMatch":"none","name":"花园","description":"A sunlit garden."},"composition":"{{person:alice}} sits on the left; {{person:beth}} stands beside the table on the right.","characters":[{"varId":"alice","action":"Sitting on the left, holding a cup and looking toward {{person:beth}}.","state":"","outfit":{"mode":"custom","description":"A complete English description of the current outfit."}},{"varId":"beth","action":"Standing on the right and looking toward {{person:alice}}.","state":"","outfit":{"mode":"custom","description":"A complete English description of the current outfit."}}],"objects":[]}
</image_prompt>
```

- `characters` 可以是在场人物的子集，每个 varId 只出现一次。禁止模型输出 `appearance`，固定外观由插件按精确绑定补入。
- `action` 描述动作、位置、表情及互动；`composition` 交代单一时刻内多人的空间关系，不猜测发色等固定外貌。描述使用英语，人物称呼一律用 `{{person:varId}}`，用户用 `{{person:$observer}}`。composition 必须引用每名入画人物。插件本地替换为统一姓名，未入画或未知 ID 的标记停止任务，不增加模型调用。资料库明确的唯一姓名、别名、括号内英文名及与 ID 对应的英文名成分也可本地还原；不猜测未知译名，不重复展开完整姓名中的英文注释。
- 本轮 `equipment` 非空时必须给出完整 `custom` 服装描述，替代默认服装；插件同时保留本轮 equipment 原文（br 换行转分号）并明确其优先于外观中的旧衣着，避免静默丢失当前状态。不把 status 中的心理/数值状态自动作为可见特征加入图片。
- 先按实际姿势与观察者眼睛位置判断可见范围，再选镜头。第一人称是偏好；相拥入睡、脸贴胸前或颈窝、观察者闭眼、需要交代双方整体姿态时，允许第三人称，不受人数限制。第一人称观察者不在 characters 中，可见局部写入 `visibleBodyParts`。第三人称需 reason 并清空 visibleBodyParts；用户确实入画时以 `$observer` 列入 characters 并计数，允许没有用户固定外观资料。保留用户资料使用 `user` ID/varId 并校验姓名。
- 环境图允许 characters=[]。背景精确匹配才补入固定背景；未知引用沿用原有降级规则。不存在参考图输入、多图拼接或人物坐标协议。

## 执行与恢复

插件保留原始回复、资料和设置快照，本地转换为现有 ScenePlan，再复用逐人外观、服装、场景、构图编译及原队列/挂图流程。额外模型调用为零。错误绘图块不自动修正、不回退其他模型。预览也是本地解析，不请求模型或 ComfyUI。

输出事件只处理已提交的完整回复。消息级补图/重画会按原聊天及消息 ID 重新读取原始回复，并验证正文仍匹配，避免状态块被宿主预先清理。已提交任务刷新后只查询原 prompt_id，不重复提交；不确定提交沿用人工确认机制。

E2E 使用隔离宿主模拟消息、模型和 ComfyUI，不向真实聊天发消息或调用真实生图。它验证协议、选人、prompt 和队列；不能证明 MOSS 最终像素中的人数、外观和互动准确。

`e2e/copiedChat.live.spec.ts` 默认跳过。用户明确要求真实验收时，将完整会话复制到独立本地目录，准备私有 `live-input.json`，设置 `RISU_PLUGIN_LIVE_COPY` 后单独运行此 Playwright 测试：使用复制会话末轮片段、现有主模型连接和完整插件动态规则，在隔离宿主中编译，再用既有工作流真实生图。凭据只在本地隔离目录，不能提交或打印；不修改源聊天。已保存模型响应与 prompt_id 可复用，避免验收重入导致重复请求。
