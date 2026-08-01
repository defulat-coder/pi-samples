import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(process.cwd());
const knowledgeRoot = join(projectRoot, '.pi', 'knowledge');
const progressPath = join(knowledgeRoot, '.luna-generation-progress.jsonl');
const minimumCharacters = Number(process.env.KNOWLEDGE_MIN_CHARS ?? 2000);
const defaultBatchSize = Math.max(1, Number(process.env.KNOWLEDGE_LUNA_BATCH_SIZE ?? 20));
const defaultConcurrency = Math.max(1, Number(process.env.KNOWLEDGE_LUNA_CONCURRENCY ?? 20));

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function numberArgument(name, fallback) {
  const value = Number(argumentValue(name, fallback));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonWhitespaceLength(value) {
  return Array.from(value).filter((character) => !/\s/u.test(character)).length;
}

function hasUsableDocument(absolutePath) {
  if (!existsSync(absolutePath)) return false;
  const source = readFileSync(absolutePath, 'utf8');
  const body = source.replace(/^---[\s\S]*?---/u, '').trim();
  return source.startsWith('---') && nonWhitespaceLength(body) >= minimumCharacters;
}

process.env.KNOWLEDGE_GENERATOR_LIBRARY_ONLY = '1';
const catalog = await import(pathToFileURL(join(projectRoot, 'scripts/knowledge/generate.mjs')).href);
const { domains, variants, legacy } = catalog;

function targetSpecs() {
  const specs = [];
  for (const domain of domains) {
    for (const topic of domain.topics) {
      for (const variant of variants) {
        specs.push({ path: join('library', domain.id, `${topic.id}-${variant.id}.md`), title: `${topic.title}：${variant.label}`, domain: domain.id });
      }
    }
  }
  for (const item of legacy) specs.push({ path: item.path, title: item.title, domain: item.domain.id });
  return specs;
}

function normalizeDuplicateTitles(specs) {
  const titleOwners = new Map();
  const duplicateGroups = new Map();
  for (const spec of specs) {
    const absolutePath = join(knowledgeRoot, spec.path);
    if (!existsSync(absolutePath)) continue;
    const source = readFileSync(absolutePath, 'utf8');
    const match = source.match(/^title:\s*(.+)$/mu);
    if (!match) continue;
    const title = match[1].trim();
    if (titleOwners.has(title)) {
      const group = duplicateGroups.get(title) ?? [titleOwners.get(title)];
      group.push({ ...spec, title, absolutePath });
      duplicateGroups.set(title, group);
    } else {
      titleOwners.set(title, { ...spec, title, absolutePath });
    }
  }

  const normalized = [];
  const usedTitles = new Set(titleOwners.keys());
  for (const [title, group] of duplicateGroups) {
    for (let index = 1; index < group.length; index += 1) {
      const item = group[index];
      let nextTitle = `${title}（${item.domain}）`;
      if (usedTitles.has(nextTitle)) nextTitle = `${title}（${item.domain}-${index}）`;
      usedTitles.add(nextTitle);
      const source = readFileSync(item.absolutePath, 'utf8');
      const replacedFrontmatter = source.replace(/^title:\s*.+$/mu, `title: ${nextTitle}`);
      const escapedTitle = title.replace(/[.*+?^${}()|[\[\]\\]/gu, '\\$&');
      const replacedHeading = replacedFrontmatter.replace(new RegExp(`^# ${escapedTitle}$`, 'mu'), `# ${nextTitle}`);
      writeFileSync(item.absolutePath, replacedHeading, 'utf8');
      normalized.push({ path: item.path, from: title, to: nextTitle });
    }
  }
  return normalized;
}

function writeIndexes() {
  const domainLinks = [];
  for (const domain of domains) {
    const domainRoot = join(knowledgeRoot, 'library', domain.id);
    const links = domain.topics.flatMap((topic) => variants.map((variant) => {
      const path = `${topic.id}-${variant.id}.md`;
      return `- [${topic.title}：${variant.label}](./${path})`;
    }));
    const content = `---\ntype: index\ntitle: ${domain.title}\ndescription: ${domain.summary}\nresource: .pi/knowledge/library/${domain.id}/index.md\nstatus: active\nverified: true\nupdated: 2026-08-01\n---\n\n# ${domain.title}\n\n${domain.summary}\n\n本主题域包含 ${links.length} 篇长文，分别从架构、实现、验证与运维视角展开。\n\n${links.join('\n')}\n`;
    mkdirSync(domainRoot, { recursive: true });
    writeFileSync(join(domainRoot, 'index.md'), content, 'utf8');
    domainLinks.push(`- [${domain.title}](./library/${domain.id}/index.md)：${domain.summary}`);
  }
  const rootContent = `---\ntype: index\ntitle: Pi Workbench Knowledge\ndescription: Pi Agent 验证工作台的文件优先知识 bundle。\nresource: .pi/knowledge/index.md\nstatus: active\nverified: true\nupdated: 2026-08-01\n---\n\n# Pi Workbench Knowledge\n\n本 bundle 由 OKF-compatible Markdown 组成。每个 concept 文件都包含可审阅的 frontmatter 和长篇正文，供本地检索器、Pi Agent 和评测脚本使用。\n\n- 长文测试文档：${domains.length * 10 * variants.length} 篇\n- 项目基线文档：${legacy.length} 篇\n- 总 concept 文档：${domains.length * 10 * variants.length + legacy.length} 篇\n- 文章最低正文长度：${minimumCharacters} 个非空白字符\n- 生成方式：Luna low 配置下的本地子进程模板生成（保留已有 Kimi 文档）\n- 校验脚本：\`scripts/knowledge/validate.mjs\`\n- 基准脚本：\`scripts/knowledge/benchmark.mjs\`\n\n## 主题域\n\n${domainLinks.join('\n')}\n\n## 项目基线\n\n${legacy.map((item) => `- [${item.title}](./${item.path})`).join('\n')}\n`;
  writeFileSync(join(knowledgeRoot, 'index.md'), rootContent, 'utf8');
}

const batchSize = numberArgument('--batch-size', defaultBatchSize);
const concurrency = numberArgument('--concurrency', defaultConcurrency);
const limit = numberArgument('--limit', 0);
const allSpecs = targetSpecs();
const pending = allSpecs.filter((spec) => !hasUsableDocument(join(knowledgeRoot, spec.path)));
const selected = limit > 0 ? pending.slice(0, limit) : pending;
const batches = [];
for (let index = 0; index < selected.length; index += batchSize) batches.push(selected.slice(index, index + batchSize));

mkdirSync(knowledgeRoot, { recursive: true });
writeFileSync(progressPath, '', 'utf8');
console.log(`[subprocess] engine=luna model=luna reasoning=low mode=local-template minChars=${minimumCharacters}`);
console.log(`[subprocess] total=${allSpecs.length} existing=${allSpecs.length - pending.length} pending=${selected.length} batches=${batches.length} batchSize=${batchSize} concurrency=${Math.min(concurrency, batches.length || 1)}`);

let nextBatch = 0;
let completedBatches = 0;
let completedDocuments = 0;
let failedDocuments = 0;
const startedAt = Date.now();

function runBatch(batch, batchNumber) {
  return new Promise((resolveBatch) => {
    const child = spawn(process.execPath, [join(projectRoot, 'scripts/knowledge/generate-luna-worker.mjs'), '--only', batch.map((spec) => spec.path).join(',')], {
      cwd: projectRoot,
      env: { ...process.env, KNOWLEDGE_MIN_CHARS: String(minimumCharacters) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`[subprocess] batch ${batchNumber}/${batches.length} started childPid=${child.pid} docs=${batch.length} first=${batch[0]?.path ?? 'none'}`);
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    let result;
    stdout.on('line', (line) => {
      console.log(`[subprocess][batch ${batchNumber}] ${line}`);
      if (line.startsWith('[luna-worker] result ')) {
        try {
          result = JSON.parse(line.slice('[luna-worker] result '.length));
        } catch {
          result = undefined;
        }
      }
    });
    stderr.on('line', (line) => console.error(`[subprocess][batch ${batchNumber}][stderr] ${line}`));
    child.on('close', (code) => {
      stdout.close();
      stderr.close();
      const written = result?.written ?? [];
      const failed = result?.failed ?? [];
      for (const item of written) appendFileSync(progressPath, `${JSON.stringify({ status: 'completed', ...item, batch: batchNumber, at: new Date().toISOString() })}\n`, 'utf8');
      for (const item of failed) appendFileSync(progressPath, `${JSON.stringify({ status: 'failed', ...item, batch: batchNumber, at: new Date().toISOString() })}\n`, 'utf8');
      completedBatches += 1;
      completedDocuments += written.length;
      failedDocuments += failed.length || (code && !result ? batch.length : 0);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[subprocess] batch ${batchNumber}/${batches.length} complete code=${code ?? 'signal'} docs=${written.length}/${batch.length} failed=${failed.length} overall=${completedDocuments}/${selected.length} elapsed=${elapsed}s`);
      resolveBatch({ code, written, failed });
    });
  });
}

async function worker() {
  while (true) {
    const index = nextBatch;
    nextBatch += 1;
    if (index >= batches.length) return;
    await runBatch(batches[index], index + 1);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, batches.length || 1) }, () => worker()));
const normalizedTitles = normalizeDuplicateTitles(allSpecs);
for (const item of normalizedTitles) appendFileSync(progressPath, `${JSON.stringify({ status: 'title-normalized', ...item, at: new Date().toISOString() })}\n`, 'utf8');
if (normalizedTitles.length > 0) console.log(`[subprocess] normalized duplicate titles count=${normalizedTitles.length}`);
writeIndexes();
console.log(`[subprocess] indexes refreshed domains=${domains.length} root=.pi/knowledge/index.md`);
const elapsedSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
console.log(JSON.stringify({ engine: 'luna', model: 'luna', reasoning: 'low', mode: 'local-subprocess', total: allSpecs.length, existing: allSpecs.length - pending.length, selected: selected.length, batches: batches.length, completedBatches, completedDocuments, failedDocuments, normalizedTitles: normalizedTitles.length, elapsedSeconds, progressPath: '.pi/knowledge/.luna-generation-progress.jsonl' }, null, 2));
if (failedDocuments > 0) process.exitCode = 1;
