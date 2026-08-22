import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, stripFrontmatter } from '@earendil-works/pi-coding-agent';
import { AGENT_ID_PATTERN, type AgentDetail, type AgentResources, type AgentSummary, type CreateAgentRequest, type PromptDocument, type PromptSummary, type SkillSummary } from '@pi-workbench/contracts';

const AGENT_ID_REGEX = new RegExp(AGENT_ID_PATTERN);
const PROMPT_NAME_REGEX = /^[a-z0-9-]{1,80}$/;
/** Hard cap for a generated agent file; enforced again at the API schema. */
export const AGENT_BODY_MAX_BYTES = 32 * 1024;
const PREVIEW_LENGTH = 200;

export type AgentCreateErrorCode = 'INVALID_ID' | 'INVALID_FIELD' | 'CONFLICT' | 'TOO_LARGE';

/** Validation failure while creating an agent file; the API maps `code` onto HTTP statuses. */
export class AgentCreateError extends Error {
  readonly code: AgentCreateErrorCode;
  constructor(code: AgentCreateErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Lowercases to an ascii slug; returns undefined when nothing usable remains (e.g. pure Chinese names). */
export function deriveAgentId(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
  return AGENT_ID_REGEX.test(slug) ? slug : undefined;
}

function assertSingleLine(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) throw new AgentCreateError('INVALID_FIELD', `Agent 字段 ${field} 必须是非空单行字符串`);
  return trimmed;
}

/** JSON double-quoted scalars are valid YAML scalars, so arbitrary text survives the roundtrip. */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/**
 * Writes .pi/agents/<id>.md for a new agent. The id regex keeps the path inside
 * the agents directory by construction; 'wx' makes the write fail on conflicts.
 */
export function createAgent(cwd: string, input: CreateAgentRequest): AgentDefinition {
  const id = input.id?.trim() || deriveAgentId(input.name);
  if (!id || !AGENT_ID_REGEX.test(id)) throw new AgentCreateError('INVALID_ID', 'Agent id 需匹配 [a-z][a-z0-9-]{1,63}；中文名称请显式提供 id');

  const name = assertSingleLine(input.name, 'name');
  const mark = assertSingleLine(input.mark, 'mark');
  const tagline = assertSingleLine(input.tagline, 'tagline');
  const description = assertSingleLine(input.description, 'description');
  if (!Array.isArray(input.suggestions) || !input.suggestions.length) throw new AgentCreateError('INVALID_FIELD', 'Agent 字段 suggestions 必须是非空字符串数组');
  const suggestions = input.suggestions.map((item) => assertSingleLine(item, 'suggestions'));
  const body = input.body.trim();
  if (!body) throw new AgentCreateError('INVALID_FIELD', 'Agent 定义缺少系统提示词正文');
  if (Buffer.byteLength(body, 'utf8') > AGENT_BODY_MAX_BYTES) throw new AgentCreateError('TOO_LARGE', `系统提示词正文超过 ${AGENT_BODY_MAX_BYTES} 字节上限`);

  const file = [
    '---',
    `name: ${yamlScalar(name)}`,
    `mark: ${yamlScalar(mark)}`,
    `tagline: ${yamlScalar(tagline)}`,
    `description: ${yamlScalar(description)}`,
    'suggestions:',
    ...suggestions.map((item) => `  - ${yamlScalar(item)}`),
    '---',
    '',
    body,
    '',
  ].join('\n');

  const directory = join(cwd, '.pi', 'agents');
  const target = join(directory, `${id}.md`);
  if (existsSync(target)) throw new AgentCreateError('CONFLICT', `Agent 已存在：${id}`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(target, file, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new AgentCreateError('CONFLICT', `Agent 已存在：${id}`);
    throw error;
  }
  // Roundtrip through the real parser so a serialization bug can never persist a broken file.
  return parseAgentFile(directory, `${id}.md`);
}

export type AgentDefinition = AgentDetail;

function requiredString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Agent 定义字段 ${field} 必须是非空字符串：${path}`);
  return value.trim();
}

function parseAgentFile(directory: string, fileName: string): AgentDefinition {
  const id = fileName.replace(/\.md$/i, '');
  const path = join(directory, fileName);
  if (!AGENT_ID_REGEX.test(id)) throw new Error(`Agent 文件名不是合法 id：${fileName}`);
  const { frontmatter, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  const name = requiredString(frontmatter.name, 'name', path);
  const mark = requiredString(frontmatter.mark, 'mark', path);
  const tagline = requiredString(frontmatter.tagline, 'tagline', path);
  const description = requiredString(frontmatter.description, 'description', path);
  const suggestions = frontmatter.suggestions;
  if (!Array.isArray(suggestions) || !suggestions.length || suggestions.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Agent 定义字段 suggestions 必须是非空字符串数组：${path}`);
  }
  const systemPrompt = body.trim();
  if (!systemPrompt) throw new Error(`Agent 定义缺少系统提示词正文：${path}`);
  return { id, name, mark, tagline, description, suggestions: suggestions.map((item) => item.trim()), body: systemPrompt, path: `.pi/agents/${fileName}` };
}

