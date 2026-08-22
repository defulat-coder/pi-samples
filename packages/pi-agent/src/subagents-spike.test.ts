import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { loadPermissionExtension } from './permissions.js';
import { loadSubagentsExtension } from './subagents.js';

/**
 * Spike: pi-subagents@0.54.0 在无 UI 的 SDK 宿主里的 subagent 委派链路。
 *
 * 与 permission-spike 同套路（faux provider + 临时目录 + env 隔离），扩展走生产
 * 加载层（loadSubagentsExtension 经 jiti 加载真实安装路径 / loadPermissionExtension
 * 走 dist 预编译产物）。
 * 验证点：
 *  1. 两个扩展共存于 extensionFactories，headless 下 subagent 工具注册启用；
 *  2. 管理 action=list 返回内建 agents（jiti 从真实包路径加载，内建 agents/ 天然可解析）
 *     与项目级 .pi/agents/*.md；
 *  3. 真实委派 { agent, task }：子会话进程内执行；权限扩展的 tools allowlist 必须
 *     显式放行 subagent（否则 defaultPolicy deny 会静默阻断委派）。
 */

let root: string;
let agentHome: string;
let projectCwd: string;
let faux: ReturnType<typeof createFauxCore>;
let session: AgentSession | undefined;

const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pi-subagents-spike-'));
  agentHome = join(root, 'agent-home');
  projectCwd = join(root, 'project');
  mkdirSync(join(projectCwd, '.pi', 'agent'), { recursive: true });
  mkdirSync(join(projectCwd, '.pi', 'agents'), { recursive: true });

  // subagent 工具本身必须放行（委派只是编排，子会话内的 bash 等仍按各自策略审批）。
  writeFileSync(
    join(projectCwd, '.pi', 'agent', 'pi-permissions.jsonc'),
    `{
  "tools": { "read": "allow", "grep": "allow", "find": "allow", "ls": "allow", "subagent": "allow" },
  "bash": { "*": "ask" },
  "defaultPolicy": { "tools": "deny", "bash": "ask", "mcp": "deny", "skills": "deny" },
}
`,
  );
  // 项目级 agent：验证 pi-subagents 能发现 .pi/agents/*.md。
  writeFileSync(
    join(projectCwd, '.pi', 'agents', 'spike-helper.md'),
    `---
name: "spike-helper"
description: "spike 测试用子代理"
---

你是 spike 测试子代理，直接回答任务即可。
`,
  );

  setEnv('PI_CODING_AGENT_DIR', agentHome);
  setEnv('PI_IS_SUBAGENT', '1');
  setEnv('PI_AGENT_ROUTER_PARENT_SESSION_ID', 'workbench');

  mkdirSync(agentHome, { recursive: true });
  writeFileSync(
    join(agentHome, 'models.json'),
    JSON.stringify({ providers: { faux: { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'faux', models: [{ id: 'faux-1' }] } } }),
  );

  const subagentsExtension = await loadSubagentsExtension();
  const permissionExtension = await loadPermissionExtension(projectCwd);

  const resourceLoader = new DefaultResourceLoader({
    cwd: projectCwd,
    agentDir: agentHome,
    extensionFactories: [subagentsExtension, permissionExtension],
    noThemes: true,
  });
  await resourceLoader.reload();

  faux = createFauxCore({ provider: 'faux' });
  const modelRuntime = await ModelRuntime.create({});

  const created = await createAgentSession({
    cwd: projectCwd,
    sessionManager: SessionManager.inMemory(projectCwd),
    modelRuntime,
    resourceLoader,
    model: faux.getModel(),
    // tools allowlist 语义是「只启用列出的名字」，扩展注册的 subagent 也要显式列出。
    tools: ['read', 'grep', 'find', 'ls', 'bash', 'subagent'],
  });
  session = created.session;
  // createAgentSession 不代发 session_start；bindExtensions 后权限扩展才会加载
  // 项目策略（.pi/agent/pi-permissions.jsonc 里的 subagent/bash 规则）。
  await session.bindExtensions({});
  session.agent.streamFunction = faux.streamSimple;
});

after(() => {
  session?.dispose();
  restoreEnv();
  rmSync(root, { recursive: true, force: true });
});

describe('pi-subagents spike（无 UI 宿主，进程内委派）', () => {
  it('subagent 工具在 headless 会话中注册并启用', () => {
    assert.ok(session);
    const active = session.getActiveToolNames();
    assert.ok(active.includes('subagent'), `subagent 应在活动工具列表中，实际：${active.join(',')}`);
  });

  it('管理 action=list 返回内建与项目级 agent 清单', { timeout: 60_000 }, async () => {
    assert.ok(session);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('subagent', { action: 'list' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('list done'),
    ]);

    let toolResult: unknown;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'tool_execution_end' && event.toolName === 'subagent') toolResult = event.result;
    });
    try {
      await session.prompt('列出可用子代理');
    } finally {
      unsubscribe();
    }
    const text = JSON.stringify(toolResult);
    assert.ok(text.includes('reviewer'), `list 应包含内建 reviewer agent：${text.slice(0, 400)}`);
    assert.ok(text.includes('spike-helper'), `list 应包含项目级 spike-helper：${text.slice(0, 400)}`);
  });

  it('真实委派：子会话进程内执行并返回终态结果（faux 不可达时应干净失败而非挂起）', { timeout: 120_000 }, async () => {
    assert.ok(session);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('subagent', { agent: 'spike-helper', task: '回答 1+1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('delegation done'),
    ]);

    let toolResult: { content?: { text?: string }[]; isError?: boolean } | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'tool_execution_end' && event.toolName === 'subagent') {
        toolResult = event.result as typeof toolResult;
      }
    });
    try {
      await session.prompt('把任务委派给 spike-helper');
    } finally {
      unsubscribe();
    }
    assert.ok(toolResult, '委派调用必须产生终态结果（不得挂起）');
    const text = toolResult.content?.[0]?.text ?? '';
    // faux provider 对子会话不可达（baseUrl 127.0.0.1:9），期望干净失败；若 fork 复用了
    // 父会话 stream 则可能成功——两种终态都可接受，挂起不可接受。
    assert.ok(text.length > 0, '终态结果应有文本说明');
  });
});
