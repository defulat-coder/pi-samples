# Monorepo 与 Pi 边界

Pi Workbench 采用 pnpm workspace + Turborepo，将 Web、Agent Gateway、共享合同、数据/知识 consumer 和 Pi 运行时拆成可独立构建的包。Web 不直接接触 Pi SDK；API 负责请求校验与安全边界；`packages/pi-agent` 只负责创建 session、提交 turn 和收集事件。Pi 只启用只读工具，不直接持久化或修改外部状态。
