# 文件定义数字人，宿主定义能力

Pi Workbench 将产品角色定义为 `.pi/digital-humans/*.json` 中的数字人，而不是在运行时代码里固定 Agent 分支；Pi `AgentSession` 只负责执行。数字人档案可以定义身份、职业和沟通方式，但只能引用宿主已有的能力档案，不能声明工具。这在可扩展角色体验与不可被项目文本提升的权限之间建立了明确 seam；旧 `agentId`、旧 Session binding 和本地降级回答不保留。
