---
type: concept
title: Strict 模式：架构视角
description: 用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。让 null、unknown、联合类型和异步返回值在编译期暴露问题
resource: .pi/knowledge/library/typescript-engineering/strict-architecture.md
tags: [Pi, Agent, Kimi, 知识库, typescript-engineering, strict, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: typescript-engineering
topic: strict
variant: architecture
---

# TypeScript Strict 模式：把编译器变成架构边界的看门人

在 TypeScript 工程里，Strict 模式不是一组“更严格”的语法开关，而是一份把运行时风险前置到编译期的架构契约。启用它的真正目的，是让 `null`、`unknown`、联合类型和异步返回值在源码阶段就暴露边界错误，而不是等到联调、测试或生产日志才发现。本文从架构视角出发，先厘清概念、责任边界和可替换接口，再讨论具体实现。

## 摘要与问题边界

Strict 模式解决的核心问题是：类型系统过于宽松时，类型标注会伪装成安全保障，却无法覆盖真实运行路径。它通过 `strict: true` 及若干子选项，将 `null`、`undefined`、`any`、隐式隐式转换、未初始化变量、不兼容函数参数等高风险行为标记为编译错误。

本文的讨论边界限定在 monorepo 或多包协作的 TypeScript/Web/本地文件知识库场景，重点分析以下四类风险在编译期的暴露方式：
- 可空值（`null` / `undefined`）的越界访问；
- `unknown` 类型未经收窄直接消费；
- 联合类型分支 exhaustiveness 缺失；
- 异步函数返回值被当作同步值处理或错误类型被吞掉。

不讨论运行时类型校验库、Schema 校验器（Zod、Valibot 等）的选择，也不讨论 JavaScript 生态里无法被类型系统覆盖的输入源（例如 `JSON.parse`、`fetch` 响应体）。

## 核心概念与责任边界

1. `strictNullChecks`：可空性契约。
   打开后，`null` 和 `undefined` 不再自动属于所有类型的子类型。架构上意味着任何可能为空的值必须在声明、传递和消费的接口处显式处理，责任从“调用方猜”变成“声明方说”。

2. `strictPropertyInitialization`：构造完整性。
   类属性必须在声明时、构造函数中或通过 definite assignment assertion 初始化。它把“对象是否处于有效状态”的验证从运行时的防御性检查移到编译期。

3. `noImplicitAny`：匿名类型的拒绝。
   当类型推断退化为 `any` 时，编译器报错。架构意义在于阻断“类型系统失效”的隐藏通道，避免 `any` 污染跨包接口。

4. `noImplicitReturns` 与 `noUncheckedIndexedAccess`：返回值和索引访问的穷尽性。
   函数必须所有分支返回符合声明类型的值；数组索引和对象索引访问默认返回 `T | undefined`。这两点保护边界调用者不会拿到未经验证的假设。

5. `strictFunctionTypes`：函数参数协变的禁止。
   方法参数不再允许双向协变，接口替换原则（Liskov Substitution）在类型层面被强制执行。这是可替换接口能够成立的前提。

6. `useUnknownInCatchVariables` 与 `noImplicitOverride`：错误边界与继承边界的显式化。
   `catch` 子句默认捕获 `unknown`，避免把错误对象当 `Error` 直接消费；`override` 关键字要求重写父类方法时显式声明，防止基类签名变化后子类静默失效。

## 设计决策与取舍

### 1. 全量开启还是分阶段启用
`strict: true` 是 7 个独立选项的集合。对于存量项目，建议先通过 `strictNullChecks` + `noImplicitAny` 建立可空性基线，再逐步启用 `strictFunctionTypes`、`useUnknownInCatchVariables` 等影响调用协约的选项。一次性打开会产生数千个错误，超出团队消化能力，反而破坏信任。

### 2. 编译错误是否阻断 CI
架构上必须阻断。CI 流程中任何 `tsc --noEmit` 失败都应阻止合并。但允许为边界外依赖使用 `// @ts-expect-error` 并附带理由与工单号，避免“临时禁用”变成永久漏洞。

### 3. 是否允许 `any` 作为逃逸舱
允许，但需显式审批。可在 ESLint 中配置 `no-explicit-any` 为 error，并通过 `// eslint-disable-next-line` 与审批脚本强制留痕。关键接口禁止 `any` 出包，防止跨团队契约被稀释。

### 4. `unknown` 还是泛型约束
当数据来源不可信（CLI 参数、文件读取、外部 API）时，优先用 `unknown` + 类型守卫。当来源可信但形状多样时，用泛型约束 `<T extends BaseShape>`。不要为了让调用方便而在入口使用 `as` 断言。

### 5. 异步返回值的处理策略
`Promise<T>` 不能省略 `await`，也不能把 `T | Promise<T>` 混用。建议约定：所有 I/O 边界函数返回 `Promise<Result<T, E>>` 或抛出结构化错误；调用方必须显式 `await` 并在 `catch` 中处理 `unknown` 错误。

## 可执行的实施流程

1. 基线评估：在现有代码上运行 `tsc --noEmit --strict`，记录错误数量、文件分布与类型，输出到 `strict-migration-report.json`。
2. 关闭顶层 `strict: true`，改为逐项开启 `strictNullChecks` 和 `noImplicitAny`，修复这两类错误后再合并。
3. 把公共 API 包（contracts）设为最先达标的目标，确保跨包接口不传递 `any` 和未处理的可空值。
4. 在 packages 内引入类型守卫工具函数，例如 `isDefined<T>(x: T | null | undefined): x is T`，统一替换 `x!` 非空断言。
5. 对 `unknown` 入参建立标准化收窄路径：`unknown → 基础类型守卫 → 结构验证 → 业务类型`。
6. 为所有 `catch` 子句启用 `useUnknownInCatchVariables`，并封装 `toAppError(error: unknown)` 将未知错误映射为业务错误。
7. 在 CI 中加入 `tsc --noEmit --pretty false`，并配合 GitHub Action/Check 把错误行内注释到 PR。
8. 建立豁免清单 `strict-exceptions.json`，记录每个 `ts-expect-error` 或 `eslint-disable` 的理由、负责人和清理截止日期。
9. 运行完整测试套件，确认修复类型错误时没有改变运行时行为；对仅类型重构进行回归。
10. 迁移完成后，设置 `strict: true` 并冻结配置；后续新增子选项通过 ADR 评估。

## 输入、处理与输出示例

下面给出一个贴近 TypeScript/Web/本地文件知识库的配置与类型守卫示例。

tsconfig.json 节选：

{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "useUnknownInCatchVariables": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true
  }
}

