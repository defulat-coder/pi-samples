// 构建期预编译 pi-permission-system：该包只发布 TS 源码（exports["."] = ./index.ts），
// 静态 import 会把整包源码拉进我们的 tsc 程序（严格设置下大量报错），plain Node 也拒绝
// 对 node_modules 里的 .ts 做 type stripping。因此用 esbuild 把它 bundle 成单个 ESM
// 产物 dist/permission-system.mjs（@earendil-works/* 保持 external，运行时复用宿主
// 已解析的同一实例）；getApiProvider 的 /compat 导入错位由根目录 pnpm patch 修复。
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const entry = require.resolve('pi-permission-system');
const outfile = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'permission-system.mjs');

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile,
  external: ['@earendil-works/*'],
  // jsonc-parser 等依赖的 main 指向 UMD 构建，ESM 产物里运行 define/require 分支会炸；
  // 优先选 module 字段拿到它们的 ESM 构建。
  mainFields: ['module', 'main'],
  logLevel: 'info',
});
