#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '../..');

const queries = [
  'Pi session 生命周期',
  '创建 session 后如何提交 turn',
  '项目资源加载和 DefaultResourceLoader',
  '.pi knowledge 是否自动加载',
  'search_knowledge 只读 custom tool',
  '工具权限和外部状态修改',
  'Agent 回答来源 evidence route',
  '没有模型凭据时的本地降级',
  'fallback 和真实 Pi 工具决策',
  '浏览器如何消费结构化回答',
  'Markdown 知识 bundle 的 Git 审阅',
  'read 工具和 search_knowledge 的能力边界',
  '事件流与 session 生命周期',
  'API Gateway 创建或复用 session',
  '模型 provider 凭据在哪里保存',
];

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.log(`Usage: node scripts/knowledge/benchmark.mjs [options]

Options:
  --iterations <n>   Measured runs per query (default: 40)
  --warmup <n>       Warmup runs per query (default: 8)
  --limit <n>        searchKnowledge result limit (default: 3)
  --knowledge-root <path>
                     Knowledge bundle to benchmark (default: .pi/knowledge)
  --out-dir <path>   Directory for JSON and Markdown reports
                     (default: artifacts/knowledge-benchmark)
  --help             Show this help

The script benchmarks the built implementation in packages/workspace-data/dist/knowledge.js.
Build it first with: pnpm --filter @pi-workbench/workspace-data build`);
  process.exit(message ? 1 : 0);
}

function positiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) usage(`--${name} must be a positive integer.`);
  return parsed;
}

