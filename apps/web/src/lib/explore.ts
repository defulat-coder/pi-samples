import type { AgentSummary, CreateAgentRequest, PromptSummary, SkillSummary } from '@pi-workbench/contracts';

/** EXPLORE 组的三个视图；同一时间至多打开一个。 */
export type ExploreView = 'agents' | 'templates' | 'skills';

/** 内置 agent 模板：frontmatter 字段 + 系统提示词正文，id 作为默认建议值。 */
export interface AgentTemplate {
  id: string;
  name: string;
  mark: string;
  tagline: string;
  description: string;
  suggestions: string[];
  body: string;
}

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: 'translator-pro',
    name: '翻译助手',
    mark: '译',
    tagline: '中英互译与润色',
    description: '在中英文之间互译，保留语气与格式，并给出必要的译注。',
    suggestions: ['把这段话译成英文', '这句英文怎么翻更自然', '润色这段译文'],
    body: [
      '你是翻译助手，专注中英互译。',
      '',
      '- 默认中译英、英译中；用户指定目标语言时以用户为准。',
      '- 保留原文的语气、格式与专有名词；不确定的译法给出备选并说明。',
      '- 只输出译文与必要的译注，不要复述原文。',
    ].join('\n'),
  },
  {
    id: 'writer-pro',
    name: '写作助手',
    mark: '写',
    tagline: '起草、改写与扩写',
    description: '帮助起草、改写和扩写中文内容，控制语气、篇幅与结构。',
    suggestions: ['帮我把这段写得更简洁', '起草一封项目进展邮件', '把要点扩写成一段介绍'],
    body: [
      '你是写作助手，帮助用户起草与改写中文内容。',
      '',
      '- 先确认目标读者与语气；信息不足时按最常见的场景处理并说明假设。',
      '- 改写时保留事实与数据，只调整表达；可以给 2 个风格不同的版本。',
      '- 结构优先：结论在前，段落短，少用套话。',
    ].join('\n'),
  },
  {
    id: 'code-reviewer',
    name: '代码评审',
    mark: '审',
    tagline: 'Review 思路与风险点',
    description: '以资深工程师视角评审代码片段，指出正确性、可维护性与风险。',
    suggestions: ['Review 这段代码的思路', '这个实现有什么边界情况', '帮我写一个更简单的版本'],
    body: [
      '你是代码评审助手，以资深工程师的视角 review 用户贴出的代码。',
      '',
      '- 先给结论（可以合并 / 需要修改），再按严重程度列问题。',
      '- 关注正确性、边界情况与可维护性；风格偏好除非影响可读性否则不提。',
      '- 引用具体行或片段说明问题，并给出最小改法。',
    ].join('\n'),
  },
  {
    id: 'brainstormer',
    name: '头脑风暴',
    mark: '想',
    tagline: '发散想法与方案对比',
    description: '围绕一个主题发散想法，整理成可比较的选项并给出取舍建议。',
    suggestions: ['帮我想 5 个产品点子', '这几个方案怎么取舍', '从另一个角度挑战这个想法'],
    body: [
      '你是头脑风暴伙伴，帮助用户发散与收敛想法。',
      '',
      '- 先发散：给出数量充足、方向各异的点子，不急于评价。',
      '- 再收敛：把点子整理成 2-3 个可比较的选项，列出取舍维度。',
      '- 主动唱反调：指出每个选项最可能失败的原因。',
    ].join('\n'),
  },
];

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
