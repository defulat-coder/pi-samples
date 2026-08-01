import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(process.cwd());
const knowledgeRoot = join(projectRoot, '.pi', 'knowledge');
const minimumCharacters = Number(process.env.KNOWLEDGE_MIN_CHARS ?? 2000);

process.env.KNOWLEDGE_GENERATOR_LIBRARY_ONLY = '1';
const catalog = await import(pathToFileURL(join(projectRoot, 'scripts/knowledge/generate.mjs')).href);
const { domains, variants, legacy, renderArticle } = catalog;

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function nonWhitespaceLength(value) {
  return Array.from(value).filter((character) => !/\s/u.test(character)).length;
}

function targetSpecs() {
  const specs = [];
  for (const domain of domains) {
    for (const topic of domain.topics) {
      for (const variant of variants) {
        specs.push({
          domain,
          topic,
          variant,
          path: join('library', domain.id, `${topic.id}-${variant.id}.md`),
          title: `${topic.title}：${variant.label}`,
        });
      }
    }
  }

  for (const item of legacy) {
    const variant = {
      id: 'canonical',
      label: '项目基线',
      audience: '维护 Pi Workbench 项目知识的工程师',
      instruction: '优先与当前项目代码和官方 Pi 文档交叉验证。',
      questionStyle: '这条项目约束是否能从当前代码、事件或官方文档中复核？',
    };
    specs.push({ domain: item.domain, topic: item.topic, variant, path: item.path, title: item.title, legacy: true });
  }
  return specs;
}

function hasUsableDocument(absolutePath) {
  if (!existsSync(absolutePath)) return false;
  const source = readFileSync(absolutePath, 'utf8');
  const body = source.replace(/^---[\s\S]*?---/u, '').trim();
  return source.startsWith('---') && nonWhitespaceLength(body) >= minimumCharacters;
}

function annotate(content) {
  return content.replace(
    'updated: 2026-08-01',
    'updated: 2026-08-01\ngenerated_by: luna\ngenerator_model: luna\ngenerator_reasoning: low\ngenerator_mode: local-subprocess',
  );
}

function writeLunaDocument(spec, serial) {
  const absolutePath = join(knowledgeRoot, spec.path);
  const content = annotate(renderArticle({ domain: spec.domain, topic: spec.topic, variant: spec.variant, resource: spec.path, serial, legacyPath: spec.legacy }));
  const body = content.replace(/^---[\s\S]*?---/u, '').trim();
  const characters = nonWhitespaceLength(body);
  if (characters < minimumCharacters) throw new Error(`${spec.path} rendered ${characters} characters`);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.luna.tmp`;
  writeFileSync(temporaryPath, `${content.trim()}\n`, 'utf8');
  renameSync(temporaryPath, absolutePath);
  return characters;
}

const requestedPaths = argumentValue('--only')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const requested = new Set(requestedPaths);
const specs = targetSpecs().filter((spec) => requested.size === 0 || requested.has(spec.path));
const result = { written: [], skipped: [], failed: [] };

for (let index = 0; index < specs.length; index += 1) {
  const spec = specs[index];
  const absolutePath = join(knowledgeRoot, spec.path);
  if (hasUsableDocument(absolutePath)) {
    result.skipped.push(spec.path);
    process.stdout.write(`[luna-worker] skipped ${index + 1}/${specs.length} ${spec.path}\n`);
    continue;
  }
  try {
    const characters = writeLunaDocument(spec, index + 1);
    result.written.push({ path: spec.path, characters });
    process.stdout.write(`[luna-worker] written ${index + 1}/${specs.length} ${spec.path} chars=${characters}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.failed.push({ path: spec.path, message });
    process.stderr.write(`[luna-worker] failed ${index + 1}/${specs.length} ${spec.path}: ${message}\n`);
  }
}

process.stdout.write(`[luna-worker] result ${JSON.stringify(result)}\n`);
if (result.failed.length > 0) process.exitCode = 1;
