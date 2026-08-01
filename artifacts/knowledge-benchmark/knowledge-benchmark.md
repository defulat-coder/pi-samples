# Local knowledge benchmark

Generated: 2026-08-01T18:07:24.929Z

## Configuration

- Implementation: `/Users/xbjt/Documents/myself/pi-samples/packages/workspace-data/dist/knowledge.js`
- Knowledge root: `/Users/xbjt/Documents/myself/pi-samples/.pi/knowledge`
- Warmup runs per query: 3
- Measured runs per query: 10
- Result limit: 5

## Index refresh

- Initial load and index refresh: 42.79 ms

## Bundle

| Files | Total body characters | Average body characters |
| ---: | ---: | ---: |
| 455 | 3015278 | 6627 |

## Aggregate search latency

| Samples | p50 (ms) | p95 (ms) | Mean (ms) |
| ---: | ---: | ---: |
| 150 | 0.007 | 0.019 | 0.008 |

## Uncached search latency

| Samples | p50 (ms) | p95 (ms) | Mean (ms) |
| ---: | ---: | ---: |
| 15 | 37.103 | 59.827 | 37.793 |

## Queries

| Query | Hits | First hit | p50 (ms) | p95 (ms) | Mean (ms) |
| --- | ---: | --- | ---: | ---: | ---: |
| Pi session 生命周期 | 1 | Session 生命周期：架构视角 | 0.007 | 0.019 | 0.009 |
| 创建 session 后如何提交 turn | 2 | Session 生命周期：架构视角 | 0.007 | 0.01 | 0.007 |
| 项目资源加载和 DefaultResourceLoader | 5 | 资源加载：实现视角 | 0.007 | 0.01 | 0.008 |
| .pi knowledge 是否自动加载 | 5 | 资源加载：验证与运维视角 | 0.008 | 0.018 | 0.009 |
| search_knowledge 只读 custom tool | 5 | 混合检索：验证与运维视角 | 0.007 | 0.03 | 0.012 |
| 工具权限和外部状态修改 | 5 | 工具执行：架构视角 | 0.006 | 0.007 | 0.006 |
| Agent 回答来源 evidence route | 5 | 证据回答：架构视角 | 0.006 | 0.012 | 0.007 |
| 没有模型凭据时的本地降级 | 4 | 降级回答：实现视角 | 0.006 | 0.019 | 0.007 |
| fallback 和真实 Pi 工具决策 | 5 | 本地降级 | 0.006 | 0.007 | 0.006 |
| 浏览器如何消费结构化回答 | 5 | 浏览器安全：架构视角 | 0.006 | 0.007 | 0.006 |
| Markdown 知识 bundle 的 Git 审阅 | 3 | Bundle 导航：验证与运维视角 | 0.006 | 0.019 | 0.008 |
| read 工具和 search_knowledge 的能力边界 | 5 | 能力注入：实现视角 | 0.008 | 0.02 | 0.009 |
| 事件流与 session 生命周期 | 1 | Session 生命周期：验证与运维视角 | 0.006 | 0.007 | 0.006 |
| API Gateway 创建或复用 session | 5 | Session 生命周期：架构视角 | 0.007 | 0.019 | 0.009 |
| 模型 provider 凭据在哪里保存 | 5 | SSE 通道：实现视角 | 0.008 | 0.027 | 0.01 |
