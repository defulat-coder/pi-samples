import type { FastifyInstance } from 'fastify';
import type { UsageResponse } from '@pi-workbench/contracts';
import { loadAgents, summarizeTokenUsage, summarizeUsage } from '@pi-workbench/pi-agent';
import type { AppContext } from '../context.js';

export function registerUsageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/usage', async (): Promise<UsageResponse> => {
    const base = summarizeUsage(await ctx.sessions.listSessions(), loadAgents(ctx.cwd));
    const tokenSummary = summarizeTokenUsage(ctx.db);
    return {
      ...base,
      tokens: { input: tokenSummary.totalInput, output: tokenSummary.totalOutput, total: tokenSummary.totalTokens },
      perAgent: base.perAgent.map((row) => {
        const tokens = tokenSummary.perAgent.find((item) => item.agentId === row.agentId);
        return { ...row, tokens: tokens ? { input: tokens.input, output: tokens.output, total: tokens.total } : { input: 0, output: 0, total: 0 } };
      }),
    };
  });
}
