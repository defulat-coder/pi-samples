import type { AgentSummary, AgentTemplate, CreateAgentRequest, PromptSummary, SkillSummary } from '@pi-workbench/contracts';

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

/** Skills 页的统一条目：prompt 模板与 skill 资源共用卡片结构。 */
export type SkillItem = {
  kind: 'prompt' | 'skill';
  name: string;
  path: string;
  description?: string;
  preview?: string;
};

export function mergeSkillItems(prompts: PromptSummary[], skills: SkillSummary[]): SkillItem[] {
  const promptItems: SkillItem[] = prompts.map((prompt) => ({
    kind: 'prompt',
    name: prompt.name,
    path: prompt.path,
    ...(prompt.description ? { description: prompt.description } : {}),
    ...(prompt.preview ? { preview: prompt.preview } : {}),
  }));
  const skillItems: SkillItem[] = skills.map((skill) => ({
    kind: 'skill',
    name: skill.name,
    path: skill.path,
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.preview ? { preview: skill.preview } : {}),
  }));
  return [...skillItems, ...promptItems];
}

/** 按名称 / 描述 / 路径过滤技能条目，大小写不敏感。 */
export function filterSkillItems(items: SkillItem[], query: string): SkillItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => [item.name, item.description, item.path].some((field) => field?.toLowerCase().includes(q)));
}
