# Monorepo 与 Pi 边界

Pi Workbench 采用 pnpm workspace + Turborepo，将 Web、数字人网关、共享合同、数据/知识 consumer 和 Pi 运行时拆成可独立构建的包。Web 不直接接触 Pi SDK；API 负责请求校验、数字人/Session 归属与安全边界；`packages/pi-agent` 负责数字人注册表、能力档案、session、turn 和事件收集。所有数字人都由 Pi `AgentSession` 驱动，并按宿主能力档案只启用只读工具，不直接修改外部状态。
