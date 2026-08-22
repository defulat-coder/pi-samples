// 构建期预编译只发布 TS 源码的 Pi 扩展（exports["."] = ./index.ts）：
// 静态 import 会把整包源码拉进我们的 tsc 程序（严格设置下大量报错），plain Node 也拒绝
// 对 node_modules 里的 .ts 做 type stripping。因此用 esbuild 把它 bundle 成单个 ESM
// 产物 dist/<name>.mjs（@earendil-works/* 保持 external，运行时复用宿主已解析的同一实例）。
// pi-permission-system 的 getApiProvider /compat 导入错位由根目录 pnpm patch 修复。
// 注意 pi-subagents 不走这里：它按 import.meta.url 相对源码布局定位运行时资产
// （子进程扩展、agents/、prompts/），bundle 会错位，改由 src/subagents.ts 用 jiti
// 从真实安装路径加载。
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const extensions = [
  { package: 'pi-permission-system', out: 'permission-system.mjs' },
];

for (const { package: pkg, out } of extensions) {
  await build({
    entryPoints: [require.resolve(pkg)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: join(distDir, out),
    external: ['@earendil-works/*', 'yaml', 'acorn', 'jiti', 'typebox'],
    // jsonc-parser 等依赖的 main 指向 UMD 构建，ESM 产物里运行 define/require 分支会炸；
    // 优先选 module 字段拿到它们的 ESM 构建。
    mainFields: ['module', 'main'],
    logLevel: 'info',
  });
}
