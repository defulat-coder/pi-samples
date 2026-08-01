import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import type { QuerySource } from '@pi-workbench/contracts';

export interface KnowledgeConcept {
  id: string;
  path: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
  status: 'active' | 'draft' | 'deprecated';
  updated?: string;
}

const knownTerms = ['Pi', 'Agent', 'session', 'turn', '资源', '文件', 'skill', 'prompt', '知识库', 'Markdown', '工具', '权限', '只读', 'read', '安全', '回答', '来源', '事件', '调试', '降级', 'fallback', '生命周期'];

function parseFrontmatter(raw: string): { values: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { values: {}, body: raw.trim() };
  const values: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return { values, body: match[2]!.trim() };
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value.replace(/^\[|\]$/g, '').split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function markdownFiles(root: string): string[] {
  if (!readdirSafe(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return extname(entry.name) === '.md' && basename(entry.name) !== 'README.md' && basename(entry.name) !== 'index.md' ? [path] : [];
  });
}

function readdirSafe(path: string): boolean {
  try { readdirSync(path); return true; } catch { return false; }
}

function defaultKnowledgeRoot(): string {
  const candidates = [
    process.env.PI_WORKSPACE_KNOWLEDGE_DIR,
    resolve(process.cwd(), '.pi/knowledge'),
    resolve(process.cwd(), 'knowledge'),
    resolve(dirname(new URL(import.meta.url).pathname), '../../../.pi/knowledge'),
    resolve(process.cwd(), '../../knowledge'),
    resolve(dirname(new URL(import.meta.url).pathname), '../../../knowledge'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(readdirSafe) ?? candidates[0]!;
}

export function loadKnowledgeBundle(root = defaultKnowledgeRoot()): KnowledgeConcept[] {
  return markdownFiles(root).map((path) => {
    const raw = readFileSync(path, 'utf8');
    const { values, body } = parseFrontmatter(raw);
    const id = relative(root, path).replace(/\\/g, '/').replace(/\.md$/, '');
    return {
      id,
      path: root.replace(/\\/g, '/').endsWith('/.pi/knowledge') ? `.pi/knowledge/${id}.md` : relative(process.cwd(), path).replace(/\\/g, '/'),
      type: values.type ?? 'concept',
      title: values.title ?? body.split('\n')[0]?.replace(/^#\s*/, '') ?? id,
      description: values.description ?? body.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? '',
      tags: parseList(values.tags),
      body,
      status: (values.status === 'draft' || values.status === 'deprecated' ? values.status : 'active'),
      updated: values.updated,
    } satisfies KnowledgeConcept;
  });
}

export function searchKnowledge(query: string, options: { limit?: number; root?: string } = {}): QuerySource[] {
  const concepts = loadKnowledgeBundle(options.root).filter((concept) => concept.status === 'active');
  const normalized = query.toLowerCase();
  const terms = Array.from(new Set([...normalized.split(/[\s，。！？、,.!?]+/).filter((term) => term.length > 1), ...knownTerms.filter((term) => normalized.includes(term.toLowerCase()))]));
  const ranked = concepts.map((concept) => {
    const haystack = `${concept.title} ${concept.description} ${concept.tags.join(' ')} ${concept.body}`.toLowerCase();
    let score = normalized && haystack.includes(normalized) ? 5 : 0;
    for (const term of terms) {
      if (concept.title.toLowerCase().includes(term)) score += 5;
      if (concept.tags.some((tag) => tag.toLowerCase().includes(term))) score += 4;
      if (concept.body.toLowerCase().includes(term)) score += 2;
    }
    return { concept, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, options.limit ?? 3);
  return ranked.map(({ concept }) => ({ kind: 'knowledge', title: concept.title, ref: concept.path, excerpt: excerptFor(concept, terms), fields: [...concept.tags, concept.updated ? `更新于 ${concept.updated}` : ''].filter(Boolean) }));
}

function excerptFor(concept: KnowledgeConcept, terms: string[]): string {
  const lines = concept.body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !line.startsWith('#'));
  const hit = lines.find((line) => terms.some((term) => line.toLowerCase().includes(term))) ?? lines[0] ?? concept.description;
  return hit.length > 180 ? `${hit.slice(0, 177)}...` : hit;
}
