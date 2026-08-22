import { Type } from '@sinclair/typebox';
import { AGENT_ID_PATTERN, AGENT_THINKING_LEVELS, type AgentThinkingLevel } from '@pi-workbench/contracts';
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

export const PreferenceKeySchema = Type.String({ pattern: '^(ui\\.[a-z-]{1,40}|thinking\\.[a-z][a-z0-9-]{1,63})$' });
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
export const PromptNameSchema = Type.Object({ name: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }) });
