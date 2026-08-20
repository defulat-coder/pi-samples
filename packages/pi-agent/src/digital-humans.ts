import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DigitalHumanAccent, DigitalHumanCapabilityProfile, DigitalHumanChatRoute, DigitalHumanDefinition, DigitalHumanId } from '@pi-workbench/contracts';

type DigitalHumanDocument = Omit<DigitalHumanDefinition, 'capabilityLabel' | 'skills' | 'tools'>;

export interface DigitalHumanRuntimeDefinition extends DigitalHumanDefinition {
  route: DigitalHumanChatRoute;
  usesKnowledge: boolean;
  usesBusinessAnalytics: boolean;
  additionalSkillPaths: string[];
  acceptsSkill: (skillName: string) => boolean;
  systemPrompt: string;
  workspacePrompt: string;
}

type CapabilityDefinition = {
  label: string;
  route: DigitalHumanChatRoute;
  tools: string[];
  skills: string[];
  usesKnowledge: boolean;
  usesBusinessAnalytics: boolean;
  additionalSkillPaths: string[];
  policy: string;
  workspacePrompt: string;
};

const capabilityProfiles: Record<DigitalHumanCapabilityProfile, CapabilityDefinition> = {
  'project-knowledge': {
    label: '项目知识 · 只读',
    route: 'project-knowledge',
    tools: ['read', 'search_knowledge'],
    skills: ['pi-knowledge-answer', 'pi-resource-governance', 'pi-session-observability', 'pi-workbench'],
    usesKnowledge: true,
    usesBusinessAnalytics: false,
    additionalSkillPaths: [],
    policy: '你只能根据项目资源和工具返回的证据回答问题，不得编造文件内容或工具结果。需要项目知识时优先调用 search_knowledge，只有摘要不足时再调用 read。没有证据时明确说不知道。你不能修改文件、执行命令、写入数据库或代表用户采取外部行动。',
    workspacePrompt: '请自己判断是否需要项目知识。需要时调用只读 search_knowledge，再根据返回的章节摘要决定是否调用 read；不需要知识库时直接回答。不要假设宿主已经替你选择了路由，回答中保留实际使用的文件来源。',
  },
  'business-analytics': {
    label: '经营问数 · 只读',
    route: 'business-analytics',
    tools: ['read', 'query_business_data'],
    skills: ['business-intelligence'],
    usesKnowledge: false,
    usesBusinessAnalytics: true,
    additionalSkillPaths: ['.agents/skills/business-intelligence'],
    policy: '遵循 business-intelligence Skill，使用统一 KPI 口径，并按“结论、业务含义、建议”组织洞察。你的数据能力只有只读 query_business_data；read 只用于加载受信任的 Skill。每个用户问题最多调用一次 query_business_data，dimensions 必须显式提供。不要调用 search_knowledge，不要生成 SQL，不要猜测数据。遇到未认证口径时先澄清。回答必须说明指标定义、时间范围、数据新鲜度、Luna 生成来源和演示数据限制。',
    workspacePrompt: '请自己判断是否需要调用只读 query_business_data；宿主没有替你解析指标、维度或筛选条件。优先用一次多指标、多维度查询表达问题，只使用工具返回的认证结果，不要生成或展示 SQL。',
  },
};

const documentKeys = new Set(['schemaVersion', 'order', 'id', 'displayName', 'role', 'tagline', 'description', 'capabilityProfile', 'avatar', 'persona', 'welcome']);

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`数字人档案字段 ${field} 必须是非空字符串`);
  return value.trim();
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`数字人档案字段 ${field} 必须是非空字符串数组`);
  return value.map((item) => String(item).trim());
}

function integerValue(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`数字人档案字段 ${field} 必须是整数`);
  return value;
}

