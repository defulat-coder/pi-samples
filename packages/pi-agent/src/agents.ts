import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, stripFrontmatter } from '@earendil-works/pi-coding-agent';
import type { AgentDetail, AgentSummary, PromptDocument, PromptSummary } from '@pi-workbench/contracts';

const AGENT_ID_REGEX = /^[a-z][a-z0-9-]{1,63}$/;
const PROMPT_NAME_REGEX = /^[a-z0-9-]{1,80}$/;

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

/** Lists .pi/prompts/*.md as prompt templates; the name is the filename without extension. */
export function listPrompts(cwd: string): PromptSummary[] {
  const directory = join(cwd, '.pi', 'prompts');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((fileName) => fileName.toLowerCase().endsWith('.md'))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => {
      const name = fileName.replace(/\.md$/i, '');
      const { frontmatter } = parseFrontmatter(readFileSync(join(directory, fileName), 'utf8'));
      const description = typeof frontmatter.description === 'string' && frontmatter.description.trim() ? frontmatter.description.trim() : undefined;
      return { name, path: `.pi/prompts/${fileName}`, ...(description ? { description } : {}) };
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
