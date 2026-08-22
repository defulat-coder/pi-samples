import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AGENT_THINKING_LEVELS, type AgentThinkingLevel } from '@pi-workbench/contracts';

export type PiThinkingLevel = AgentThinkingLevel;

export interface PiModelConfig {
  provider?: string;
  model?: string;
}

/**
 * settings.json 按 path+mtimeMs 缓存（与 session-store 的 entriesCache 同款思路）：
 * chat/meta 路由每请求要读 2-3 次配置，mtime 不变时直接复用上次的解析结果。
 */
const settingsCache = new Map<string, { mtimeMs: number; parsed: Record<string, unknown> }>();

function readPiSettings(cwd: string): Record<string, unknown> {
  const path = resolve(cwd, '.pi/settings.json');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    settingsCache.delete(path);
    return {};
  }
  const cached = settingsCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.parsed;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    settingsCache.set(path, { mtimeMs, parsed });
    return parsed;
  } catch {
    // Environment variables and the kimi-coding default remain the contract.
    return {};
  }
}

export function getPiProjectRoot(): string {
  const candidate = process.cwd();
  for (const current of [candidate, resolve(candidate, '..'), resolve(candidate, '../..')]) {
    if (existsSync(resolve(current, '.pi'))) return current;
  }
  return resolve(dirname(new URL(import.meta.url).pathname), '../../..');
}

export function getPiModelConfig(overrides: { provider?: string; model?: string } = {}, cwd = getPiProjectRoot()): PiModelConfig {
  const settings = readPiSettings(cwd) as { defaultProvider?: unknown; defaultModel?: unknown };
  const configuredProvider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider.trim() : undefined;
  const configuredModel = typeof settings.defaultModel === 'string' ? settings.defaultModel.trim() : undefined;
  const provider = overrides.provider ?? process.env.PI_MODEL_PROVIDER?.trim() ?? configuredProvider ?? 'kimi-coding';
  const model = overrides.model ?? process.env.PI_MODEL?.trim() ?? configuredModel ?? (provider === 'kimi-coding' ? 'kimi-for-coding' : undefined);
  return { provider, model };
}

export function getPiThinkingLevel(level?: PiThinkingLevel, cwd = getPiProjectRoot()): PiThinkingLevel {
  if (level) return level;
  const configured = process.env.PI_THINKING_LEVEL;
  if (configured && (AGENT_THINKING_LEVELS as readonly string[]).includes(configured)) return configured as PiThinkingLevel;
  const settings = readPiSettings(cwd) as { defaultThinkingLevel?: unknown };
  if (typeof settings.defaultThinkingLevel === 'string' && (AGENT_THINKING_LEVELS as readonly string[]).includes(settings.defaultThinkingLevel)) return settings.defaultThinkingLevel as PiThinkingLevel;
  return 'off';
}

let modelRuntimePromise: Promise<ModelRuntime> | undefined;

/** One ModelRuntime per process; catalog lookups and session creation share the instance. */
export function getModelRuntime(): Promise<ModelRuntime> {
  modelRuntimePromise ??= ModelRuntime.create({ allowModelNetwork: false });
  return modelRuntimePromise;
}

/** Static provider catalog for the configured provider; used to render and validate the Web model picker. */
export async function listPiModels(cwd?: string): Promise<Array<{ id: string; name: string }>> {
  const { provider } = getPiModelConfig({}, cwd);
  if (!provider) return [];
  const runtime = await getModelRuntime();
  return runtime.getModels(provider).map((model) => ({ id: model.id, name: model.name }));
}