知识库文档读取函数：

type Doc = { id: string; title: string; content: string };

function isDoc(input: unknown): input is Doc {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.content === "string"
  );
}

async function loadDoc(path: string): Promise<Doc> {
  const raw = await fs.readFile(path, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!isDoc(parsed)) {
    throw new AppError("INVALID_DOC", `文档结构不合法: ${path}`);
  }
  return parsed;
}

输入：本地 Markdown/JSON 知识库文件，内容不可信。
处理：`JSON.parse` 返回 `any`，立即赋值给 `unknown`；经 `isDoc` 收窄为 `Doc`。
输出：调用方拿到类型安全的 `Doc`，且 `catch` 块中的错误类型为 `unknown`，必须通过 `toAppError` 转换。

## 性能、质量与可观测性指标

1. 编译错误密度：每千行 TypeScript 代码中 Strict 相关错误的数量。通过 `tsc --noEmit` 错误数除以 `cloc` 统计的有效代码行计算，迁移期每周下降应不低于 20%。
2. `any` 密度：使用 `typescript-eslint` 的 `@typescript-eslint/no-explicit-any` 规则扫描 `explicit-any` 出现次数，目标在核心包降为零。
3. 非空断言比：统计 `!` 后固定表达式的使用频率，配合代码审查把每个 `!` 与对应的类型守卫或重构工单挂钩。
4. 运行时 Null/Undefined 报错率：在 Sentry/Error Boundary 中按错误类型聚合，观察 `Cannot read properties of undefined` 类报错是否随 Strict 迁移下降。
5. 接口变更类型安全得分：对接口文件运行 `tsc` 并检查是否出现新的隐式 `any` 或函数参数协变错误；每次发布前作为门禁。

## 失败模式、诊断证据与恢复动作

1. 类型守卫遗漏分支。
   证据：编译器提示 `TS2345`，或运行时 switch/case 出现 `never` 被意外赋值。
   恢复：补充分支并添加 `exhaustiveCheck` 辅助函数，把剩余联合成员映射到 `never`。

