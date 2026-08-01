---
type: concept
title: Strict 模式：验证与运维视角
description: 用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。让 null、unknown、联合类型和异步返回值在编译期暴露问题
resource: .pi/knowledge/library/typescript-engineering/strict-operations.md
tags: [Pi, Agent, Kimi, 知识库, typescript-engineering, strict, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: typescript-engineering
topic: strict
variant: operations
---

# TypeScript Strict 模式：在编译期把 null、unknown、联合类型与异步返回值变成可观测的故障证据

## 摘要与问题边界

在运维与验证视角下，一次 200 OK 的响应只能证明“这次请求成功”，不能证明系统下一次不会崩溃。TypeScript Strict 模式的核心价值，是把编译器从“类型标注器”升级为“不变量检查器”：在代码交付前，让 `null` 解引用、`unknown` 未收窄、联合类型分支遗漏、异步返回值被误用等问题以可计数、可追踪、可修复的方式暴露出来。

本文讨论范围限定在 TypeScript 4.x 至 5.x 的 `tsconfig.json` 编译选项，重点围绕 `strict: true` 及其子开关。它不适用于纯 JavaScript，也不替代运行时校验、单元测试、可观测性监控。Strict 模式在编译后会被擦除，因此不能提供运行时沙箱或类型安全证明；它提供的是“在变更进入生产前增加一道可验证的静态屏障”。

## 核心概念与数据模型

1. `strictNullChecks`：把 `null` 与 `undefined` 从“所有类型的底层成员”提升为显式联合成员。任何 `string | null` 变量在调用 `.length` 前，必须通过 `if (x !== null)`、可选链或类型守卫收窄，否则编译器报错。
2. `noImplicitAny`：禁止表达式隐式退化为 `any`。所有参数、返回值、索引访问必须能被推断或显式标注，迫使工程师把“我不知道”写成 `unknown` 而不是悄悄变成 `any`。
3. `strictFunctionTypes`：对函数参数启用更严格的逆变检查。它防止把 `(x: Base) => void` 的回调错误地赋给期望 `(x: Derived) => void` 的位置，减少事件处理器与数据转换函数中的类型泄露。
4. `useUnknownInCatchVariables`：把 `catch (err)` 中的 `err` 默认类型从 `any` 改为 `unknown`。访问 `.message` 或 `.code` 前必须先做 `instanceof Error` 或自定义类型守卫，否则属于未验证的假设。
5. `noUncheckedIndexedAccess`：数组与索引签名访问返回 `T | undefined`，而不是假装结果一定存在。它强制调用方处理“键不存在”或“数组越界”分支，把联合类型的完整性推到边界。
6. 显式异步返回契约：在 `async function` 中，返回值必须可赋给 `Promise<T>`。配合 `noImplicitReturns` 与显式签名，可防止“把 Promise 对象当成结果传递”或“在同步分支中返回未 await 的 Promise”。

## 设计决策与取舍

### 全量开启 versus 渐进迁移
`strict: true` 一次性打开所有子开关，能暴露全部债务，但可能导致 CI 立即失败、阻塞发布。渐进式迁移按 `noImplicitAny` → `strictNullChecks` → `strictFunctionTypes` → `useUnknownInCatchVariables` 的顺序推进，可控性更高，但中途存在“部分文件仍处在非严格世界”的灰色地带。

### 非空断言 `!` 的记录与审批
`!` 是绕过 `strictNullChecks` 的合法语法，但它不会消除运行时 `null`。项目应把每次使用 `!` 视为一次“手动担保”，要求附带测试、注释或监控埋点，否则应尽快用类型守卫替换。

### `any` 与 `unknown` 的边界策略
遗留边界或外部数据进入系统时，可允许 `any` 作为临时逃生舱，但必须有明确的转换层把 `any` 收窄为 `unknown` 再进入业务逻辑。`unknown` 的强制收窄会增加代码量，但能把外部不确定性限制在转换层。

### 联合类型穷尽检查的成本
要求 `switch` 或 `if-else` 覆盖所有联合分支，并在 `default` 分支使用 `assertNever`，会增加样板代码。但当枚举或配置项未来扩展时，编译器会立刻指出漏改的地方，避免静默进入未定义行为。

### 异步返回类型严格化
把服务层函数签名统一为 `Promise<T>`，并在调用处显式 `await` 或 `.then()`，可防止回调式代码把同步值与异步值混用。代价是类型签名变得更冗长，需要配套生成 DTO 类型与共享契约包。

## 可执行的实施流程

1. 基线快照：在目标分支运行 `pnpm typecheck` 或 `tsc --noEmit`，记录错误总数、分类、文件分布与最长错误链。
2. 选择优先级：先启用影响面最大且与主题直接相关的 `noImplicitAny` 和 `strictNullChecks`，再处理 `strictFunctionTypes` 与 `useUnknownInCatchVariables`。
3. 在 `tsconfig.json` 中打开目标开关，并把 `tsc --noEmit` 加入 CI 门禁，设置“禁止新增错误”阈值。
4. 错误清单化：按错误码与模块拆分任务，优先修复 `packages/contracts`、`packages/pi-agent` 等被多个应用依赖的共享包。
5. 引入类型守卫：为外部输入、API 响应、文件读取结果定义 `isNonNullable`、`isApiError` 等可复用窄化函数。
6. 对联合类型启用穷尽检查：在 `default` 分支使用 `assertNever(value: never)`，确保新增分支时编译失败。
7. 在 PR 流程中增加类型差异检查：对比目标分支与当前分支的 `tsc` 错误数量，新增错误必须零增长。
8. 固化与监控：把最终 `tsconfig.json` 与 `pnpm typecheck` 脚本锁入版本控制，建立“每周 `any` 与 `!` 数量”“未处理 `unknown` 数量”等 SLO 并定期审计。

## 贴近本地文件知识库的代码示例

输入：一个本地 Markdown 文件路径，期望返回 `{ title, tags, content }` 或错误。

处理：使用 `fs/promises` 异步读取，在 `strictNullChecks`、`useUnknownInCatchVariables`、`noUncheckedIndexedAccess` 全部启用的情况下编译。

```json
{
  "compilerOptions": {
    "strict": true,
    "useUnknownInCatchVariables": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true
  }
}
```

```typescript
type Page = { title: string; tags: string[]; content: string };

function parseHeader(raw: string): string | null {
  const m = raw.match(/^#\s+(.+)$/m);
  return m?.[1] ?? null; // m[1] 受 noUncheckedIndexedAccess 影响为 string | undefined
}

async function loadPage(path: string): Promise<Page | null> {
  try {
    const raw = await fs.readFile(path, "utf-8");
    const title = parseHeader(raw);
    if (title === null) return null; // strictNullChecks 强制分支
    const tags = raw.match(/tags:\s*\[(.+?)\]/)?.[1]?.split(",") ?? [];
    return { title, tags, content: raw };
  } catch (err: unknown) {
    if (err instanceof Error) {
      logger.error({ message: err.message, path });
    }
    return null;
  }
}
```

输出：当文件不存在或格式错误时，函数返回 `null` 而不是抛出未定义行为；当 `err` 不是 `Error` 实例时，不会盲目访问 `.message`。编译器通过 `strictNullChecks` 阻止 `title.length` 的未保护调用，通过 `noUncheckedIndexedAccess` 把 `m?.[1]` 视为 `string | undefined`，通过 `useUnknownInCatchVariables` 阻止 `err.message` 直接访问。

## 性能、质量与可观测性指标

1. 编译错误数及趋势：每周运行 `tsc --noEmit` 并记录错误总量，按 `TS18047`、`TS2571`、`TS2345` 等错误码分类。目标：错误数单调不增。
2. Strict 覆盖比例：已启用的 strict 子开关数除以项目计划启用的子开关数。通过 `tsconfig.json` 静态扫描得出。
3. 运行时 null/类型相关异常率：在错误追踪系统中按 `TypeError: Cannot read properties of null`、`undefined is not iterable`、`err.message is not a function` 等模式聚合，与代码版本关联。
4. 类型守卫复用率：统计仓库中自定义 `isXxx` 窄化函数被调用的次数，以及通过它们保护的外部输入入口比例。
5. 平均修复延迟：从 CI 报告新增 strict 错误到对应 PR 合并的时间，通过 issue 标签 `strict-error` 与 `closed` 时间戳计算。

## 失败模式、诊断证据与恢复动作

1. 运行时 null 引用崩溃
   - 证据：监控出现 `TypeError: Cannot read properties of null (reading 'length')`，且 stack trace 指向一处未保护的属性访问。
   - 恢复：在该分支启用 `strictNullChecks`，补充 `if (value !== null)` 或可选链，必要时回滚最近引入该访问路径的变更。

2. 异步返回值被当作同步值使用
   - 证据：日志打印 `[object Promise]`、数据库写入顺序异常、或单元测试断言 `expect(result).toBe(expected)` 实际比较的是 Promise 对象。
   - 恢复：显式标注函数返回 `Promise<T>`，在调用链补 `await`，并在集成测试中加入“结果不是 Promise”的断言。

3. catch 变量按 `any` 使用导致错误信息被误读
   - 证据：日志出现 `err.message is not a function` 或错误码被吞并，遥测中看到大量 `unknown error`。
   - 恢复：启用 `useUnknownInCatchVariables`，把 catch 块改为 `if (err instanceof Error)` 分支，对非 Error 对象记录原始类型与 JSON 快照。

4. 联合类型新增分支后进入未处理 default
   - 证据：当配置项或枚举扩展新值后，系统进入原本认为是“不可能”的分支，遥测标签缺失，业务结果出现默认值。
   - 恢复：在 switch 的 default 分支加入 `assertNever(value)`，让编译器在新增分支时直接失败；同步更新所有消费点。

5. 索引访问越界返回 undefined
   - 证据：计算结果出现 `NaN`，或迭代时抛出 `undefined is not iterable`，stack trace 来自数组或记录索引。
   - 恢复：启用 `noUncheckedIndexedAccess`，在访问后检查 `result !== undefined`，或使用 `Array.prototype.find`、`at` 等带边界语义的 API。

## 问答测试样例

1. 正向问题：如何验证 `strictNullChecks` 是否生效？
   回答：写一段 `const s: string | null = null; console.log(s.length);` 编译应报 `TS18047`，提示在 `s` 为 `null` 时无法访问 `length`。

2. 边界问题：非空断言 `!` 是否让 `strictNullChecks` 失去保护？
   回答：是的。`!` 只是绕过编译器检查，运行时 `null` 仍然存在，应记录使用场景并附带测试或监控。

3. 边界问题：`useUnknownInCatchVariables` 启用后，catch 块能否直接写 `err.message`？
   回答：不能。必须先用 `err instanceof Error` 或自定义类型守卫收窄，否则报 `TS18046`。

4. 无证据拒答：启用 Strict 模式后是否保证零运行时错误？
   回答：不能得出该结论。类型在编译后被擦除，外部输入、类型断言、`any` 与 `eval` 等仍可绕过检查。

5. 无证据拒答：Strict 模式会提升单次请求的性能吗？
   回答：没有直接证据。类型擦除后生成的 JavaScript 与未开启 strict 时一致，性能差异应通过负载测试验证。

6. 边界问题：迁移遗留项目时应优先开启哪些开关？
   回答：在没有基线数据的情况下无法给出绝对顺序；通常先 `noImplicitAny` 和 `strictNullChecks`，但应依据首次 `tsc --noEmit` 的错误分布与业务影响决策。

## 维护、版本、来源与相邻主题

维护上，`tsconfig.json` 应纳入版本控制并与 CI 门禁绑定。每次升级 TypeScript 主版本时，需审查新增 strict 子开关的默认行为，并通过 `pnpm typecheck` 全量回归。可配合 `typescript-eslint` 的 `strict-type-checked` 配置逐步限制 `any` 与非空断言。

版本上，本文基于 TypeScript 5.x 的 `strict` 元开关族。`strict: true` 是一个元标志，其子开关集合随版本可能扩展，因此不能认为“打开一次即可永久覆盖未来规则”。

来源上，所有判断均可通过本仓库的 `pnpm typecheck` 命令复现：根 `tsconfig.json` 与 `packages/*/tsconfig.json` 共同决定检查范围。`packages/contracts` 负责共享 DTO 类型，`packages/pi-agent` 负责会话生命周期，这些包的严格类型设置直接影响 `apps/api` 与 `apps/web` 的稳定性。

相邻主题包括：运行时校验库（如 Zod）与 Strict 的互补关系；`exactOptionalPropertyTypes` 对可选字段的进一步约束；`noUncheckedIndexedAccess` 与数组边界的交叉；以及 `typescript-eslint` 与 `noImplicitAny` 的静态规则叠加。

## 结论

事实：TypeScript Strict 模式通过 `strictNullChecks`、`useUnknownInCatchVariables`、`noUncheckedIndexedAccess` 等开关，把 `null`、`unknown`、联合类型和异步返回值的潜在问题暴露为编译期错误；类型在编译后会被擦除；`strict: true` 是一个会随版本扩展的元开关。

推论：在 CI 中强制运行 `tsc --noEmit` 并把错误数作为 SLO 追踪，可以降低由空值、未处理异常分支和异步类型误用引发的生产事件；对 `any` 和 `!` 进行审计与限制，有助于维持长期可维护性。

未知：Strict 模式对具体业务 p99 延迟的直接影响；在超过百万行遗留代码库中迁移各开关的精确成本与最佳顺序；以及 strict 类型检查与不同打包工具 tree-shaking 行为之间的量化关系。这些应通过基线数据、受控实验和持续监控进一步验证。
