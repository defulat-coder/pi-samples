import type { FastifyInstance } from 'fastify';
import { basename, relative } from 'node:path';
import type { AgentTemplatesResponse, SkillListResponse } from '@pi-workbench/contracts';
import { AGENT_TEMPLATES, agentSummary, getPiModelConfig, getPiThinkingLevel, listAgentResources, listPrompts, listPiModels, listSkills, loadAgents, readPrompt } from '@pi-workbench/pi-agent';
import { PromptNameSchema } from '../schemas.js';
import type { AppContext } from '../context.js';

export function registerMetaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/workspace', async () => ({
    agents: await Promise.all(
      loadAgents(ctx.cwd).map(async (agent) => ({
        ...agentSummary(agent),
        sessionCount: (await ctx.sessions.listSessions(agent.id)).length,
      })),
    ),
    prompts: listPrompts(ctx.cwd),
    models: { current: getPiModelConfig({}, ctx.cwd), available: await listPiModels(ctx.cwd) },
  }));

  app.get('/skills', async (): Promise<SkillListResponse> => {
    const items = listSkills(ctx.cwd);
    return { items, total: items.length };
  });

  app.get('/templates', async (): Promise<AgentTemplatesResponse> => ({ items: [...AGENT_TEMPLATES] }));

  // Non-sensitive configuration only; provider keys never leave this process.
  app.get('/settings', async () => {
    const resources = listAgentResources(ctx.cwd);
    return {
      model: { ...getPiModelConfig({}, ctx.cwd), available: await listPiModels(ctx.cwd) },
      thinkingLevel: getPiThinkingLevel(undefined, ctx.cwd),
      resources: {
        agents: loadAgents(ctx.cwd).length,
        prompts: resources.prompts.length,
        skills: resources.skills.length,
        appendSystem: resources.appendSystem,
      },
      workspace: { name: basename(ctx.cwd), sessionDir: relative(ctx.cwd, ctx.sessions.sessionDir) },
    };
  });

  app.get<{ Params: { name: string } }>('/prompts/:name', {
    schema: { params: PromptNameSchema },
  }, async (request, reply) => {
    const document = readPrompt(ctx.cwd, request.params.name);
    if (!document) return reply.code(404).send({ error: '提示词不存在' });
    return document;
  });
}
