# Pi 沙箱边界核对（2026-08-02）

## 结论

Pi 没有内建的 OS、进程、文件系统或网络沙箱。它默认以启动 Pi 的用户权限运行；内建工具和 extensions 与 Pi 进程共享这条权限边界。

Pi 的 **project trust** 只控制是否加载项目本地 settings、resources、packages 和 extensions，不限制模型在已经启动的目录中要求工具执行什么，因此不是 sandbox。SDK 的 `tools`/read-only allowlist 只是能力配置：可以不注册 `bash`、`edit`、`write`，但它不替代操作系统隔离。

真正的隔离要由部署层提供，例如把整个 Pi 放进 Docker、VM、micro-VM 或 OpenShell，或者把内建工具执行路由到隔离环境；同时按需限制挂载目录、凭据和网络出口。

## 当前仓库核对

- `packages/pi-agent/src/index.ts` 的 `createPiAgentSession()` 只注册 `read` 和项目自定义的 `search_knowledge`，并设置 `noExtensions: true`、`noThemes: true`。
- `search_knowledge` 只检索本地 Markdown；API/合同层把工具标为 `read-only`。
- 这能把当前 Agent loop 的可调用能力收窄到只读，但仍不是 OS 级沙箱。若 API 进程、额外 custom tool、extension 或宿主凭据本身有写入/执行能力，仍需在宿主权限、容器/VM、凭据和网络策略层重复约束。

## 一手来源

- [Pi Security](https://pi.dev/docs/latest/security)：明确说明 Pi 继承启动用户权限、project trust 不是 sandbox、没有 built-in sandbox。
- [Pi Containerization](https://pi.dev/docs/latest/containerization)：说明全进程隔离、Gondolin micro-VM、Plain Docker、OpenShell 和工具路由模式。
- [Pi SDK](https://pi.dev/docs/latest/sdk)：说明 `tools` allowlist 和 `createAgentSession()` 的工具配置。
