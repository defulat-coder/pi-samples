import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(process.cwd());
const envPath = join(projectRoot, '.env');
const knowledgeRoot = join(projectRoot, '.pi', 'knowledge');
const progressPath = join(knowledgeRoot, '.kimi-generation-progress.jsonl');
const minChars = Number(process.env.KNOWLEDGE_MIN_CHARS ?? 2000);
const updated = '2026-08-01';

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(envPath);

process.env.KNOWLEDGE_GENERATOR_LIBRARY_ONLY = '1';
const catalog = await import(pathToFileURL(join(projectRoot, 'scripts/knowledge/generate.mjs')).href);
const { domains, variants, legacy } = catalog;

const provider = process.env.PI_MODEL_PROVIDER?.trim() || 'kimi-coding';
const modelId = process.env.PI_MODEL?.trim() || 'kimi-for-coding';
const thinkingLevel = process.env.PI_THINKING_LEVEL?.trim() || 'low';
const concurrency = Math.max(1, Number(process.env.KNOWLEDGE_KIMI_CONCURRENCY ?? 3));
const batchSize = Math.max(1, Number(process.env.KNOWLEDGE_KIMI_BATCH_SIZE ?? 5));
const maxAttempts = Math.max(1, Number(process.env.KNOWLEDGE_KIMI_ATTEMPTS ?? 3));
const requestedLimit = Number(process.env.KNOWLEDGE_KIMI_LIMIT ?? 0);
const force = process.env.KNOWLEDGE_KIMI_FORCE === '1';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? fallback : value;
}

const cliLimit = Number(argValue('--limit', requestedLimit));
const cliConcurrency = Math.max(1, Number(argValue('--concurrency', concurrency)));
const cliBatchSize = Math.max(1, Number(argValue('--batch-size', batchSize)));
const cliOnly = argValue('--only', process.env.KNOWLEDGE_KIMI_ONLY);
const cliForce = process.argv.includes('--force') || force;
const cliDryRun = process.argv.includes('--dry-run');

function nonWhitespaceLength(value) {
  return Array.from(value).filter((char) => !/\s/u.test(char)).length;
}

function scalar(value) {
  return String(value).replace(/[\r\n]/gu, ' ').trim();
}

function tagsFor(domain, topic, variant) {
  return [...new Set(['Pi', 'Agent', 'Kimi', '知识库', domain.id, topic.id, variant.id])];
}

function targetSpecs() {
  const specs = [];
  for (const domain of domains) {
    for (const topic of domain.topics) {
      for (const variant of variants) {
        const path = join('library', domain.id, `${topic.id}-${variant.id}.md`);
        specs.push({ domain, topic, variant, path, title: `${topic.title}：${variant.label}` });
      }
    }
  }
  for (const item of legacy) {
    const variant = { id: 'canonical', label: '项目基线', audience: '维护 Pi Workbench 项目知识的工程师', instruction: '优先与当前项目代码和官方 Pi 文档交叉验证。', questionStyle: '这条项目约束是否能从当前代码、事件或官方文档中复核？' };
    specs.push({ domain: item.domain, topic: item.topic, variant, path: item.path, title: item.title, legacy: true });
  }
  return specs;
}

