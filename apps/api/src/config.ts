import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import envSchema from 'env-schema';
import { Type, type Static } from '@sinclair/typebox';

const schema = Type.Object({
  PORT: Type.Number({ default: 4310, minimum: 1, maximum: 65535 }),
  HOST: Type.String({ default: '127.0.0.1' }),
  WEB_ORIGIN: Type.String({ default: 'http://localhost:5173' }),
  AUTH_REQUIRED: Type.Boolean({ default: true }),
  AUTH_SESSION_TTL_SECONDS: Type.Optional(Type.Integer({ minimum: 300, maximum: 2_592_000 })),
  AUTH_COOKIE_NAME: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  AUTH_COOKIE_SECURE: Type.Optional(Type.Boolean()),
  FEISHU_APP_ID: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  FEISHU_APP_SECRET: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  FEISHU_REDIRECT_URI: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  FEISHU_SCOPE: Type.Optional(Type.String({ maxLength: 1000 })),
  PI_AGENT_ENABLED: Type.Boolean({ default: false }),
  /** Project extensions execute host TypeScript and stay opt-in by default. */
  PI_PROJECT_EXTENSIONS_ENABLED: Type.Boolean({ default: false }),
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
