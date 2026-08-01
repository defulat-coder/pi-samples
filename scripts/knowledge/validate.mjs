import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const knowledgeRoot = join(projectRoot, '.pi', 'knowledge');
const expectedCount = Number.parseInt(process.env.EXPECTED_KNOWLEDGE_COUNT ?? '455', 10);
const minimumBodyCharacters = 2_000;
const requiredFields = ['type', 'title', 'description', 'resource', 'tags', 'status', 'verified', 'updated'];
const validStatuses = new Set(['active', 'archived', 'deprecated', 'draft']);

if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
  console.error('EXPECTED_KNOWLEDGE_COUNT must be a non-negative integer.');
  process.exit(2);
}

async function collectMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.sort((left, right) => left.name.localeCompare(right.name)).map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectMarkdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md' && entry.name !== 'index.md' ? [path] : [];
  }));
  return nested.flat();
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { fields: new Map(), body: content, hasFrontmatter: false };

  const fields = new Map();
  for (const line of match[1].split(/\r?\n/u)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u);
    if (field) fields.set(field[1], field[2]);
  }
  return { fields, body: content.slice(match[0].length), hasFrontmatter: true };
}

function nonWhitespaceLength(value) {
  return Array.from(value).filter((character) => !/\s/u.test(character)).length;
}

function scalar(value) {
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2').trim();
}

const files = await collectMarkdownFiles(knowledgeRoot);
const failures = [];
const titles = new Map();
const resources = new Map();
const directories = {};

if (files.length !== expectedCount) {
  failures.push(`Expected ${expectedCount} knowledge documents, found ${files.length}.`);
}

for (const path of files) {
  const documentPath = relative(projectRoot, path).split(sep).join('/');
  const directory = relative(knowledgeRoot, dirname(path)).split(sep).join('/') || '.';
  directories[directory] = (directories[directory] ?? 0) + 1;

  const { fields, body, hasFrontmatter } = parseFrontmatter(await readFile(path, 'utf8'));
  if (!hasFrontmatter) {
    failures.push(`${documentPath}: missing YAML frontmatter.`);
    continue;
  }

  for (const name of requiredFields) {
    if (!fields.has(name) || scalar(fields.get(name)) === '') {
      failures.push(`${documentPath}: missing required frontmatter field \"${name}\".`);
    }
  }

  const status = scalar(fields.get('status') ?? '');
  if (status && !validStatuses.has(status)) {
    failures.push(`${documentPath}: invalid status \"${status}\".`);
  }

  const verified = scalar(fields.get('verified') ?? '');
  if (verified && verified !== 'true' && verified !== 'false') {
    failures.push(`${documentPath}: verified must be true or false.`);
  }

  const title = scalar(fields.get('title') ?? '');
  if (title) {
    const previous = titles.get(title);
    if (previous) failures.push(`${documentPath}: duplicate title \"${title}\" (also ${previous}).`);
    else titles.set(title, documentPath);
  }

  const resource = scalar(fields.get('resource') ?? '');
  if (resource) {
    const previous = resources.get(resource);
    if (previous) failures.push(`${documentPath}: duplicate resource \"${resource}\" (also ${previous}).`);
    else resources.set(resource, documentPath);
  }

  const bodyLength = nonWhitespaceLength(body);
  if (bodyLength < minimumBodyCharacters) {
    failures.push(`${documentPath}: body has ${bodyLength} non-whitespace characters; expected at least ${minimumBodyCharacters}.`);
  }
}

const summary = {
  ok: failures.length === 0,
  expectedCount,
  documentCount: files.length,
  minimumBodyCharacters,
  directories: Object.fromEntries(Object.entries(directories).sort(([left], [right]) => left.localeCompare(right))),
  failures,
};

console.log(JSON.stringify(summary));
process.exitCode = summary.ok ? 0 : 1;
