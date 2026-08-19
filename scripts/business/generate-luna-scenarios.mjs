import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(process.cwd());
const schemaPath = join(projectRoot, 'scripts/business/business-scenario.schema.json');
const outputPath = join(projectRoot, 'packages/workspace-data/src/business-scenarios.json');
const model = process.env.BUSINESS_LUNA_MODEL?.trim() || 'gpt-5.6-luna';
const concurrency = Math.max(1, Number(process.env.BUSINESS_LUNA_CONCURRENCY ?? 20));
const shardCount = 20;
const maxAttempts = 2;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'pi-business-luna-'));
const coverageFrom = '2025-08-19';
const coverageDays = 365;

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function shardWindow(index) {
  const startOffset = Math.floor(index * coverageDays / shardCount);
  const endOffset = Math.floor((index + 1) * coverageDays / shardCount) - 1;
  return { from: addDays(coverageFrom, startOffset), to: addDays(coverageFrom, endOffset) };
}

function promptFor(index) {
  const shardId = index + 1;
  const window = shardWindow(index);
  return `你是电商经营分析数据设计师。请为一个完全虚构、可公开演示的中国电商数据集生成第 ${shardId}/20 个经营场景参数。

硬性要求：
- shardId 必须是 ${shardId}；from 必须是 ${window.from}；to 必须是 ${window.to}。
- 所有名称必须使用 schema 给定的中文枚举，不得新增区域、渠道或品类。
- 权重要形成可信差异，但不要把所有值都放在边界；同一对象内至少出现 3 个不同值。
- monthWeights 按 1 月到 12 月排列，体现季节性与电商大促。
- refundAdjustmentsBps 要与品类特征相符。
- anomalies 生成 1-3 个，只能描述合成业务事件，不得引用真实公司、人物或敏感数据。
- 这 20 个分片会并行生成，你要让本分片在 ${window.from} 到 ${window.to} 的季节背景下具有辨识度。
- 只返回符合 JSON Schema 的 JSON，不要 Markdown，不要解释。`;
}

function validateScenario(value, index) {
  const expected = { shardId: index + 1, ...shardWindow(index) };
  if (!value || typeof value !== 'object') throw new Error('output is not an object');
  if (value.shardId !== expected.shardId || value.from !== expected.from || value.to !== expected.to) {
    throw new Error(`identity mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify({ shardId: value.shardId, from: value.from, to: value.to })}`);
  }
  for (const [name, weights] of [['regionWeights', value.regionWeights], ['channelWeights', value.channelWeights], ['categoryWeights', value.categoryWeights]]) {
    if (new Set(Object.values(weights ?? {})).size < 3) throw new Error(`${name} needs at least 3 distinct values`);
  }
  return value;
}

function runShard(index, attempt) {
  return new Promise((resolveShard, rejectShard) => {
    const shardId = index + 1;
    const outputFile = join(temporaryRoot, `shard-${String(shardId).padStart(2, '0')}.json`);
    const args = [
      '--disable', 'plugins',
      '-a', 'never',
      '-s', 'read-only',
      '-m', model,
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--output-schema', schemaPath,
      '-o', outputFile,
      '-C', temporaryRoot,
      promptFor(index),
    ];
    const child = spawn('codex', args, { cwd: temporaryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectShard);
    child.on('close', (code) => {
      if (code !== 0) return rejectShard(new Error(`shard ${shardId} attempt ${attempt} exited ${code}: ${(stderr || stdout).slice(-800)}`));
      try {
        const scenario = validateScenario(JSON.parse(readFileSync(outputFile, 'utf8')), index);
        process.stdout.write(`[luna] completed shard=${shardId}/20 attempt=${attempt} name=${scenario.scenarioName}\n`);
        resolveShard(scenario);
      } catch (error) {
        rejectShard(error);
      }
    });
  });
}

async function generateShard(index) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runShard(index, attempt);
    } catch (error) {
      lastError = error;
      process.stderr.write(`[luna] retry shard=${index + 1}/20 attempt=${attempt}/${maxAttempts} error=${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  throw lastError;
}

const startedAt = Date.now();
let nextIndex = 0;
const scenarios = [];

async function worker() {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= shardCount) return;
    scenarios[index] = await generateShard(index);
  }
}

try {
  process.stdout.write(`[luna] model=${model} shards=${shardCount} concurrency=${Math.min(concurrency, shardCount)}\n`);
  await Promise.all(Array.from({ length: Math.min(concurrency, shardCount) }, () => worker()));
  const snapshot = {
    schemaVersion: 'business-luna-scenarios-v1',
    generatedBy: 'codex-cli',
    model,
    concurrency: Math.min(concurrency, shardCount),
    generatedAt: new Date().toISOString(),
    coverage: { from: coverageFrom, to: addDays(coverageFrom, coverageDays - 1) },
    scenarios,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryOutput = `${outputPath}.tmp`;
  writeFileSync(temporaryOutput, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(temporaryOutput, outputPath);
  process.stdout.write(`[luna] wrote ${outputPath} scenarios=${scenarios.length} elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
