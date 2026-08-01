# Pi Workbench 知识库（兼容入口）

权威 Agent 知识文件已经收敛到 [`.pi/knowledge/`](../.pi/knowledge/)，这里保留一个兼容入口。文件采用 Google Open Knowledge Format（OKF）兼容的 Markdown + YAML frontmatter：每个非保留 Markdown 文件是一个 `concept`，`index.md` 只负责渐进式导航，数据库/FTS/RAG 索引属于可重建的消费层。

当前实现使用轻量本地 consumer 读取 OKF frontmatter，并做确定性的关键词召回；后续可以把这个 consumer 换成 QMD、SQLite FTS5 或 Google Knowledge Catalog，而不改变权威 Markdown。

Markdown 文件是可审阅的 Agent 知识，不是给模型的隐藏 prompt。修改资源后应在 PR 中保留版本记录，并在发布流程中接入 frontmatter 校验和过期检查。