function parseGeneratedBody(raw, title) {
  let body = String(raw ?? '').trim();
  if (!body) return '';
  body = body.replace(/^```(?:markdown|md)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end >= 0) body = body.slice(end + 4).trim();
  }
  if (!/^#/u.test(body)) body = `# ${title}\n\n${body}`;
  return body;
}

function hasKimiDocument(path, title) {
  if (!existsSync(path) || cliForce) return false;
  const raw = readFileSync(path, 'utf8');
  return raw.includes('generated_by: kimi') && raw.includes(`title: ${title}`) && nonWhitespaceLength(raw) >= minChars;
}

function frontmatter(spec) {
  const resource = `.pi/knowledge/${spec.path.replaceAll('\\', '/')}`;
  return `---
type: concept
title: ${scalar(spec.title)}
description: ${scalar(spec.domain.summary)}${scalar(spec.topic.focus)}
resource: ${resource}
tags: [${tagsFor(spec.domain, spec.topic, spec.variant).join(', ')}]
status: active
verified: true
updated: ${updated}
generated_by: kimi
generator_provider: ${scalar(provider)}
generator_model: ${scalar(modelId)}
domain: ${scalar(spec.domain.id)}
topic: ${scalar(spec.topic.id)}
variant: ${scalar(spec.variant.id)}
---`;
}

function promptFor(spec) {
  return `你是一个严谨的中文技术知识库作者。请只输出 Markdown 正文，不要输出 YAML frontmatter、代码围栏、解释你如何生成，也不要写“作为 AI”。

请为下面这个 OKF-compatible concept 写一篇真正有内容的长文，正文至少 ${minChars} 个非空白字符，控制在 2200-2800 个中文字符左右，达到信息完整后就停止。文章必须围绕给定主题展开，不能用泛泛的“定义—优点—总结”凑字数，也不能复制其他主题的内容。

主题域：${spec.domain.title}
主题：${spec.topic.title}
主题重点：${spec.topic.focus}
写作视角：${spec.variant.label}
目标读者：${spec.variant.audience}
本视角要求：${spec.variant.instruction}

必须包含以下结构，并让每一节都有具体判断、边界、例外或可验证细节：
1. 一个准确的 H1 标题；
2. 摘要与问题边界；
3. 核心概念或数据模型，至少 6 个编号条目；
4. 设计决策与取舍，至少 5 个小节；
5. 可执行的实施流程，至少 8 步；
6. 一个贴近 TypeScript/Web/本地文件知识库的 YAML、JSON 或代码示例，并解释输入、处理、输出；
7. 性能、质量和可观测性指标，至少 5 项，说明如何测量；
8. 至少 5 个失败模式，给出诊断证据和恢复动作；
9. 至少 6 个问答测试样例，包含正向问题、边界问题和无证据时的拒答条件；
10. 维护、版本、来源和与相邻主题的关系；
11. 最后的结论必须区分事实、推论和未知。

文章要适合被检索器按标题、标签、术语和正文召回，也要适合 Agent 引用。不要声称你访问了不存在的外部系统；没有具体事实时，用项目级的可验证设计描述。现在直接输出完整 Markdown 正文。`;
}

function writeKimiDocument(spec, body) {
  const absolutePath = join(knowledgeRoot, spec.path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.kimi.tmp`;
  writeFileSync(temporaryPath, `${frontmatter(spec)}\n\n${body.trim()}\n`, 'utf8');
  renameSync(temporaryPath, absolutePath);
}

async function createRuntime() {
  const entry = pathToFileURL(join(projectRoot, 'packages/pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
  const { ModelRuntime, createAgentSession, SessionManager } = await import(entry);
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  let model = runtime.getModel(provider, modelId);
  if (!model) {
    const refreshed = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 15_000 });
    model = refreshed.getModel(provider, modelId);
    if (!model) throw new Error(`Kimi model not found: ${provider}/${modelId}`);
    return { runtime: refreshed, createAgentSession, SessionManager, model };
  }
  return { runtime, createAgentSession, SessionManager, model };
}

async function generateBody(spec, sdk) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let text = '';
    const eventTypes = [];
    let session;
    let unsubscribe;
    try {
      ({ session } = await sdk.createAgentSession({
        cwd: projectRoot,
        model: sdk.model,
        modelRuntime: sdk.runtime,
        sessionManager: sdk.SessionManager.inMemory(projectRoot),
        tools: [],
        thinkingLevel,
      }));
      unsubscribe = session.subscribe((event) => {
        eventTypes.push(event.type);
        if (event.type === 'message_update') {
          eventTypes.push(event.assistantMessageEvent.type);
          if (event.assistantMessageEvent.type === 'text_delta') text += event.assistantMessageEvent.delta;
        }
      });
      await session.prompt(promptFor(spec));
      const body = parseGeneratedBody(text, spec.title);
      if (nonWhitespaceLength(body) < minChars) throw new Error(`Kimi returned ${nonWhitespaceLength(body)} chars, expected at least ${minChars}; preview=${JSON.stringify(body.slice(0, 160))}; events=${eventTypes.slice(-20).join(',')}`);
      return body;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[kimi] retry ${attempt}/${maxAttempts} ${spec.path}: ${message}\n`);
      if (attempt < maxAttempts) await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(30_000, attempt * 2_000)));
    } finally {
      unsubscribe?.();
      session?.dispose();
    }
  }
  throw lastError ?? new Error('Kimi generation failed');
}

const allSpecs = targetSpecs();
const onlyPaths = cliOnly ? cliOnly.split(',').map((value) => value.trim()).filter(Boolean) : [];
const selectedSpecs = onlyPaths.length ? allSpecs.filter((spec) => onlyPaths.includes(spec.path)) : allSpecs;
const specs = cliLimit > 0 ? selectedSpecs.slice(0, cliLimit) : selectedSpecs;
const pending = specs.filter((spec) => !hasKimiDocument(join(knowledgeRoot, spec.path), spec.title));
const skipped = specs.length - pending.length;

console.log(`[kimi] target=${provider}/${modelId} thinking=${thinkingLevel} total=${specs.length} pending=${pending.length} skipped=${skipped} concurrency=${cliConcurrency}`);
if (!process.env.KIMI_API_KEY) throw new Error('KIMI_API_KEY is not configured in the project environment');
if (cliDryRun) process.exit(0);

mkdirSync(knowledgeRoot, { recursive: true });
if (!existsSync(progressPath) || cliForce) writeFileSync(progressPath, '', 'utf8');
const startedAt = Date.now();
let nextIndex = 0;
let completed = 0;
let failed = 0;
const failures = [];

const sdk = await createRuntime();
console.log(`[kimi] model ready provider=${provider} model=${modelId}; key is configured and will not be printed`);

async function worker(workerId) {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= pending.length) return;
    const spec = pending[index];
    try {
      const body = await generateBody(spec, sdk);
      writeKimiDocument(spec, body);
      completed += 1;
      const record = { status: 'completed', path: spec.path, chars: nonWhitespaceLength(body), completed, total: pending.length, at: new Date().toISOString() };
      appendFileSync(progressPath, `${JSON.stringify(record)}\n`, 'utf8');
      if (completed % cliBatchSize === 0 || completed === pending.length) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[kimi] batch complete workers=${workerId} completed=${completed}/${pending.length} failed=${failed} last=${spec.path} chars=${record.chars} elapsed=${elapsed}s`);
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ path: spec.path, message });
      appendFileSync(progressPath, `${JSON.stringify({ status: 'failed', path: spec.path, message, at: new Date().toISOString() })}\n`, 'utf8');
      console.error(`[kimi] failed ${completed + failed}/${pending.length} ${spec.path}: ${message}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(cliConcurrency, pending.length || 1) }, (_, index) => worker(index + 1)));
sdk.runtime.dispose?.();

const summary = { provider, model: modelId, total: specs.length, pending: pending.length, skipped, completed, failed, minChars, elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)), failures };
console.log(JSON.stringify(summary, null, 2));
if (failed > 0) process.exitCode = 1;
