import type { FastifyInstance } from 'fastify';
import type { CreateAgentRequest, UpdateAgentRequest } from '@pi-workbench/contracts';
import { AgentCreateError, createAgent, listAgentResources, updateAgent } from '@pi-workbench/pi-agent';
import { AgentParamsSchema, CreateAgentSchema, UpdateAgentSchema } from '../schemas.js';
import { agentOr404, type AppContext } from '../context.js';

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: CreateAgentRequest }>('/agents', { schema: { body: CreateAgentSchema } }, async (request, reply) => {
    try {
      const agent = createAgent(ctx.cwd, request.body);
      return reply.code(201).send(agent);
    } catch (error) {
      if (error instanceof AgentCreateError) {
        return reply.code(error.code === 'CONFLICT' ? 409 : 400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.patch<{ Params: { agentId: string }; Body: UpdateAgentRequest }>(
    '/agents/:agentId',
    { schema: { params: AgentParamsSchema, body: UpdateAgentSchema } },
    async (request, reply) => {
      try {
        return updateAgent(ctx.cwd, request.params.agentId, request.body);
      } catch (error) {
        if (error instanceof AgentCreateError) {
          return reply.code(error.code === 'NOT_FOUND' ? 404 : 400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { agentId: string } }>('/agents/:agentId', { schema: { params: AgentParamsSchema } }, async (request, reply) => {
    const agent = agentOr404(ctx, request.params.agentId, reply);
    if (!agent) return;
    return agent;
  });

  app.get<{ Params: { agentId: string } }>('/agents/:agentId/resources', { schema: { params: AgentParamsSchema } }, async (request, reply) => {
    if (!agentOr404(ctx, request.params.agentId, reply)) return;
    const sessionsForAgent = await ctx.sessions.listSessions(request.params.agentId);
    return {
      ...listAgentResources(ctx.cwd),
      stats: {
        sessionCount: sessionsForAgent.length,
        questionCount: sessionsForAgent.reduce((sum, session) => sum + session.questionCount, 0),
      },
    };
  });
}
