import type { AgentSummary, AgentTemplate, CreateAgentRequest } from '@pi-workbench/contracts';

/** EXPLORE 组的三个视图；同一时间至多打开一个。 */
export type ExploreView = 'agents' | 'templates' | 'skills';

/** 内置 agent 模板常量由后端 GET /api/v1/templates 提供；这里只保留组装逻辑。 */
export type { AgentTemplate };

/** 用模板字段组装创建请求；id 可被用户覆盖。 */
export function templateToCreateRequest(template: AgentTemplate, id?: string): CreateAgentRequest {
  return {
    id: (id ?? template.id).trim(),
    name: template.name,
    mark: template.mark,
    tagline: template.tagline,
    description: template.description,
    suggestions: [...template.suggestions],
    body: template.body,
  };
}

/** 创建工作区 Agent 卡片上的统计数字：建议问题数 + 会话数（缺省按 0）。 */
export function agentCardStats(agent: AgentSummary): { suggestionCount: number; sessionCount: number } {
  return { suggestionCount: agent.suggestions.length, sessionCount: agent.sessionCount ?? 0 };
}

/** 技能库卡片的紧凑安装量：3100000 → "3.1M"，653000 → "653K"。 */
export function formatInstallCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(count);
}