function readArgs(argv) {
  const options = {
    iterations: 40,
    warmup: 8,
    limit: 3,
    knowledgeRoot: resolve(projectRoot, '.pi/knowledge'),
    outDir: resolve(projectRoot, 'artifacts/knowledge-benchmark'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') usage();
    const value = argv[index + 1];
    if (argument === '--iterations') options.iterations = positiveInteger(value, 'iterations');
    else if (argument === '--warmup') options.warmup = positiveInteger(value, 'warmup');
    else if (argument === '--limit') options.limit = positiveInteger(value, 'limit');
    else if (argument === '--knowledge-root')
      options.knowledgeRoot = resolve(process.cwd(), value ?? '');
    else if (argument === '--out-dir') options.outDir = resolve(process.cwd(), value ?? '');
    else usage(`Unknown option: ${argument}`);
    if (argument !== '--help') index += 1;
  }
  return options;
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function timingStats(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    count: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    meanMs: round(sorted.reduce((sum, value) => sum + value, 0) / Math.max(sorted.length, 1)),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function markdown(report) {
  const lines = [
    '# Local knowledge benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Configuration',
    '',
    `- Implementation: \`${report.implementation}\``,
    `- Knowledge root: \`${report.knowledgeRoot}\``,
    `- Warmup runs per query: ${report.configuration.warmup}`,
    `- Measured runs per query: ${report.configuration.iterations}`,
    `- Result limit: ${report.configuration.limit}`,
    '',
    '## Index refresh',
    '',
    `- Initial load and index refresh: ${report.index.initialLoadMs} ms`,
    '',
    '## Bundle',
    '',
    '| Files | Total body characters | Average body characters |',
    '| ---: | ---: | ---: |',
    `| ${report.bundle.fileCount} | ${report.bundle.totalBodyCharacters} | ${report.bundle.averageBodyCharacters} |`,
    '',
    '## Aggregate search latency',
    '',
    '| Samples | p50 (ms) | p95 (ms) | Mean (ms) |',
    '| ---: | ---: | ---: |',
    `| ${report.aggregateLatency.count} | ${report.aggregateLatency.p50Ms} | ${report.aggregateLatency.p95Ms} | ${report.aggregateLatency.meanMs} |`,
    '',
    '## Uncached search latency',
    '',
    '| Samples | p50 (ms) | p95 (ms) | Mean (ms) |',
    '| ---: | ---: | ---: |',
    `| ${report.uncachedLatency.count} | ${report.uncachedLatency.p50Ms} | ${report.uncachedLatency.p95Ms} | ${report.uncachedLatency.meanMs} |`,
    '',
    '## Queries',
    '',
    '| Query | Hits | First hit | p50 (ms) | p95 (ms) | Mean (ms) |',
    '| --- | ---: | --- | ---: | ---: | ---: |',
    ...report.queries.map(
      (entry) =>
        `| ${entry.query.replaceAll('|', '\\|')} | ${entry.hitCount} | ${entry.firstHit ?? '—'} | ${entry.latency.p50Ms} | ${entry.latency.p95Ms} | ${entry.latency.meanMs} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

const options = readArgs(process.argv.slice(2));
const implementation = resolve(projectRoot, 'packages/workspace-data/dist/knowledge.js');
if (!existsSync(implementation)) {
  usage(
    `Built knowledge module not found at ${implementation}. Run: pnpm --filter @pi-workbench/workspace-data build`,
  );
}
if (!existsSync(options.knowledgeRoot)) usage(`Knowledge root not found: ${options.knowledgeRoot}`);

const { closeKnowledgeIndexes, loadKnowledgeBundle, searchKnowledge } = await import(implementation);
const configuredCacheTtl = process.env.PI_KNOWLEDGE_SEARCH_CACHE_TTL_MS;
process.env.PI_KNOWLEDGE_SEARCH_CACHE_TTL_MS = '0';
closeKnowledgeIndexes();
const uncachedSamples = [];
for (const query of queries) {
  const startedAt = performance.now();
  searchKnowledge(query, { limit: options.limit, root: options.knowledgeRoot });
  uncachedSamples.push(performance.now() - startedAt);
}
if (configuredCacheTtl === undefined) delete process.env.PI_KNOWLEDGE_SEARCH_CACHE_TTL_MS;
else process.env.PI_KNOWLEDGE_SEARCH_CACHE_TTL_MS = configuredCacheTtl;
closeKnowledgeIndexes();
const initialIndexStartedAt = performance.now();
const concepts = loadKnowledgeBundle(options.knowledgeRoot);
const initialLoadMs = performance.now() - initialIndexStartedAt;
const bodyCharacters = concepts.map((concept) => concept.body.length);
const measuredSamples = [];
const queryResults = queries.map((query) => {
  for (let run = 0; run < options.warmup; run += 1)
    searchKnowledge(query, { limit: options.limit, root: options.knowledgeRoot });

  const samples = [];
  let firstResult = [];
  for (let run = 0; run < options.iterations; run += 1) {
    const startedAt = performance.now();
    const results = searchKnowledge(query, { limit: options.limit, root: options.knowledgeRoot });
    const elapsed = performance.now() - startedAt;
    samples.push(elapsed);
    measuredSamples.push(elapsed);
    if (run === 0) firstResult = results;
  }

  return {
    query,
    hitCount: firstResult.length,
    firstHit: firstResult[0]?.title ?? null,
    firstHitRef: firstResult[0]?.ref ?? null,
    latency: timingStats(samples),
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  implementation,
  knowledgeRoot: options.knowledgeRoot,
  configuration: {
    iterations: options.iterations,
    warmup: options.warmup,
    limit: options.limit,
    queryCount: queries.length,
  },
  bundle: {
    fileCount: concepts.length,
    totalBodyCharacters: bodyCharacters.reduce((sum, length) => sum + length, 0),
    averageBodyCharacters: round(
      bodyCharacters.reduce((sum, length) => sum + length, 0) / Math.max(bodyCharacters.length, 1),
      1,
    ),
  },
  aggregateLatency: timingStats(measuredSamples),
  uncachedLatency: timingStats(uncachedSamples),
  index: { initialLoadMs: round(initialLoadMs) },
  queries: queryResults,
};

mkdirSync(options.outDir, { recursive: true });
const jsonPath = resolve(options.outDir, 'knowledge-benchmark.json');
const markdownPath = resolve(options.outDir, 'knowledge-benchmark.md');
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(markdownPath, markdown(report));

console.log(
  `Knowledge bundle: ${report.bundle.fileCount} files, ${report.bundle.totalBodyCharacters} body characters (${report.bundle.averageBodyCharacters} average).`,
);
console.log(
  `Search latency: p50 ${report.aggregateLatency.p50Ms} ms, p95 ${report.aggregateLatency.p95Ms} ms, mean ${report.aggregateLatency.meanMs} ms across ${report.aggregateLatency.count} measured searches.`,
);
console.log(
  `Uncached search latency: p50 ${report.uncachedLatency.p50Ms} ms, p95 ${report.uncachedLatency.p95Ms} ms, mean ${report.uncachedLatency.meanMs} ms across ${report.uncachedLatency.count} queries.`,
);
console.log(`Initial index load: ${report.index.initialLoadMs} ms.`);
console.log(`Reports written: ${jsonPath}\n${markdownPath}`);
