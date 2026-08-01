---
name: qoderwake-source-recovery
description: Archive each new local QoderWake version by recovering its Bun bundle source, Web assets, and immutable snapshot diff. Use when a user asks to recover source from a local management URL or capture and diff a newly installed QoderWake version.
---

# QoderWake 版本源码复刻

## 目标

把每次本机 QoderWake 版本更新固化成不可覆盖的源码快照。每次运行按可执行文件 SHA-256 去重；发现新版本时，恢复服务端 bundle 源码、嵌入 Web 资源、完整 JavaScript bundle，并生成相对上一快照的路径与内容变更清单。

这是**复刻快照**，不是重建原仓库。结果必须标注为 Bun 转译后材料，不得描述成官方原始 TypeScript 源码。

## 输入

每次版本更新后接受以下任一输入：

- 本机管理 URL，例如 `http://127.0.0.1:19820/management`；
- 本机 QoderWake 可执行文件路径。

URL 只接受 loopback 主机。没有 URL、可执行文件路径或可定位的 loopback listener 时，报告阻塞原因，不猜测远程来源。每次更新复用同一个 archive 根目录。

## 执行

### 1. 锁定当前版本

若输入是 URL，解析端口，用 `lsof` 找到 listener，再用 `lsof`/`ps` 得到 PID、启动命令和 Mach-O 可执行文件；若输入是路径，只读取该文件。读取同安装目录的 daemon 元数据以记录版本，范围限于进程版本信息。

完成条件：得到稳定的 `version + source_binary_sha256` 快照身份，并记录文件大小；URL 输入还记录 PID、端口和进程命令。

### 2. 归档新快照

调用同目录的 `scripts/track_qoderwake_versions.py`，始终指向同一个 archive 根目录：

```bash
python3 <skill-dir>/scripts/track_qoderwake_versions.py \
  --url http://127.0.0.1:19820/management \
  --archive qoderwake-source-archive
```

已知可执行文件时改用：

```bash
python3 <skill-dir>/scripts/track_qoderwake_versions.py \
  --binary /absolute/path/to/qoderwake \
  --archive qoderwake-source-archive
```

同一 SHA-256 已存在时只报告 `already_archived`，不重复生成。新 SHA-256 创建：

- `versions/<version>-<sha256 前 12 位>/`：完整源码、资源、bundle 和 manifest；
- `changes/<当前快照>-from-<上一快照>.md`：源码/资源新增、删除、内容变化和 bundle 是否变化；
- `index.json`：所有快照的版本、hash、路径、时间和变更报告。

脚本解析 Mach-O `__BUN/__bun`，恢复第一方 `src/` 与 `packages/*/src/` 模块，解码 `embedded-assets.generated.ts` 中的资源，并提取完整 bundle。快照目录必须为空或不存在；脚本拒绝覆盖既有内容。

完成条件：新版本已写入 `versions/` 并登记在 `index.json`，或已确认该二进制 hash 已归档。

### 3. 校验快照与差异

只做归档结果的本地校验：

- `index.json` 当前记录与版本目录 manifest 的 source hash 一致；
- manifest 列出的每个源码文件和嵌入资源存在且哈希一致；
- 完整 bundle 以 Bun bundle 头开始；
- 变更报告的前后快照 ID 与 `index.json` 一致；
- 报告实际恢复的文件数、片段数、资源数和字节数。

完成条件：校验无错误；若 bundle 头、模块标记或基线 manifest 不符合预期，保留诊断信息并报告失败，不继续归档其他内容。

### 4. 交付版本结果

最终只交付 archive 根目录、当前快照、变更报告和摘要。明确区分：

- 服务端：可读的转译后 bundle 源码；
- Web：生产构建资源，source map 以快照实际内容为准；
- 未恢复：原始类型、原始 import/export、测试、Git 历史、完整构建配置和未进入二进制的文件。

完成条件：用户能按 `index.json` 找到每个版本的源码、bundle、资源和 manifest，并从 `changes/` 看出版本差异；同时知道这些材料不是完整官方仓库。

## 范围边界

本技能的交付物只有版本源码快照、版本去重、快照校验和快照差异。运行页面、启动恢复版 daemon、启动 Mock、浏览器 QA、修复认证、复制账号数据、读取 SQLite、同步到其他项目、修改运行时、格式化/重建源码、GitHub 搜索和提交变更都不属于本技能。

恢复过程只读取进程元数据、版本元数据和选定可执行文件；不读取 `.auth`、数据库、日志或插件运行数据。

## 失败处理

- 无 listener：报告端口、检查命令和可观察到的进程状态。
- 找不到 Mach-O 或 `__BUN/__bun`：报告二进制类型和失败原因。
- archive 根目录已有同 hash：报告已归档并结束，不重写快照。
- 快照目录非空：报告冲突并停下来请求明确路径，不删除现有内容。
- 只有前端资源而没有可读第一方模块：报告“部分恢复”，不补写推断源码。

任何失败都在版本归档范围内结束，不扩展成运行时调试或项目改造。
