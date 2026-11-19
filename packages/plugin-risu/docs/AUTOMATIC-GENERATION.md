# 第二步：单次 DeepSeek JSON（兼容模式）

2.2.0 默认使用[主模型绘图与本轮在场名单](MAIN-MODEL-GENERATION.md)。本文仅描述关闭“由主模型输出绘图块”后的旧流程。

每个新任务只调用一次现有 DeepSeek 连接，设置 JSON 输出模式并关闭流式。模型输出 view、scene、composition、characters（id、name、action、可选 state 及可选 outfit）、objects。state 是人物层的简短英语列表，描述本轮裸露、开襟、透视、衣物滑落等可见状态，程序将其放在最终提示词开头（Visible state 行），提升严格遵从；outfit 为 reference 或 custom，custom 的 description 仍是完整服装描述。appearance 与固定背景 description 不发送给模型，分别按画内人物 ID 和精确背景引用在本地补入。第一人称观察者使用当前用户姓名，不列入完整画内人物或全身外观引用；可见局部不增加人物数。

输出协议及排版见 src/step2/templates.ts。系统提示词、输入模板、画风、视角、人物模板和最终排版内置于插件，不从保存配置读取，也不在设置页显示。

队列串行处理，重复事件去重。调用前持久化标记，空响应、截断、HTTP/网络错误、字段错误都不自动重试；请求结果未保存时刷新也不会重发。没有外观整理、自动 JSON 修正或备用模型调用。

任务的模型原始响应和用量保留，但凭据不进入任务。已提交 ComfyUI 的任务可继续查询，不重新调用模型。缺少第一步资料时在请求前停止。
