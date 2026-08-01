import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
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

export interface KnowledgeIndexOptions {
  /** Override the derived SQLite index path. `:memory:` is useful for tests. */
  indexPath?: string;
  /** Avoid rescanning unchanged files on every request. Set to 0 for tests. */
  refreshIntervalMs?: number;
}

export interface KnowledgeSearchOptions extends KnowledgeIndexOptions {
  limit?: number;
  root?: string;
}

type SqliteRow = Record<string, unknown>;
type FrontmatterValues = Record<string, unknown>;

interface ParsedMarkdown {
  values: FrontmatterValues;
  body: string;
}

interface FileEntry {
  absolutePath: string;
  id: string;
  mtimeNs: string;
  size: number;
}

interface IndexedFile {
  id: string;
  mtimeNs: string;
  size: number;
  contentHash: string;
}

interface KnowledgeMetadata {
  resource?: string;
  verified?: boolean;
  generated?: boolean;
  staleAfter?: string;
  domain?: string;
  topic?: string;
  variant?: string;
  canonical?: boolean;
}

interface IndexedConcept {
  concept: KnowledgeConcept;
  metadata: KnowledgeMetadata;
}

interface KnowledgeChunk {
  chunkId: string;
  ordinal: number;
  heading: string;
  body: string;
}

interface ConceptRow extends SqliteRow {
  root_key: string;
  id: string;
  path: string;
  type: string;
  title: string;
  description: string;
  tags_json: string;
  body: string;
  status: string;
  updated: string | null;
  metadata_json: string;
  mtime_ns: string;
  file_size: number;
  content_hash: string;
}

interface ChunkRow extends ConceptRow {
  chunk_id: string;
  ordinal: number;
  heading: string;
  chunk_body: string;
  relevance: number;
}

interface SearchCandidate {
  concept: KnowledgeConcept;
  metadata: KnowledgeMetadata;
  chunk: KnowledgeChunk;
  score: number;
}

interface SearchCacheEntry {
  expiresAt: number;
  results: QuerySource[];
}

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const CJK_OR_LATIN_TOKEN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\p{L}\p{N}_]+/gu;
const indexManagers = new Map<string, KnowledgeIndex>();

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;
}

function asBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function parseFrontmatter(raw: string): ParsedMarkdown {
  const normalized = raw.replace(/^\uFEFF/u, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?([\s\S]*)$/u);
  if (!match) return { values: {}, body: normalized.trim() };

  try {
    const parsed = parseYaml(match[1] ?? '');
    const values = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as FrontmatterValues : {};
    return { values, body: (match[2] ?? '').trim() };
  } catch {
    // A malformed frontmatter block should not make the whole knowledge bundle
    // unavailable. The Markdown remains searchable as body text.
    return { values: {}, body: normalized.trim() };
  }
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => parseList(item));
  if (typeof value !== 'string') return value == null ? [] : [String(value)];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function markdownFiles(root: string, baseRoot = root): FileEntry[] {
  if (!readdirSafe(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return markdownFiles(path, baseRoot);
      if (extname(entry.name) !== '.md' || basename(entry.name) === 'README.md' || basename(entry.name) === 'index.md') return [];
      const stat = statSync(path, { bigint: true });
      const id = relative(baseRoot, path).replace(/\\/g, '/').replace(/\.md$/u, '');
      return [{ absolutePath: path, id, mtimeNs: stat.mtimeNs.toString(), size: Number(stat.size) }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function readdirSafe(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
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

function displayPath(root: string, id: string): string {
  const normalizedRoot = root.replace(/\\/g, '/');
  if (normalizedRoot.endsWith('/.pi/knowledge')) return `.pi/knowledge/${id}.md`;
  return relative(process.cwd(), join(root, `${id}.md`)).replace(/\\/g, '/');
}

function metadataFromValues(values: FrontmatterValues): KnowledgeMetadata {
  return {
    resource: asString(values.resource) || undefined,
    verified: asBoolean(values.verified),
    generated: asBoolean(values.generated),
    staleAfter: asString(values.stale_after) || undefined,
    domain: asString(values.domain) || undefined,
    topic: asString(values.topic) || undefined,
    variant: asString(values.variant) || undefined,
    canonical: asBoolean(values.canonical),
  };
}

function conceptFromMarkdown(root: string, entry: FileEntry, raw: string): IndexedConcept {
  const { values, body } = parseFrontmatter(raw);
  const title = asString(values.title) || body.split('\n')[0]?.replace(/^#\s*/u, '') || entry.id;
  const description = asString(values.description) || body.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() || '';
  const statusValue = asString(values.status);
  const status: KnowledgeConcept['status'] = statusValue === 'draft' || statusValue === 'deprecated' ? statusValue : 'active';
  return {
    concept: {
      id: entry.id,
      path: displayPath(root, entry.id),
      type: asString(values.type, 'concept'),
      title,
      description,
      tags: parseList(values.tags),
      body,
      status,
      updated: asString(values.updated) || undefined,
    },
    metadata: metadataFromValues(values),
  };
}

function rootKey(root: string): string {
  return resolve(root).replace(/\\/g, '/');
}

function defaultIndexPath(root: string, explicit?: string): string {
  const configured = explicit ?? process.env.PI_KNOWLEDGE_INDEX_PATH;
  if (configured) return configured;

  const projectKnowledgeRoot = resolve(process.cwd(), '.pi/knowledge');
  if (resolve(root) === projectKnowledgeRoot) return resolve(process.cwd(), '.data/pi-knowledge.sqlite');

  const digest = createHash('sha1').update(rootKey(root)).digest('hex').slice(0, 12);
  return resolve(process.cwd(), '.data', `pi-knowledge-${digest}.sqlite`);
}

function refreshInterval(explicit: number | undefined, indexPath: string): number {
  if (explicit !== undefined) return Math.max(0, Math.trunc(explicit));
  if (indexPath === ':memory:') return 0;
  const configured = Number.parseInt(process.env.PI_KNOWLEDGE_REFRESH_INTERVAL_MS ?? '750', 10);
  return Number.isFinite(configured) ? Math.max(0, configured) : 750;
}

function normalizeForFts(value: string): string {
  return value
    .replace(/([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/gu, ' $1 ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
}

function queryTokens(query: string): string[] {
  const tokens = query.normalize('NFKC').toLocaleLowerCase().match(CJK_OR_LATIN_TOKEN) ?? [];
  return [...new Set(tokens.filter((token) => CJK_CHAR.test(token) || token.length > 1))];
}

function ftsQuery(tokens: string[]): string {
  // Quoting every token prevents FTS5 operators, column selectors and syntax
  // supplied by a user from becoming executable MATCH expressions.
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

function chunkMarkdown(body: string, id: string, maxChars = 1800): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let heading = '';
  let sectionLines: string[] = [];

  const pushText = (text: string, sectionHeading: string) => {
    const paragraphs = text.trim().split(/\n{2,}/u).map((paragraph) => paragraph.trim()).filter(Boolean);
    let buffer = '';
    const pushBuffer = () => {
      if (!buffer.trim()) return;
      chunks.push({ chunkId: `${id}::${chunks.length}`, ordinal: chunks.length, heading: sectionHeading, body: buffer.trim() });
      buffer = '';
    };

    for (const paragraph of paragraphs) {
      if (paragraph.length <= maxChars && buffer.length + paragraph.length + 2 <= maxChars) {
        buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
        continue;
      }
      pushBuffer();
      if (paragraph.length <= maxChars) {
        buffer = paragraph;
        continue;
      }
      for (let offset = 0; offset < paragraph.length; offset += maxChars) {
        chunks.push({ chunkId: `${id}::${chunks.length}`, ordinal: chunks.length, heading: sectionHeading, body: paragraph.slice(offset, offset + maxChars).trim() });
      }
    }
    pushBuffer();
  };

  for (const line of body.split(/\r?\n/u)) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/u);
    if (headingMatch) {
      pushText(sectionLines.join('\n'), heading);
      sectionLines = [];
      heading = headingMatch[1]!.trim();
    } else {
      sectionLines.push(line);
    }
  }
  pushText(sectionLines.join('\n'), heading);
  if (chunks.length === 0) chunks.push({ chunkId: `${id}::0`, ordinal: 0, heading: '', body: body.trim() });
  return chunks;
}

function conceptFromRow(row: ConceptRow): KnowledgeConcept {
  const status = row.status === 'draft' || row.status === 'deprecated' ? row.status : 'active';
  return {
    id: row.id,
    path: row.path,
    type: row.type,
    title: row.title,
    description: row.description,
    tags: JSON.parse(row.tags_json) as string[],
    body: row.body,
    status,
    updated: row.updated ?? undefined,
  };
}

function parseMetadata(value: string): KnowledgeMetadata {
  try {
    return JSON.parse(value) as KnowledgeMetadata;
  } catch {
    return {};
  }
}

function normalizedTitleFamily(title: string): string {
  return title
    .replace(/[：:]\s*(?:架构|实现|验证与运维|运维|architecture|implementation|operations)(?:视角)?$/iu, '')
    .trim()
    .toLocaleLowerCase();
}

function excerptFor(chunk: KnowledgeChunk, tokens: string[]): string {
  const lines = chunk.body.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).filter((line) => !line.startsWith('#'));
  const hit = lines.find((line) => tokens.some((token) => line.toLocaleLowerCase().includes(token))) ?? lines[0] ?? chunk.body;
  const prefix = chunk.heading ? `${chunk.heading}：` : '';
  const excerpt = `${prefix}${hit}`;
  return excerpt.length > 420 ? `${excerpt.slice(0, 417)}...` : excerpt;
}

function scoreCandidate(row: ChunkRow, concept: KnowledgeConcept, metadata: KnowledgeMetadata, query: string, tokens: string[]): number {
  const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase().trim();
  const title = concept.title.toLocaleLowerCase();
  const heading = row.heading.toLocaleLowerCase();
  const haystack = `${title} ${concept.description.toLocaleLowerCase()} ${row.chunk_body.toLocaleLowerCase()}`;
  let score = -Number(row.relevance || 0);
  if (normalizedQuery.length > 1 && title.includes(normalizedQuery)) score += 12;
  if (normalizedQuery.length > 1 && haystack.includes(normalizedQuery)) score += 3;
  score += tokens.filter((token) => title.includes(token)).length * 2.5;
  score += tokens.filter((token) => heading.includes(token)).length * 1.8;
  if (metadata.verified) score += 1;
  if (metadata.canonical) score += 1.5;
  if (metadata.variant && tokens.some((token) => metadata.variant!.toLocaleLowerCase().includes(token))) score += 2;
  if (metadata.staleAfter && metadata.staleAfter < new Date().toISOString().slice(0, 10)) score -= 2;
  return score;
}

class KnowledgeIndex {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private refreshIntervalMs: number;
  private lastSyncAt = 0;
  private lastSyncRoot = '';
  private chunkIndexValidated = false;
  private readonly searchCache = new Map<string, SearchCacheEntry>();

  constructor(dbPath: string, refreshIntervalMs: number) {
    this.dbPath = dbPath;
    this.refreshIntervalMs = refreshIntervalMs;
    if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_concepts (
        root_key TEXT NOT NULL,
        id TEXT NOT NULL,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        updated TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        mtime_ns TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (root_key, id)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_concepts_root_status ON knowledge_concepts(root_key, status);
    `);
    const columns = this.db.prepare('PRAGMA table_info(knowledge_concepts)').all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === 'metadata_json')) this.db.exec("ALTER TABLE knowledge_concepts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    // The previous index version stored whole documents. It is a derived cache,
    // so remove it once when upgrading to the chunk index.
    this.db.exec('DROP TABLE IF EXISTS knowledge_fts;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        root_key TEXT NOT NULL,
        id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        heading TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (root_key, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks(root_key, id, ordinal);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        root_key UNINDEXED,
        id UNINDEXED,
        chunk_id UNINDEXED,
        title,
        description,
        tags,
        heading,
        body
      );
    `);
  }

  setRefreshInterval(refreshIntervalMs: number): void {
    this.refreshIntervalMs = refreshIntervalMs;
  }

  sync(root: string): void {
    const key = rootKey(root);
    const now = Date.now();
    if (this.refreshIntervalMs > 0 && this.lastSyncRoot === key && now - this.lastSyncAt < this.refreshIntervalMs) return;

    const entries = markdownFiles(root);
    const currentIds = new Set(entries.map((entry) => entry.id));
    const existingRows = this.db.prepare('SELECT id, mtime_ns, file_size, content_hash FROM knowledge_concepts WHERE root_key = ?').all(key) as ConceptRow[];
    let missingChunkIds = new Set<string>();
    if (!this.chunkIndexValidated) {
      const chunkCounts = this.db.prepare('SELECT id, COUNT(*) AS count FROM knowledge_chunks WHERE root_key = ? GROUP BY id').all(key) as Array<{ id: string; count: number }>;
      const chunkCount = chunkCounts.reduce((total, row) => total + Number(row.count), 0);
      const ftsCount = Number((this.db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks_fts WHERE root_key = ?').get(key) as { count: number }).count);
      if (chunkCount === 0 || chunkCount !== ftsCount) {
        missingChunkIds = new Set(existingRows.map((row) => row.id));
      } else {
        const countsById = new Map(chunkCounts.map((row) => [row.id, Number(row.count)]));
        missingChunkIds = new Set(existingRows.filter((row) => !countsById.has(row.id)).map((row) => row.id));
      }
    }
    const existing = new Map<string, IndexedFile>(existingRows.map((row) => [row.id, {
      id: row.id,
      mtimeNs: row.mtime_ns,
      size: Number(row.file_size),
      contentHash: row.content_hash,
    }]));
    const changedEntries = entries.filter((entry) => {
      const previous = existing.get(entry.id);
      return !previous || previous.mtimeNs !== entry.mtimeNs || previous.size !== entry.size || missingChunkIds.has(entry.id);
    });
    const deletedIds = existingRows.map((row) => row.id).filter((id) => !currentIds.has(id));
    if (changedEntries.length === 0 && deletedIds.length === 0) {
      this.chunkIndexValidated = true;
      this.lastSyncRoot = key;
      this.lastSyncAt = now;
      return;
    }

    const deleteFts = this.db.prepare('DELETE FROM knowledge_chunks_fts WHERE root_key = ? AND id = ?');
    const deleteChunks = this.db.prepare('DELETE FROM knowledge_chunks WHERE root_key = ? AND id = ?');
    const deleteConcept = this.db.prepare('DELETE FROM knowledge_concepts WHERE root_key = ? AND id = ?');
    const insertConcept = this.db.prepare(`
      INSERT INTO knowledge_concepts (
        root_key, id, path, type, title, description, tags_json, body, status, updated, metadata_json, mtime_ns, file_size, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = this.db.prepare('INSERT INTO knowledge_chunks (root_key, id, chunk_id, ordinal, heading, body) VALUES (?, ?, ?, ?, ?, ?)');
    const insertFts = this.db.prepare('INSERT INTO knowledge_chunks_fts (root_key, id, chunk_id, title, description, tags, heading, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const updateMetadata = this.db.prepare('UPDATE knowledge_concepts SET mtime_ns = ?, file_size = ? WHERE root_key = ? AND id = ?');

    this.db.exec('BEGIN');
    try {
      for (const id of deletedIds) {
        deleteFts.run(key, id);
        deleteChunks.run(key, id);
        deleteConcept.run(key, id);
      }

      for (const entry of changedEntries) {
        const raw = readFileSync(entry.absolutePath, 'utf8');
        const hash = createHash('sha256').update(raw).digest('hex');
        const previous = existing.get(entry.id);
        if (previous && previous.contentHash === hash && !missingChunkIds.has(entry.id)) {
          updateMetadata.run(entry.mtimeNs, entry.size, key, entry.id);
          continue;
        }

        const { concept, metadata } = conceptFromMarkdown(root, entry, raw);
        const chunks = chunkMarkdown(concept.body, concept.id);
        deleteFts.run(key, entry.id);
        deleteChunks.run(key, entry.id);
        deleteConcept.run(key, entry.id);
        insertConcept.run(
          key,
          concept.id,
          concept.path,
          concept.type,
          concept.title,
          concept.description,
          JSON.stringify(concept.tags),
          concept.body,
          concept.status,
          concept.updated ?? null,
          JSON.stringify(metadata),
          entry.mtimeNs,
          entry.size,
          hash,
        );
        for (const chunk of chunks) {
          insertChunk.run(key, concept.id, chunk.chunkId, chunk.ordinal, chunk.heading, chunk.body);
          insertFts.run(
            key,
            concept.id,
            chunk.chunkId,
            normalizeForFts(concept.title),
            normalizeForFts(concept.description),
            normalizeForFts(concept.tags.join(' ')),
            normalizeForFts(chunk.heading),
            normalizeForFts(chunk.body),
          );
        }
      }
      this.db.exec('COMMIT');
      this.searchCache.clear();
      this.chunkIndexValidated = true;
      this.lastSyncRoot = key;
      this.lastSyncAt = Date.now();
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  list(root: string): KnowledgeConcept[] {
    const key = rootKey(root);
    const rows = this.db.prepare('SELECT * FROM knowledge_concepts WHERE root_key = ? ORDER BY id').all(key) as ConceptRow[];
    return rows.map(conceptFromRow);
  }

  search(root: string, query: string, limit: number): QuerySource[] {
    const tokens = queryTokens(query);
    if (tokens.length === 0 || limit === 0) return [];
    const key = rootKey(root);
    const cacheKey = `${key}\u0000${query}\u0000${limit}`;
    const now = Date.now();
    const cached = this.searchCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.results.map((result) => ({ ...result, fields: result.fields ? [...result.fields] : undefined }));
    if (cached) this.searchCache.delete(cacheKey);
    const maxChunks = Math.max(limit * 8, 24);
    const rows = this.db.prepare(`
      SELECT
        c.root_key, c.id, c.path, c.type, c.title, c.description, c.tags_json, c.body,
        c.status, c.updated, c.metadata_json, c.mtime_ns, c.file_size, c.content_hash,
        ch.chunk_id, ch.ordinal, ch.heading, ch.body AS chunk_body,
        bm25(knowledge_chunks_fts, 8.0, 4.0, 3.0, 6.0, 1.0) AS relevance
      FROM knowledge_chunks_fts
      INNER JOIN knowledge_chunks AS ch
        ON ch.root_key = knowledge_chunks_fts.root_key
        AND ch.id = knowledge_chunks_fts.id
        AND ch.chunk_id = knowledge_chunks_fts.chunk_id
      INNER JOIN knowledge_concepts AS c
        ON c.root_key = ch.root_key AND c.id = ch.id
      WHERE knowledge_chunks_fts.root_key = ?
        AND knowledge_chunks_fts MATCH ?
        AND c.status = 'active'
      ORDER BY relevance ASC
      LIMIT ?
    `).all(key, ftsQuery(tokens), maxChunks) as ChunkRow[];

    const candidates: SearchCandidate[] = rows.map((row) => {
      const concept = conceptFromRow(row);
      const metadata = parseMetadata(row.metadata_json);
      const chunk = { chunkId: row.chunk_id, ordinal: Number(row.ordinal), heading: row.heading, body: row.chunk_body } satisfies KnowledgeChunk;
      return { concept, metadata, chunk, score: scoreCandidate(row, concept, metadata, query, tokens) };
    });
    candidates.sort((left, right) => right.score - left.score || left.concept.title.localeCompare(right.concept.title) || left.chunk.ordinal - right.chunk.ordinal);

    const selected = new Map<string, SearchCandidate>();
    for (const candidate of candidates) {
      const family = normalizedTitleFamily(candidate.concept.title);
      const previous = selected.get(family);
      if (!previous || candidate.score > previous.score) selected.set(family, candidate);
    }

    const results = [...selected.values()]
      .sort((left, right) => right.score - left.score || left.concept.title.localeCompare(right.concept.title))
      .slice(0, limit)
      .map(({ concept, metadata, chunk }) => ({
        kind: 'knowledge',
        title: concept.title,
        ref: concept.path,
        excerpt: excerptFor(chunk, tokens),
        fields: [
          ...concept.tags,
          chunk.heading ? `章节：${chunk.heading}` : '',
          metadata.verified ? '已验证' : '',
          concept.updated ? `更新于 ${concept.updated}` : '',
        ].filter(Boolean),
      }) satisfies QuerySource);
    const cacheTtl = Number.parseInt(process.env.PI_KNOWLEDGE_SEARCH_CACHE_TTL_MS ?? '3000', 10);
    if (Number.isFinite(cacheTtl) && cacheTtl > 0) {
      this.searchCache.set(cacheKey, { expiresAt: now + cacheTtl, results });
      if (this.searchCache.size > 128) this.searchCache.delete(this.searchCache.keys().next().value as string);
    }
    return results.map((result) => ({ ...result, fields: result.fields ? [...result.fields] : undefined }));
  }

  close(): void {
    this.db.close();
  }
}

function getIndex(root: string, options: KnowledgeIndexOptions = {}): KnowledgeIndex {
  const path = defaultIndexPath(root, options.indexPath);
  const key = `${rootKey(root)}\u0000${path}`;
  const interval = refreshInterval(options.refreshIntervalMs, path);
  const existing = indexManagers.get(key);
  if (existing) {
    existing.setRefreshInterval(interval);
    return existing;
  }
  const manager = new KnowledgeIndex(path, interval);
  indexManagers.set(key, manager);
  return manager;
}

export function closeKnowledgeIndexes(): void {
  for (const manager of indexManagers.values()) manager.close();
  indexManagers.clear();
}

export function loadKnowledgeBundle(root = defaultKnowledgeRoot(), options: KnowledgeIndexOptions = {}): KnowledgeConcept[] {
  const index = getIndex(root, options);
  index.sync(root);
  return index.list(root);
}

export function searchKnowledge(query: string, options: KnowledgeSearchOptions = {}): QuerySource[] {
  const root = options.root ?? defaultKnowledgeRoot();
  const limit = Math.max(0, Math.min(Math.trunc(options.limit ?? 3), 50));
  const index = getIndex(root, options);
  index.sync(root);
  return index.search(root, query, limit);
}
