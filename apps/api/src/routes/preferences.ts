import type { FastifyInstance } from 'fastify';
import type { PreferencesResponse, PreferenceUpdateRequest } from '@pi-workbench/contracts';
import { getPreferences, setPreference } from '@pi-workbench/pi-agent';
import { PreferenceUpdateSchema } from '../schemas.js';
import type { AppContext } from '../context.js';

// UI 偏好（ui.* / thinking.<agentId>）持久化在 SQLite；浏览器仍以 localStorage 做即时缓存。
export function registerPreferenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/preferences', async (): Promise<PreferencesResponse> => ({ items: getPreferences(ctx.db) }));

  app.put<{ Body: PreferenceUpdateRequest }>('/preferences', { schema: { body: PreferenceUpdateSchema } }, async (request): Promise<PreferencesResponse> => {
    setPreference(ctx.db, request.body.key, request.body.value);
    return { items: getPreferences(ctx.db) };
  });
}
