---
type: concept
title: Strict 模式：实现视角
description: 用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。让 null、unknown、联合类型和异步返回值在编译期暴露问题
resource: .pi/knowledge/library/typescript-engineering/strict-implementation.md
tags: [Pi, Agent, Kimi, 知识库, typescript-engineering, strict, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: typescript-engineering
topic: strict
variant: implementation
---

# 在 TypeScript 工程中启用 Strict 模式：编译期捕获 null、unknown、联合类型与异步返回值缺陷

Strict 模式不是开关就能获得的“运行时安全险”，它是一组编译器标志，把类型检查从宽松约束改为精确约束。在实现视角下，它真正的价值在于把“null 是否被处理”“unknown 是否被收窄”“联合类型是否被穷举”“异步函数是否返回约定类型”这些原本可能被忽略的问题，提前到 `tsc --noEmit` 阶段暴露。它的边界同样明确：只检查类型系统能看到的代码，不能阻止外部 API 返回运行时 null，也不能替代 JSON 解析后的运行时校验。

## 摘要与问题边界

Strict 模式的核心配置是 `tsconfig.json` 中 `compilerOptions.strict: true`。它同时启用 `noImplicitAny`、`strictNullChecks`、`strictFunctionTypes`、`strictBindCallApply`、`strictPropertyInitialization`、`noImplicitThis`、`useUnknownInCatchVariables` 和 `alwaysStrict`。当目标是让 null、unknown、联合类型和异步返回值在编译期暴露问题时，应重点控制以下边界：

- 所有来自文件、网络和 DOM 的输入，如果类型声明为具体类型而运行时可能是 null，则 Strict 模式无法拦截，必须叠加运行时校验。
- 异步代码的 `Promise<T>` 只能约束“resolved 值”，不能约束“是否被 reject”，reject 路径仍由错误处理策略覆盖。
- 类型检查通过不等于业务逻辑正确，也不等于性能合格。

## 核心概念与数据模型

1. `strictNullChecks`：基本类型不再自动包含 `null` 或 `undefined`。`string` 与 `string | null` 是两种类型，访问 `toString()` 前必须收窄。
2. `unknown` 替代 `any`：`any` 允许任意操作，`unknown` 禁止直接解引用，必须先通过 `typeof`、类型守卫或模式库收窄。
3. 联合类型收窄：对于 `type Result = { ok: true; value: T } | { ok: false; error: E }`，分支中 `ok` 作为判别字段，编译器会收窄到对应成员；`default` 分支应使用 `exhaustiveCheck: never` 验证穷举。
4. `strictFunctionTypes`：函数类型按逆变检查参数，回调函数不能传入更宽松的参数类型；方法声明默认保持双变，需改写为函数属性才能完全受控。
5. 异步返回契约：`async function` 返回类型被推断为 `Promise<T>`，而不是 `Promise<T | undefined>`；`await` 返回的是 `T`，但抛错路径仍需显式 `try/catch`。
6. `strictPropertyInitialization`：类属性必须在声明时、构造函数中或通过 `!` 明确赋值，否则编译器报错。
7. `noImplicitThis` 与 `useUnknownInCatchVariables`：`this` 在回调中默认 `any` 会被禁止；`catch` 块变量从 `any` 改为 `unknown`，必须先行校验。

## 设计决策与取舍

### 迁移顺序：全量开启还是逐条启用
已有项目直接启用 `strict: true` 可能产生数千条错误。可先在 `tsconfig.json` 中列出单条标志，按 `noImplicitAny` → `strictNullChecks` → `strictFunctionTypes` → `strictPropertyInitialization` → `useUnknownInCatchVariables` 的顺序分批修复。新项目和独立包建议直接全量开启。

### 是否允许逃生口
`as any`、非空断言 `!` 和 `// @ts-ignore` 会抵消 Strict 模式。建议只在对接外部不可控类型声明时临时使用，并在代码库中设置数量上限和强制注释说明。

### 运行时校验与 unknown 的边界
把 `JSON.parse` 结果从 `any` 改为 `unknown` 后，必须配套 Zod、io-ts 或手写守卫函数。如果团队未投入运行时校验，类型再严格也会在边界处崩溃。

### 异步错误的表达形式
统一选择“throw 语义”或“Result 对象”之一。如果函数签名返回 `Promise<T>`，调用方必须处理 reject；如果返回 `Promise<Result<T, E>>`，则调用方通过 `ok` 字段分支处理，reject 仅用于不可恢复错误。

### 编译深度与构建速度
`strictFunctionTypes` 和 `strictNullChecks` 会增加类型推导和检查的计算量。大型 monorepo 应启用 `incremental`、`composite` 和项目引用，把检查时间纳入 CI 监控。

## 可执行的实施流程

1. 在版本控制中建立基线，记录当前 `tsc --noEmit` 的错误数量和执行时间。
2. 将 TypeScript 升级到与项目依赖兼容的最新 LTS 版本，确认所有标志可用。
3. 在 `tsconfig.json` 中设置 `strict: true`，如无法一次性修复，则拆分为单独标志并保留启用计划。
4. 修复 `noImplicitAny` 错误：为所有隐含 `any` 的参数、返回值和变量添加显式类型或合理推断。
5. 修复 `strictNullChecks` 错误：在访问可能为 null 的值前加入 `if (x !== null)`、可选链 `?.` 或空值合并 `??`。
6. 修复 `strictFunctionTypes` 错误：将类中的方法回调改为函数属性，或调整接口参数逆变关系。
7. 修复 `strictPropertyInitialization` 错误：为类字段赋初值、标记 `!` 或在构造函数中初始化。
8. 修复 `useUnknownInCatchVariables` 和 `JSON.parse` 相关代码：将 `any` 改为 `unknown`，并使用类型守卫或模式校验。
9. 为关键联合类型添加穷举检查，强制 `default` 分支返回 `never`。
10. 在 CI 中设置 `tsc --noEmit` 零错误门禁，并添加 ESLint `no-floating-promises` 规则。

## 本地文件知识库读取示例

    import { readFile } from 'node:fs/promises';
    import { z } from 'zod';

    const ArticleSchema = z.object({
      title: z.string(),
      tags: z.array(z.string()),
      body: z.string(),
      publishedAt: z.coerce.date().optional(),
    });

    type Article = z.infer<typeof ArticleSchema>;

    export async function loadArticle(path: string): Promise<Article> {
      const raw = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return ArticleSchema.parse(parsed);
    }

输入是一段磁盘文件路径 `path` 和文件中的 JSON 字符串。处理流程为：`readFile` 返回 `string`；`JSON.parse` 被显式标注为 `unknown`，避免直接按 `any` 解引用；`ArticleSchema.parse` 执行运行时校验并把 unknown 收窄为 `Article`。输出是 `Promise<Article>`，如果文件不存在或 JSON 不符合结构会抛错。`strictNullChecks` 要求 `path` 不能为 null，`useUnknownInCatchVariables` 要求调用方在 catch 中对错误对象做类型收窄。

## 性能、质量与可观测性指标

1. 编译错误数：运行 `tsc --noEmit` 并统计错误条数，目标在每次合并前归零，并按模块跟踪趋势。
2. 类型覆盖率：通过 ESLint 或 AST 扫描统计 `any`、非空断言 `!`、`as` 断言和 `// @ts-ignore` 的数量，设定月度下降目标。
3. 运行时 null 崩溃率：从错误监控平台收集 `TypeError: Cannot read properties of null` 和 `undefined is not iterable` 类异常，除以版本发布次数。
4. 类型检查耗时：使用 `time npx tsc --noEmit` 记录冷启动和增量编译时间，超过基线 20% 时告警。
5. 未处理 Promise 拒绝数：在 Node 进程监听 `unhandledRejection` 事件，或在测试中开启 `--unhandled-rejections=strict`。
6. 联合类型穷举违规数：通过自定义 ESLint 规则扫描 `switch` 和 `if/else` 链的 `default` 分支是否返回 `never`。

## 失败模式与恢复动作

1. 开启 `strict: true` 后 CI 出现大量错误。诊断证据为 `tsc --noEmit` 输出数百条错误且阻断合并。恢复动作：按单条标志分批修复，保留过渡分支，禁止在主线合并前累积新错误。
2. 类型检查通过，但生产环境仍因 API 返回 null 崩溃。诊断证据为错误日志中出现 `Cannot read properties of null`。恢复动作：在 API 边界添加 Zod 校验，并更新类型声明以匹配真实数据。
3. 异步函数返回 `Promise<T>` 但内部某些分支未返回，实际 resolved 为 `undefined`。诊断证据为 `tsc` 报告 `Function lacks ending return statement`。恢复动作：补齐所有分支的返回值，或在确实无值时使用 `Promise<void>`。
4. 逃生口数量失控。诊断证据为 `grep -R "@ts-ignore\|as any" src/` 超过阈值。恢复动作：设置 lint 规则禁止新增，并安排专项清理，所有旧逃生口必须附带注释和工单号。
5. 回调函数违反 `strictFunctionTypes`。诊断证据为错误码 `TS2345`，提示函数参数不兼容。恢复动作：将类方法改为函数属性，或显式声明回调参数类型。
6. catch 块把异常对象当作 `any` 直接访问 `.message`。诊断证据为 `tsc` 提示 `Object is of type 'unknown'`。恢复动作：使用 `instanceof Error` 或错误模式校验，再访问字段。

## 问答测试样例

1. 正向问题：开启 `strictNullChecks` 后，`string | null` 变量如何安全调用字符串方法？回答：先使用 `if (x !== null)` 或 `x?.length` 进行类型收窄，收窄后类型为 `string`。
2. 正向问题：`JSON.parse` 在 Strict 模式下应使用什么类型？回答：应使用 `unknown`，然后配合类型守卫或 Zod 等校验库。
3. 边界问题：一个 `async function` 没有显式返回，它的类型是什么？回答：推断为 `Promise<void>`；如果调用方期望 `Promise<T>` 会触发编译错误。
4. 边界问题：`strictFunctionTypes` 是否影响类方法的参数检查？回答：类方法参数默认保持双变，只有函数属性或接口函数签名才按逆变检查；需要改写才能获得完整约束。
5. 无证据时的拒答：Strict 模式能让我们的线上崩溃率降低多少？回答：无法回答；需要项目提供历史崩溃数据并对比启用 Strict 模式前后的版本。
6. 无证据时的拒答：外部 API 类型声明为 `string`，实际返回 `null`，Strict 模式能否在编译期拦截？回答：不能；类型声明与真实数据不一致时，需运行时校验或更新声明。
7. 边界问题：如何验证联合类型是否被穷举？回答：在 `default` 分支写入 `const _exhaustive: never = value; return _exhaustive;`，如果未来新增分支未处理，编译器会报错。

## 维护、版本、来源与相邻主题的关系

Strict 模式的具体标志会随 TypeScript 版本演进。`useUnknownInCatchVariables` 在 4.4 引入，后续版本可能增加新的严格相关标志。实施前应查阅当前项目锁定版本的 `tsc --help` 和官方 tsconfig 参考。相邻主题包括：ESLint 规则族 `@typescript-eslint/no-explicit-any`、`no-floating-promises` 和 `strict-boolean-expressions`；运行时类型校验工具 Zod、io-ts、valibot；单元测试与端到端测试；monorepo 的 project references 和增量编译；以及 `exactOptionalPropertyTypes` 等更细粒度的严格扩展。Strict 模式与这些主题的关系是：前者负责编译期约束，后者负责代码风格和运行时校验，三者共同构成类型安全工程。

## 结论

事实：Strict 模式通过 `strict: true` 及相关标志改变 TypeScript 类型规则，使 `null` 与 `undefined` 不再是任意类型的子集，`unknown` 取代 `any` 成为默认动态类型，`catch` 变量默认类型为 `unknown`，函数参数与异步返回类型也必须满足更精确契约。
推论：当开发者在编写输入处理、联合类型分支、异步调用和类属性初始化时遵循这些约束，编译器能够提前拦截大量原本只能在运行时发现的空值与类型错误；结合运行时校验，可进一步降低边界数据导致的崩溃。
未知：Strict 模式在特定代码库中的 bug 减少百分比、对团队交付速度的影响、以及是否需要启用 `exactOptionalPropertyTypes` 或 `isolatedDeclarations` 等更严格标志，都需要项目根据自身数据度量后才能确定。
