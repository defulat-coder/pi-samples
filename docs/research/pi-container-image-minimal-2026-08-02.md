# Pi Coding Agent 最小可运行容器镜像调研（2026-08-02）

## 结论先行

在本机 `linux/arm64`（Docker 报告为 `aarch64`）上，最小且已完成启动验收的方案是：以官方 `node:22.23.2-alpine3.24` 为基础，自行补上 `bash`、`ca-certificates`、`git`、`ripgrep`，再安装 `@earendil-works/pi-coding-agent@0.83.0`。本机镜像的 `docker save | gzip` 归档为 **86.4 MiB**，`docker image inspect` 的 `Size` 为 **91,024,219 bytes**；`pi --version` 返回 `0.83.0`，`pi --help` 成功。

这不是 Pi 官方发布的镜像，而是以官方 Node 镜像和官方 Pi npm 包构建的最小组合。若优先考虑跨平台兼容和官方文档路径，应使用 Pi 官方示例的 `node:24-bookworm-slim`，代价是基础镜像约 76 MB（压缩传输尺寸）且还要安装四个工具。社区镜像中，`michaelwadman/pi-agent:latest` 在 Docker Hub 仅声明 `linux/amd64`；`vibepod/pi:latest` 可在本机 arm64 运行，但明显更大。

## 口径与限制

- “能执行”在本文指容器内的 `pi` CLI 能启动并完成 `--version`、`--help` 等无模型调用检查。真正生成答案还需要在容器中提供模型 API key 或完成 `/login`；未提供 key 时 `pi -p` 退出并提示 `No API key found`，这不是镜像运行时错误。
- 镜像大小必须区分：Docker Hub 的 **compressed size**、本机 `docker image inspect .Size`、`docker save | gzip` 归档大小，以及 `docker image ls` 的本地层/虚拟大小。本文不把这些数字当作同一个指标。
- 数据和网页均按 2026-08-02 记录；`latest` 标签会漂移，生产部署应改用版本标签和 digest。

## 官方事实：Pi 的运行时和容器化路径

### Pi 官方容器文档

