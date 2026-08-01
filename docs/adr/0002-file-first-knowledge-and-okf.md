# 文件优先的 Agent 知识边界

Pi Workbench 将 `.pi/knowledge/` 下的 Markdown 文件作为项目 Agent 知识的权威来源，采用 OKF-compatible YAML frontmatter。API 不根据用户问题做语义路由，而是把本地 consumer 封装成 Pi 可调用的只读 `search_knowledge` 工具；Pi 决定是否搜索，再按需要调用 `read` 获取完整文件。未来可以把 consumer 替换为 QMD、SQLite FTS5 或托管索引，而不改变 `.pi/knowledge` 文件源。
