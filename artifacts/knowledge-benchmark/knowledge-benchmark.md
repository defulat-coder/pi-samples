# Local knowledge benchmark

Generated: 2026-08-01T16:18:47.534Z

## Configuration

- Implementation: `/Users/xbjt/Documents/myself/pi-samples/packages/workspace-data/dist/knowledge.js`
- Knowledge root: `/Users/xbjt/Documents/myself/pi-samples/.pi/knowledge`
- Warmup runs per query: 3
- Measured runs per query: 10
- Result limit: 5

## Bundle

| Files | Total body characters | Average body characters |
| ---: | ---: | ---: |
| 455 | 3016857 | 6630.5 |

## Aggregate search latency

| Samples | p50 (ms) | p95 (ms) | Mean (ms) |
| ---: | ---: | ---: |
| 150 | 62.503 | 73.465 | 62.398 |

## Queries

| Query | Hits | First hit | p50 (ms) | p95 (ms) | Mean (ms) |
| --- | ---: | --- | ---: | ---: | ---: |
| Pi session 生命周期 | 5 | Session 生命周期 | 62.54 | 64.906 | 62.842 |
| 创建 session 后如何提交 turn | 5 | Session 生命周期 | 62.895 | 64.062 | 62.962 |
| 项目资源加载和 DefaultResourceLoader | 5 | 项目资源加载 | 57.125 | 59.369 | 57.298 |
| .pi knowledge 是否自动加载 | 5 | API 设计：架构视角 | 60.03 | 61.959 | 60.292 |
| search_knowledge 只读 custom tool | 5 | 工具执行：架构视角 | 62.314 | 63.455 | 62.422 |
| 工具权限和外部状态修改 | 5 | 工具权限边界 | 56.812 | 59.323 | 57.04 |
| Agent 回答来源 evidence route | 5 | 证据回答：架构视角 | 73.647 | 75.227 | 73.94 |
| 没有模型凭据时的本地降级 | 5 | 本地降级 | 51.42 | 52.226 | 51.524 |
| fallback 和真实 Pi 工具决策 | 5 | 工具权限边界 | 69.955 | 71.789 | 70.092 |
| 浏览器如何消费结构化回答 | 5 | 回答契约 | 51.015 | 55.146 | 51.465 |
| Markdown 知识 bundle 的 Git 审阅 | 5 | Bundle 导航：实现视角 | 70.246 | 72.044 | 70.393 |
| read 工具和 search_knowledge 的能力边界 | 5 | 工具执行：实现视角 | 66.707 | 68.65 | 67.101 |
| 事件流与 session 生命周期 | 5 | Session 生命周期 | 63.394 | 65.228 | 63.591 |
| API Gateway 创建或复用 session | 5 | Session 生命周期 | 66.407 | 68.176 | 66.751 |
| 模型 provider 凭据在哪里保存 | 5 | 权限模型：架构视角 | 57.134 | 63.462 | 58.249 |
