# 第一步：手动维护资料

在抽取设置中选择模型、系统提示词、输入模板、近期消息数量和字符上限。上下文包括角色设定、persona、非禁用世界书和近期聊天；超过上限会报错，不静默截断。

资料页的最后一句 prompt 作为末尾 user 消息发送。抽取只生成待审阅草稿，不会直接更新资料。保存增量时按名称或 id 合并，保留未返回的旧条目。手动编辑则替换当前资料。保存检查基准版本，旧版本保留。

输出协议：people 数组中的条目需要 name 和 appearance；backgrounds 数组中的条目需要 name 和 description。可添加其他 JSON 字段。

输入模板可引用 {{context}}、{{existingLibrary}}、{{instructions}}。参考示例见 examples/manual-profile.example.json。

逻辑存储键为 manual-config、library-<characterId>、library-<characterId>-revision-<revision> 和 last-prompt-<characterId>。文件访问通过当前 Risu 服务器认证接口完成。
