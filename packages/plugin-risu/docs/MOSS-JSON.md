# 单次场景 JSON 协议 v3

2.2.1 主模型模式先读取消息内[绘图块 v2 与状态栏](MAIN-MODEL-GENERATION.md)，兼容已有 v1，本地转换为下述结构，不再调用第二步 DeepSeek。下述结构仍用于最终编译和兼容模式。

顶层字段为 view、scene、composition、characters、objects。view 包含 mode（first_person/third_person）、observerName（当前用户姓名）、reason 和 visibleBodyParts；第三人称必须解释原因。scene 包含 backgroundId、referenceMatch、name、description；characters 每项含 id、name、action、可选 state 及可选 outfit；state 为人物层的简短英语可见状态（裸露、开襟、透视、衣物滑落、湿身等），outfit 为 reference 或 custom，custom 的 description 是完整服装描述；objects 每项含 name、description。模型不输出 appearance 或最终提示词的重复副本。

characters 代表画内需要绘制的人物，可以完整入画或局部裁切。第一人称观察者不在其中，自然可见的手、手臂或躯干边缘仅由 visibleBodyParts 描述，不增加人数或引用全身 appearance；接触场景必须填写观察者自然可见的接触局部，没有接触时可为空。没有其他人物时 characters=[]。接触或体位关系复杂、第一人称无法同时交代双方身体时可以选择 third_person 并说明 reason。程序根据唯一画内人物统计人数，拒绝第一人称列入观察者、重复人物及观察者姓名不一致的结果，不自动修正或追加模型调用。

登记人物 ID 和姓名必须匹配同一条已保存资料。按 ID 读取原 appearance，保留原文，加入对应人物的 Name/Appearance/Action 段。未登记 NPC 使用 null ID 与本轮称呼，不伪造资料库外观引用。

referenceMatch=exact 时补入对应背景 description；nearby 不补入其他房间的固定布置；none 需要 backgroundId=null。场景的当前光线/环境与固定背景在 Scene 段分别标注。

未收录地点允许直接使用本轮场景描述。未知或不可用的背景引用在本地降为 none/null，不中断任务或调用模型修正，也不引用别处的固定背景。历史保留原响应及降级提示。

当前采用有明确分段的 text 提示词，不输出旧版 bbox/MOSS 布局 JSON。人物 state 会被放在提示词开头（Visible state 行），其余画风、前缀、人物与排版模板随插件构建，不在设置页显示或配置。