2. `any` 跨包泄漏。
   证据：下游包调用上游函数时失去类型提示，或出现 `TS7006: Parameter implicitly has an 'any' type`。
   恢复：在接口层用 `unknown` 替换 `any`，并为消费方提供类型守卫。

3. 异步返回值被当作同步值。
   证据：`TS1320` 或运行时 `Promise { <pending> }` 被序列化。
   恢复：强制 `await`，统一返回 `Promise<T>`，并在 lint 中开启 `require-await` 或 `@typescript-eslint/no-floating-promises`。

4. `catch` 中的 `unknown` 未处理。
   证据：`TS18046` 或错误日志只显示 `[object Object]`。
   恢复：封装 `toAppError`，在顶层错误边界统一转换，避免在业务代码中直接访问 `error.message`。

5. 泛型约束过宽导致联合类型收窄失败。
   证据：`TS2322` 出现在使用 `T extends string` 但分支未覆盖所有字符串字面量时。
   恢复：把字符串字面量联合显式枚举，或使用模板字符串类型收窄，避免把业务标签泛化为 `string`。

## 问答测试样例

1. 问：启用 `strictNullChecks` 后，`string` 类型能否赋值为 `null`？
   答：不能。`null` 不再自动成为 `string` 的子类型，除非显式声明为 `string | null`。

2. 问：为什么 `JSON.parse` 的结果应标记为 `unknown`？
   答：因为它返回 `any`，直接解构会让非法结构在运行时崩溃；先转为 `unknown` 再经类型守卫收窄，可让错误在消费前暴露。

3. 问：一个函数声明返回 `Promise<User>`，但实现分支返回了 `User`，是否会报错？
   答：会。在 `noImplicitReturns` 或异步一致性检查下，缺少 `Promise` 包装属于类型不兼容。

4. 问：是否所有项目都应该一次性打开 `strict: true`？
   答：不一定。这是设计决策，取决于代码规模、测试覆盖和团队消化能力；大规模存量项目建议分阶段启用。

5. 问：当 `catch` 变量为 `unknown` 时，如何安全读取错误消息？
   答：使用类型守卫或 `toAppError` 转换，不要直接假设 `error instanceof Error`，因为可能抛出字符串、数字或对象。

6. 问：Strict 模式能否完全消除运行时 `null` 错误？
   答：不能。Strict 模式是编译期防护，无法阻止外部 JSON、DOM API 或第三方库返回违反契约的值，因此边界处仍需运行时校验。

## 维护、版本、来源与相邻主题

本条目随 TypeScript 版本演进维护。`strict: true` 的具体子项会随编译器版本增加，例如 `useUnknownInCatchVariables` 来自 4.4，`exactOptionalPropertyTypes` 来自 4.4。建议每次升级 TypeScript 后重新评估 `tsconfig` 并运行全量类型检查。

与相邻主题的关系：
- 与类型守卫和自定义类型谓词：Strict 模式是“强制使用”这些工具的环境，而不是替代它们。
- 与 ESLint/`typescript-eslint`：类型检查负责编译期真值，lint 负责代码风格与部分类型相关坏味道，两者互补。
- 与运行时校验库（Zod、io-ts）：Strict 处理编译期契约，运行时校验处理外部不可信输入，推荐在 I/O 边界同时使用。
- 与 Monorepo 架构：`tsconfig` 的继承关系和 `references` 配置会影响 Strict 选项的传播路径，应在根配置统一基线、子包按需收紧。
- 与测试策略：类型修复属于纯静态变更，但仍需回归测试，因为 `as` 断言和类型守卫逻辑可能改变运行时分支。

## 结论

事实：TypeScript Strict 模式通过 `strictNullChecks`、`noImplicitAny`、`useUnknownInCatchVariables` 等子选项，把大量原本在运行时才暴露的 `null`、`unknown`、联合类型和异步返回值问题，转化为编译错误。
推论：在 monorepo 中，先让 contracts 包达标、再向下游推进，是最可持续的迁移策略； Strict 模式与类型守卫、运行时校验库共同构成边界防御。
未知：特定团队对编译错误容忍度、遗留代码重构成本、以及未来 TypeScript 新增子项对现有架构的具体影响，需要项目级度量和评估，无法从通用结论直接得出。
