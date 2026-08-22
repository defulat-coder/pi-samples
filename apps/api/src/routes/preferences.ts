import type { FastifyInstance } from 'fastify';
import type { PreferencesResponse, PreferenceUpdateRequest } from '@pi-workbench/contracts';
import { deletePreference, getPreferences, listPiModels, setPreference } from '@pi-workbench/pi-agent';
import { PreferenceUpdateSchema } from '../schemas.js';
import type { AppContext } from '../context.js';

// UI 偏好（ui.* / thinking.<agentId> / model.<agentId>）持久化在 SQLite；浏览器仍以 localStorage 做即时缓存。
export function registerPreferenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/preferences', async (): Promise<PreferencesResponse> => ({ items: getPreferences(ctx.db) }));

  app.put<{ Body: PreferenceUpdateRequest }>('/preferences', { schema: { body: PreferenceUpdateSchema } }, async (request, reply) => {
    const { key, value } = request.body;
    // model.<agentId> 的 value 必须在模型目录内；空串表示「跟随全局默认」，直接删除该偏好。
    if (key.startsWith('model.')) {
      if (value === '') {
        deletePreference(ctx.db, key);
        return { items: getPreferences(ctx.db) };
      }
      const available = await listPiModels(ctx.cwd);
      if (typeof value !== 'string' || !available.some((model) => model.id === value)) {
        return reply.code(400).send({ error: `模型不在可用列表内：${String(value)}` });
      }
    }
    setPreference(ctx.db, key, value);
    return { items: getPreferences(ctx.db) };
  });
}