/**
 * File-first agent registry: every .pi/agents/<id>.md is an agent.
 * Adding a file adds an agent; no registry or capability profile is involved.
 */
export function loadAgents(cwd: string): AgentDefinition[] {
  const directory = join(cwd, '.pi', 'agents');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((fileName) => fileName.toLowerCase().endsWith('.md'))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => parseAgentFile(directory, fileName));
}

export function getAgent(cwd: string, agentId: string): AgentDefinition {
  const agent = loadAgents(cwd).find((item) => item.id === agentId);
  if (!agent) throw new Error(`Agent 不存在：${agentId}`);
  return agent;
}

export function agentSummary(agent: AgentDefinition): AgentSummary {
  const { id, name, mark, tagline, description, suggestions } = agent;
  return { id, name, mark, tagline, description, suggestions };
}

function previewOf(raw: string): string | undefined {
  const text = stripFrontmatter(raw).trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, PREVIEW_LENGTH) : undefined;
}

/** Lists .pi/prompts/*.md as prompt templates; the name is the filename without extension. */
export function listPrompts(cwd: string): PromptSummary[] {
  const directory = join(cwd, '.pi', 'prompts');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((fileName) => fileName.toLowerCase().endsWith('.md'))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => {
      const name = fileName.replace(/\.md$/i, '');
      const raw = readFileSync(join(directory, fileName), 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      const description = typeof frontmatter.description === 'string' && frontmatter.description.trim() ? frontmatter.description.trim() : undefined;
      const preview = previewOf(raw);
      return { name, path: `.pi/prompts/${fileName}`, ...(description ? { description } : {}), ...(preview ? { preview } : {}) };
    });
}

/**
 * Lists .pi/skills/<dir>/SKILL.md entries; an absent or empty directory yields [].
 * Skills are third-party content: entries without readable frontmatter fall back
 * to the directory name instead of failing the whole list.
 */
export function listSkills(cwd: string): SkillSummary[] {
  const directory = join(cwd, '.pi', 'skills');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'SKILL.md')))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const path = `.pi/skills/${entry.name}/SKILL.md`;
      const raw = readFileSync(join(cwd, path), 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : entry.name;
      const description = typeof frontmatter.description === 'string' && frontmatter.description.trim() ? frontmatter.description.trim() : undefined;
      const preview = previewOf(raw);
      return { name, path, ...(description ? { description } : {}), ...(preview ? { preview } : {}) };
    });
}

/** Reads one prompt template body; the name pattern blocks path traversal by construction. */
export function readPrompt(cwd: string, name: string): PromptDocument | undefined {
  if (!PROMPT_NAME_REGEX.test(name)) return undefined;
  const summary = listPrompts(cwd).find((prompt) => prompt.name === name);
  if (!summary) return undefined;
  const content = stripFrontmatter(readFileSync(join(cwd, summary.path), 'utf8')).trim();
  return { ...summary, content };
}

/**
 * Lists the project resources every agent sees: .pi/prompts, .pi/skills and
 * whether .pi/APPEND_SYSTEM.md exists. Resources are project-wide, so the
 * result is identical for all agents; the API exposes it per agent to match
 * the configure panel's shape.
 */
export function listAgentResources(cwd: string): Omit<AgentResources, 'stats'> {
  return {
    prompts: listPrompts(cwd),
    skills: listSkills(cwd),
    appendSystem: existsSync(join(cwd, '.pi', 'APPEND_SYSTEM.md')),
  };
}
