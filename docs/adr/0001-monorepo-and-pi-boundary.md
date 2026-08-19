# Monorepo 与 Pi 边界

Pi Workbench 采用 pnpm workspace + Turborepo，将 Web、Agent Gateway、共享合同、数据/知识 consumer 和 Pi 运行时拆成可独立构建的包。Web 不直接接触 Pi SDK；API 负责请求校验、Agent/Session 归属与安全边界；`packages/pi-agent` 负责 Agent profile、session、turn 和事件收集。所有业务 Agent 都由 Pi `AgentSession` 驱动，并按 profile 只启用只读工具，不直接修改外部状态。
