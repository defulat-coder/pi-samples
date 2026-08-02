---
description: 复盘一条 Pi JSONL Session 的消息树、工具过程和指标
argument-hint: "<session 文件路径>"
---

请复盘 Session 文件 ${1:-.pi/sessions}，重点关注：

- `id` / `parentId` 树结构和当前分支；
- user、assistant、thinking、toolResult、compaction 与 custom entry 的顺序；
- input/output/cache/total Token、成本、Context Window；
- 工具调用、错误、重试、压缩和 Agent settled 边界；
- 是否存在无法解析、重复、缺失或应用层自定义指标。

只读文件并引用 entry 类型和路径；不要修改 Session 文件。若路径不是 Session JSONL，先说明无法按本模板复盘。
