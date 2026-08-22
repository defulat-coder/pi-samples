import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AGENT_THINKING_LEVELS, type AgentThinkingLevel } from '@pi-workbench/contracts';

export type PiThinkingLevel = AgentThinkingLevel;

export interface PiModelConfig {
  provider?: string;
  model?: string;
}

export function getPiProjectRoot(): string {
  const candidate = process.cwd();
  for (const current of [candidate, resolve(candidate, '..'), resolve(candidate, '../..')]) {
    if (existsSync(resolve(current, '.pi'))) return current;
  }
  return resolve(dirname(new URL(import.meta.url).pathname), '../../..');
}

export function getPiModelConfig(overrides: { provider?: string; model?: string } = {}, cwd = getPiProjectRoot()): PiModelConfig {
  let settings: { defaultProvider?: unknown; defaultModel?: unknown } = {};
  try {
    settings = JSON.parse(readFileSync(resolve(cwd, '.pi/settings.json'), 'utf8')) as typeof settings;
  } catch {
    // Environment variables and the kimi-coding default remain the contract.
  }
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
  try {
    const settings = JSON.parse(readFileSync(resolve(cwd, '.pi/settings.json'), 'utf8')) as { defaultThinkingLevel?: unknown };
    if (typeof settings.defaultThinkingLevel === 'string' && (AGENT_THINKING_LEVELS as readonly string[]).includes(settings.defaultThinkingLevel)) return settings.defaultThinkingLevel as PiThinkingLevel;
  } catch {
    // Keep the no-thinking project default when settings are absent or invalid.
  }
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