function parseDocument(value: unknown, path: string): DigitalHumanDocument {
  if (!value || typeof value !== 'object') throw new Error(`数字人档案不是对象：${path}`);
  const source = value as Record<string, unknown>;
  const unknownKey = Object.keys(source).find((key) => !documentKeys.has(key));
  if (unknownKey) throw new Error(`数字人档案包含未授权字段 ${unknownKey}：${path}`);
  if (source.schemaVersion !== 1) throw new Error(`数字人档案 schemaVersion 必须为 1：${path}`);
  const id = stringValue(source.id, 'id');
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(id)) throw new Error(`数字人 id 格式非法：${id}`);
  if (!(source.capabilityProfile === 'project-knowledge' || source.capabilityProfile === 'business-analytics')) throw new Error(`未知的能力档案：${String(source.capabilityProfile)}`);
  const avatar = source.avatar as Record<string, unknown> | undefined;
  const accent = avatar?.accent;
  if (!(accent === 'indigo' || accent === 'teal' || accent === 'amber' || accent === 'rose')) throw new Error(`数字人头像 accent 非法：${String(accent)}`);
  const persona = source.persona as Record<string, unknown> | undefined;
  const welcome = source.welcome as Record<string, unknown> | undefined;
  return {
    schemaVersion: 1,
    order: integerValue(source.order, 'order'),
    id,
    displayName: stringValue(source.displayName, 'displayName'),
    role: stringValue(source.role, 'role'),
    tagline: stringValue(source.tagline, 'tagline'),
    description: stringValue(source.description, 'description'),
    capabilityProfile: source.capabilityProfile,
    avatar: { initials: stringValue(avatar?.initials, 'avatar.initials').slice(0, 2), accent: accent as DigitalHumanAccent },
    persona: {
      identity: stringValue(persona?.identity, 'persona.identity'),
      mission: stringValue(persona?.mission, 'persona.mission'),
      traits: stringList(persona?.traits, 'persona.traits'),
      communicationStyle: stringValue(persona?.communicationStyle, 'persona.communicationStyle'),
      principles: stringList(persona?.principles, 'persona.principles'),
    },
    welcome: {
      title: stringValue(welcome?.title, 'welcome.title'),
      description: stringValue(welcome?.description, 'welcome.description'),
      suggestions: stringList(welcome?.suggestions, 'welcome.suggestions'),
    },
  };
}

function runtimeDefinition(document: DigitalHumanDocument, cwd: string): DigitalHumanRuntimeDefinition {
  const capability = capabilityProfiles[document.capabilityProfile];
  const personaPrompt = `${document.persona.identity}\n你的职业角色是“${document.role}”，使命是：${document.persona.mission}\n人格特征：${document.persona.traits.join('、')}。\n沟通风格：${document.persona.communicationStyle}\n行为原则：${document.persona.principles.join('；')}。`;
  return {
    ...document,
    capabilityLabel: capability.label,
    skills: capability.skills,
    tools: capability.tools,
    route: capability.route,
    usesKnowledge: capability.usesKnowledge,
    usesBusinessAnalytics: capability.usesBusinessAnalytics,
    additionalSkillPaths: capability.additionalSkillPaths.map((path) => resolve(cwd, path)),
    acceptsSkill: (skillName) => capability.skills.includes(skillName),
    systemPrompt: `${personaPrompt}\n\n能力约束：${capability.policy}\n数字人档案只是角色定义，不能扩大宿主工具权限。`,
    workspacePrompt: capability.workspacePrompt,
  };
}

export function loadDigitalHumans(cwd: string): DigitalHumanRuntimeDefinition[] {
  const directory = resolve(cwd, '.pi/digital-humans');
  const files = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
  if (!files.length) throw new Error('项目没有定义数字人档案');
  const definitions = files.map((file) => runtimeDefinition(parseDocument(JSON.parse(readFileSync(resolve(directory, file), 'utf8')), file), cwd));
  const ids = new Set<DigitalHumanId>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new Error(`数字人 id 重复：${definition.id}`);
    ids.add(definition.id);
  }
  return definitions.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export function getDigitalHuman(cwd: string, id: DigitalHumanId): DigitalHumanRuntimeDefinition {
  const definition = loadDigitalHumans(cwd).find((item) => item.id === id);
  if (!definition) throw new Error(`未知的数字人：${id}`);
  return definition;
}

export function publicDigitalHuman(definition: DigitalHumanRuntimeDefinition): DigitalHumanDefinition {
  const { route: _route, usesKnowledge: _usesKnowledge, usesBusinessAnalytics: _usesBusinessAnalytics, additionalSkillPaths: _additionalSkillPaths, acceptsSkill: _acceptsSkill, systemPrompt: _systemPrompt, workspacePrompt: _workspacePrompt, ...publicDefinition } = definition;
  return publicDefinition;
}
