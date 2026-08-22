import { Type } from '@sinclair/typebox';
import { AGENT_ID_PATTERN, AGENT_THINKING_LEVELS, type AgentThinkingLevel, type ApprovalState } from '@pi-workbench/contracts';
import { AGENT_BODY_MAX_BYTES } from '@pi-workbench/pi-agent';

export const AgentIdSchema = Type.String({ pattern: AGENT_ID_PATTERN });
// Mirrors the Pi SDK session-id shape (UUIDs, slugs); rejects path-ish input up front.
export const SessionIdSchema = Type.String({ pattern: '^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$', maxLength: 120 });
export const ThinkingLevelSchema = Type.Unsafe<AgentThinkingLevel>({ enum: [...AGENT_THINKING_LEVELS] });

export const ChatRequestSchema = Type.Object({
  agentId: AgentIdSchema,
  sessionId: Type.Optional(SessionIdSchema),
  message: Type.String({ minLength: 1, maxLength: 4000 }),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  thinking: Type.Optional(ThinkingLevelSchema),
});

export const PreferenceKeySchema = Type.String({ pattern: '^(ui\\.[a-z-]{1,40}|thinking\\.[a-z][a-z0-9-]{1,63}|model\\.[a-z][a-z0-9-]{1,63})$' });
export const PreferenceUpdateSchema = Type.Object({ key: PreferenceKeySchema, value: Type.Unknown() });

// maxLength counts UTF-16 code units; createAgent re-checks the 32KB byte cap.
export const CreateAgentSchema = Type.Object({
  id: Type.Optional(AgentIdSchema),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  mark: Type.String({ minLength: 1, maxLength: 8 }),
  tagline: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.String({ minLength: 1, maxLength: 400 }),
  suggestions: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 8 }),
  body: Type.String({ minLength: 1, maxLength: AGENT_BODY_MAX_BYTES }),
});

export const UpdateAgentSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  mark: Type.Optional(Type.String({ minLength: 1, maxLength: 8 })),
  tagline: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
  suggestions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 8 })),
  body: Type.Optional(Type.String({ minLength: 1, maxLength: AGENT_BODY_MAX_BYTES })),
});

export const AgentParamsSchema = Type.Object({ agentId: AgentIdSchema });
export const SessionParamsSchema = Type.Object({ agentId: AgentIdSchema, sessionId: SessionIdSchema });
export const RenameSessionSchema = Type.Object({ title: Type.String({ minLength: 1, maxLength: 80 }) });

// GET /inbox 的 query：tab 默认 attention，q 对 title/preview 做大小写不敏感包含过滤。
export const InboxQuerySchema = Type.Object({
  tab: Type.Optional(Type.Union([Type.Literal('attention'), Type.Literal('completed'), Type.Literal('all')])),
  q: Type.Optional(Type.String({ maxLength: 200 })),
});
// 至少一个字段（minProperties），否则 400。
export const UpdateInboxStateSchema = Type.Object(
  { read: Type.Optional(Type.Boolean()), completed: Type.Optional(Type.Boolean()) },
  { minProperties: 1 },
);
export const PromptNameSchema = Type.Object({ name: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }) });

export const UpdatePromptSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 32000 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

// 空内容（trim 后）表示删除 .pi/APPEND_SYSTEM.md。
export const UpdateAppendSystemSchema = Type.Object({ content: Type.String({ maxLength: 16000 }) });

// 技能库：install/remove 的入参直接拼进 npx 参数数组（execFile，无 shell），pattern 再挡一层。
export const SkillSourceSchema = Type.String({ pattern: '^[a-z0-9_.-]+/[a-z0-9_.-]+$', maxLength: 200 });
export const SkillNameSchema = Type.String({ pattern: '^[a-z0-9_.-]+$', maxLength: 100 });
export const SkillInstallSchema = Type.Object({ source: SkillSourceSchema, skillId: SkillNameSchema });
export const SkillRemoveSchema = Type.Object({ name: SkillNameSchema });
// query ≥2 字符走 skills.sh 搜索，否则返回首页榜单；limit 封顶 100。
export const SkillLibraryQuerySchema = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
// 已安装技能内容：scope 限定两个目录，name 与 remove 同一 pattern（挡路径穿越）。
export const SkillContentQuerySchema = Type.Object({
  scope: Type.Union([Type.Literal('pi'), Type.Literal('agents')]),
  name: SkillNameSchema,
});
// skills.sh 详情：source/skillId 与 install 同一 pattern。
export const SkillDetailQuerySchema = Type.Object({ source: SkillSourceSchema, skillId: SkillNameSchema });

// 审批：id 来自扩展的 uuid，pattern 同时挡住路径穿越；state 过滤见 contracts ApprovalState。
export const ApprovalStateSchema = Type.Unsafe<ApprovalState>({
  enum: ['pending', 'approved', 'always', 'denied', 'denied_with_reason', 'expired'],
});
export const ApprovalQuerySchema = Type.Object({ state: Type.Optional(ApprovalStateSchema) });
export const ApprovalParamsSchema = Type.Object({ id: Type.String({ pattern: '^[A-Za-z0-9-]{1,64}$' }) });
export const ApprovalDecisionSchema = Type.Object({
  approved: Type.Boolean(),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  always: Type.Optional(Type.Boolean()),
});
