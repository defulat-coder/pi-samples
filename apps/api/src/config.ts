import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import envSchema from 'env-schema';
import { Type, type Static } from '@sinclair/typebox';

const schema = Type.Object({
  PORT: Type.Number({ default: 4310, minimum: 1, maximum: 65535 }),
  HOST: Type.String({ default: '127.0.0.1' }),
  WEB_ORIGIN: Type.String({ default: 'http://localhost:5173' }),
  PI_AGENT_ENABLED: Type.Boolean({ default: false }),
  PI_MODEL_PROVIDER: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  PI_MODEL: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
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
  return envSchema<AppConfig>({ schema, dotenv: envPath ? { path: envPath } : true });
}
