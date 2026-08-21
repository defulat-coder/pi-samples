import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import envSchema from 'env-schema';
import { Type, type Static } from '@sinclair/typebox';

const schema = Type.Object({
  PORT: Type.Number({ default: 4310, minimum: 1, maximum: 65535 }),
  HOST: Type.String({ default: '127.0.0.1' }),
  WEB_ORIGIN: Type.String({ default: 'https://pi-workbench.localhost' }),
  PI_AGENT_ENABLED: Type.Boolean({ default: false }),
  /** Project extensions execute host TypeScript and stay opt-in by default. */
  PI_PROJECT_EXTENSIONS_ENABLED: Type.Boolean({ default: false }),
  PI_MODEL_PROVIDER: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  PI_MODEL: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  KIMI_API_KEY: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  PI_THINKING_LEVEL: Type.Optional(Type.Union([
    Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max'),
  ])),
  LOG_LEVEL: Type.Union([
    Type.Literal('trace'),
    Type.Literal('debug'),
    Type.Literal('info'),
    Type.Literal('warn'),
    Type.Literal('error'),
  ], { default: 'info' }),
});

export type AppConfig = Static<typeof schema>;

export function loadConfig(): AppConfig {
  const envPath = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')].find((candidate) => existsSync(candidate));
  // env-schema 8 reads .env via util.parseEnv, which no longer mutates process.env; load it explicitly so non-schema keys stay visible.
  if (envPath) process.loadEnvFile(envPath);
  return envSchema<AppConfig>({ schema });
}
