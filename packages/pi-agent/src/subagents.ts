import { createRequire } from 'node:module';
import { createJiti } from 'jiti';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';

/**
 * SubAgent 委派扩展（pi-subagents）的加载层。
 *
 * 与 pi-permission-system 不同，这个包不能 esbuild 成单文件：它在多处按
 * import.meta.url 相对源码布局定位运行时资产（子进程要加载的
 * subagent-prompt-runtime.ts / fanout-child.ts 扩展、内建 agents/、prompts/），
 * bundle 后这些路径全部错位。因此用 jiti 从真实安装路径直接加载 TS 源码——
 * 与 pi CLI 加载扩展的方式一致，所有相对路径天然成立。
 *
 * 静态 import 仍不可行（会把整包 TS 源码拉进我们的 tsc 程序），jiti.import 的
 * 说明符是非字面量，tsc 不解析。返回类型按 InlineExtension 断言。
 *
 * 子进程的 bash ask 经由 pi-permission-system 的进程全局 env（PI_IS_SUBAGENT 等，
 * 见 permissions.ts）随 spawnEnv 继承，自动落入现有审批文件桥，无需额外机制。
 */

let cachedExtension: Promise<InlineExtension> | undefined;

/** 加载 subagent 委派扩展工厂；进程内只加载一次，后续调用共享同一实例。 */
export function loadSubagentsExtension(): Promise<InlineExtension> {
  cachedExtension ??= (async () => {
    const require = createRequire(import.meta.url);
    // exports["."] = ./index.ts：resolve 入口即得包内绝对路径（package.json 不在 exports 里）。
    const entryPath = require.resolve('pi-subagents');
    const jiti = createJiti(import.meta.url, { interopDefault: false });
    const loaded = (await jiti.import(entryPath)) as { default?: unknown };
    if (typeof loaded.default !== 'function') {
      throw new Error('pi-subagents 缺少默认导出（扩展工厂）');
    }
    return loaded.default as InlineExtension;
  })();
  return cachedExtension;
}