Pi 官方的 [Containerization 文档](https://pi.dev/docs/latest/containerization)（仓库原文：[containerization.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)）把 Plain Docker 定义为“整个 `pi` 进程在本地容器内运行”，并明确给出下面的 Dockerfile：

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

官方运行示例是：

```bash
docker build -t pi-sandbox -f Dockerfile.pi .
docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  pi-sandbox
```

官方文档同时说明：`$PWD:/workspace` 的写入会直接回写宿主机；使用命名卷保存容器内设置和 session；把宿主机 `~/.pi/agent` 挂入容器会暴露宿主机认证和 session 文件。`--ignore-scripts` 会关闭 npm lifecycle scripts，Pi 正常 npm 安装不依赖它们。

### 当前 Pi 包约束

官方 [package.json](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/package.json) 当前为 `@earendil-works/pi-coding-agent` **0.83.0**，其 `bin` 是 `pi`，`engines.node` 为 **`>=22.19.0`**。因此 Node 22.23.x 和 Node 24 都满足当前包的声明约束；本文本机最小镜像使用 Node 22.23.2。

官方 [Pi README 的权限/容器化说明](https://github.com/earendil-works/pi#permissions--containerization)指出，Pi 默认没有限制文件系统、进程、网络或凭据的内置权限系统，默认继承启动它的用户和进程权限。容器是隔离手段，不是 Pi 自带授权系统。

截至本文检索，官方仓库提供的是上述 Dockerfile 文档示例，而不是一个可直接 `docker pull` 的 Pi 专属官方镜像名；下面的社区镜像因此不能视为 Pi 官方供应链产物。

## 官方 Node 基础镜像事实

官方 [Node Docker Hub 页面](https://hub.docker.com/_/node)和 [nodejs/docker-node README](https://github.com/nodejs/docker-node/blob/main/README.md)给出以下边界：

- `node:<version>-alpine` 以 Alpine/musl 为基础，官方说明通常比 Debian `node:slim` 小约 25%；但 Alpine 不含 `git` 或 `bash`，需要自行 `apk add`。
- Alpine 使用 musl 而不是 Debian 使用的 glibc；官方警告依赖 glibc 的程序可能无法直接运行，必要时可尝试 `apk add --no-cache gcompat`。这属于兼容性补救，不应未经测试就默认加入。
- 官方 Node 镜像覆盖 `amd64`、`arm32v6`、`arm32v7`、`arm64v8`、`ppc64le`、`s390x` 等架构；README 还说明 Alpine 的 amd64 musl 构建为 Experimental，其他架构（包括 arm64）的 musl 构建不会在发布前测试，因此 Alpine 必须做目标架构实测。
- `node:<version>-slim`只保留运行 Node 所需的最小 Debian 包，兼容性比 Alpine 更保守。Pi 官方示例选 `node:24-bookworm-slim`，而不是 Alpine。

Docker Hub 当前标签页（[24-alpine 标签](https://hub.docker.com/_/node/tags?name=24-alpine&page=1)）显示的基础镜像传输尺寸示例：

| 官方 Node 标签 | linux/amd64 | linux/arm64/v8 | linux/s390x | 口径 |
|---|---:|---:|---:|---|
| `node:24-alpine3.24`（`node:24-alpine` 同指向当前系列） | 54.96 MB | 55.8 MB | 55.98 MB | Docker Hub compressed size |
| `node:24-alpine3.22` | 54.67 MB | 54.52 MB | 55.59 MB | Docker Hub compressed size；较旧维护线 |
| `node:24-alpine3.21` | 53.23 MB | 53.46 MB | 54.51 MB | Docker Hub compressed size；页面显示已约 8 个月未推送，不建议仅为省约 1–2 MB 而选它 |

Docker Hub 的 [Node 官方镜像页](https://hub.docker.com/_/node)列出 `24-bookworm-slim` 和 `22-bookworm-slim` 标签，并列出支持的架构；按该页标签详情记录，`node:24-bookworm-slim` 约为 amd64 **76.56 MB**、arm64/v8 **76.45 MB**，高于 Alpine 基础层，但这是 Pi 官方验证路径。

## 可选镜像比较

| 方案 | 维护/来源属性 | 目标架构 | 已观测大小 | Pi 可执行性 | 结论 |
|---|---|---|---|---|---|
| 自建 `pi-minimal:22-alpine`（`node:22.23.2-alpine3.24` + 四工具 + Pi 0.83.0） | 本地构建；基础层来自 Docker Official Image，Pi 包来自 Pi 官方 npm | 本机 `linux/arm64` 原生 | `docker image inspect .Size` 91,024,219 bytes；`docker save \| gzip` 86.4 MiB；`docker image ls` 显示约 462 MB 的本地层/虚拟大小 | `pi --version`、`pi --help` 成功；Node v22.23.2、bash、git、rg 均存在 | **当前最小可用推荐**；须接受 Alpine/musl 风险并自行维护 Dockerfile |
| 官方文档模板 `node:24-bookworm-slim` | Pi 官方文档推荐的 Dockerfile；Node 官方镜像 | 官方支持的多架构（含 amd64、arm64/v8） | 基础层约 76 MB compressed，安装四工具和 Pi 后更大 | 官方提供命令，兼容性最保守 | **兼容性优先推荐** |
| `michaelwadman/pi-agent:latest` | 社区维护者 Michael Wadman；[Docker Hub 页面](https://hub.docker.com/r/michaelwadman/pi-agent/tags)描述为 containerised Pi coding agent | Docker Hub 当前标签只列 `linux/amd64` | Docker Hub compressed 88.77 MB；本机 `inspect` 94,192,760 bytes（约 89.84 MiB） | `--platform=linux/amd64` 下本机 `pi --version` 为 0.83.0；原生 arm64 pull 报 `no matching manifest` | x86_64 可考虑；不适合作为本机 arm64 的最小方案 |
| `vibepod/pi:latest` | 社区 VibePod；[PyPI 项目说明](https://pypi.org/project/vibepod/)称所有 agent 镜像发布在 `vibepod` namespace，源 Dockerfile 在 [VibePod/vibepod-agents](https://github.com/VibePod/vibepod-agents) | 本机 `linux/arm64` 原生 | 本机 `inspect` 166,534,568 bytes；`docker save \| gzip` 157.7 MiB | 本机 `pi --version` 为 0.83.0；入口脚本为 `/usr/local/bin/entrypoint.sh`，工作目录 `/workspace` | 功能可用但明显大于自建 Alpine；只有需要其封装/入口行为时再选 |

“社区维护者事实”仅代表其 Docker Hub/PyPI 页面和本机拉取到的镜像元数据，不代表 Pi 项目审核或背书。

## 本机实测（2026-08-02）

### 环境

```text
Docker Client/Server: 29.1.3 / 29.1.3
Docker OS/Architecture: linux / aarch64
```

### 最小 Alpine 镜像

本机镜像的构建层显示等价于：

```dockerfile
FROM node:22.23.2-alpine3.24
ENV TERM=xterm-256color
RUN apk add --no-cache bash ca-certificates git ripgrep \
 && npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.83.0 \
 && npm cache clean --force
WORKDIR /workspace
ENTRYPOINT ["pi"]
```

验证命令和结果：

```bash
docker run --rm pi-minimal:22-alpine --version
# 0.83.0

docker run --rm pi-minimal:22-alpine --help
# 输出 Pi CLI usage/help

docker run --rm --entrypoint /bin/sh pi-minimal:22-alpine -c \
  'node --version; command -v bash; command -v git; command -v rg'
# v22.23.2
# /bin/bash
# /usr/bin/git
# /usr/bin/rg
```

无 API key 的启动探针：

```bash
docker run --rm --entrypoint /bin/sh pi-minimal:22-alpine -c \
  'pi --offline --no-session --no-tools --print "hello"'
# No API key found for the selected model.
# exit 1
```

这说明 CLI 已成功加载并走到 provider 凭据检查；要验证完整模型调用，仍需在隔离环境中注入测试用 key，本文不代替该网络/费用测试。

### 社区镜像

本机 `michaelwadman/pi-agent:latest` 原生 pull 失败：`no matching manifest for linux/arm64/v8`；指定 `--platform=linux/amd64` 后拉取成功，`docker run --platform=linux/amd64 ... --version` 返回 `0.83.0`。本机 `vibepod/pi:latest` 原生 arm64 拉取和 `pi --version` 均成功。以上大小是本机当前缓存镜像的测量，不能替代 Docker Hub 未来标签大小。

## 最小方案的构建与运行命令

将上面的 Alpine Dockerfile 保存为 `Dockerfile.pi-minimal` 后：

```bash
docker build --pull -t pi-minimal:22-alpine -f Dockerfile.pi-minimal .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  pi-minimal:22-alpine
```

非交互调用可把最后一行改为：

```bash
docker run --rm \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  pi-minimal:22-alpine -p "请列出 /workspace 中的 TypeScript 文件"
```

如果需要其他 provider，应按 Pi 官方 [providers 文档](https://pi.dev/docs/latest/providers)注入对应环境变量或使用 `/login`；不要把 key 写进 Dockerfile 或镜像层。

## 安全与维护注意事项

1. **权限边界**：Pi 默认继承容器进程权限；`-v "$PWD:/workspace"` 允许它改写宿主机项目。只挂载必要目录，敏感目录不要挂载；不要把宿主机 Docker socket 暴露给 Pi。
2. **凭据**：官方明确 Plain Docker 会把 provider API key 带入容器。优先通过 `-e`/受控 secret 注入；`/root/.pi/agent` 使用命名卷，避免直接暴露宿主机认证文件。
3. **供应链**：固定 Pi 版本、Node 版本和基础镜像 digest；不要把 `latest` 当作可复现版本。社区镜像应先阅读 Dockerfile/入口脚本并自行扫描，不能因镜像名含 `pi` 就视作官方。
4. **Alpine/musl**：Node 官方警告 glibc 依赖可能在 Alpine 失败；尤其是 optional/native 依赖、扩展和外部工具要在目标架构测试。只有遇到明确兼容问题时再加入 `gcompat`，因为它会增加体积且不能替代完整验证。
5. **工具完整性**：Pi 官方 Docker 示例显式安装 `bash`、`ca-certificates`、`git`、`ripgrep`。删掉任何一个都可能让内置 bash/搜索/仓库操作能力退化；因此不建议用 `scratch` 或 distroless 直接追求更小体积。
6. **运行时验证**：至少重跑 `pi --version`、`pi --help`、目标架构的容器启动探针，以及一次带测试 key 的最小 provider 调用；网络不可达或缺 key 时，要把失败归因于凭据/网络，而不是镜像本身。

## 来源索引

- Pi 官方容器化文档：[pi.dev/docs/latest/containerization](https://pi.dev/docs/latest/containerization)、[GitHub 原文](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)
- Pi 官方包元数据（版本、bin、Node engine）：[package.json raw](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/package.json)
- Pi 官方权限/容器化说明：[earendil-works/pi README](https://github.com/earendil-works/pi#permissions--containerization)
- Node Docker Official Image：[Docker Hub `node`](https://hub.docker.com/_/node)、[24-alpine 标签详情](https://hub.docker.com/_/node/tags?name=24-alpine&page=1)、[nodejs/docker-node README](https://github.com/nodejs/docker-node/blob/main/README.md)
- 社区镜像：[michaelwadman/pi-agent](https://hub.docker.com/r/michaelwadman/pi-agent/tags)、[VibePod Docker Hub 组织](https://hub.docker.com/u/vibepod)、[VibePod PyPI](https://pypi.org/project/vibepod/)、[VibePod agent Dockerfiles](https://github.com/VibePod/vibepod-agents)
