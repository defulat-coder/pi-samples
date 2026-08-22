import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register as registerTsx } from 'tsx/esm/api';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type InlineExtension,
} from '@earendil-works/pi-coding-agent';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

/**
 * Spike: pi-permission-system@0.8.0 在无 UI 的 SDK 宿主里的 HITL 文件转发链路。
 *
 * 该包只发布 TS 源码（exports["."] = ./index.ts），plain Node 拒绝对 node_modules
 * 里的 .ts 做 type stripping，且直接静态 import 会把整包源码拉进我们的 tsc 程序
 * （noUncheckedIndexedAccess 等严格设置下大量报错）。因此这里：
 *  1. tsc 层面完全不静态引用该包（tsImport 动态加载，返回 any）；
 *  2. 运行前把包复制到临时目录并修复一处 peer 版本错位（pi-ai 0.84 把
 *     getApiProvider 移到了 /compat 子路径，扩展仍从根导入，ESM 链接会炸）；
 *  3. 用 tsx 的 ESM loader hook（register()）加载复制出来的 TS 源码。
 */

const PARENT_SESSION_ID = 'workbench-spike';

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

/** 复制 pi-permission-system 到临时目录并修补 pi-ai 0.84 的 getApiProvider 导入。 */
function vendorPermissionSystem(targetDir: string): string {
  const require = createRequire(import.meta.url);
  const packageDir = realpathSync(dirname(require.resolve('pi-permission-system')));
  // 真实文件在 .pnpm 虚拟目录里，其兄弟 node_modules 已解析好全部依赖与 peer。
  cpSync(packageDir, targetDir, {
    recursive: true,
    filter: (source) => source !== join(packageDir, 'node_modules'),
  });
  symlinkSync(join(packageDir, '..'), join(targetDir, 'node_modules'), 'dir');

  const compatFile = join(targetDir, 'src', 'model-option-compatibility.ts');
  const source = readFileSync(compatFile, 'utf-8');
  // 仓库已用 pnpm patch（patches/pi-permission-system@0.8.0.patch）修复安装副本里的
  // 同一处导入；vendor 时两种状态都接受，最终必须指向 /compat 子路径。
  const patched = source.includes('} from "@earendil-works/pi-ai";')
    ? source.replace('} from "@earendil-works/pi-ai";', '} from "@earendil-works/pi-ai/compat";')
    : source;
  assert.ok(patched.includes('} from "@earendil-works/pi-ai/compat";'), 'vendor 副本的 getApiProvider 导入必须指向 /compat');
  writeFileSync(compatFile, patched);
  return join(targetDir, 'index.ts');
}

function forwardingDir(kind: 'requests' | 'responses'): string {
  return join(agentHome, 'sessions', 'permission-forwarding', 'sessions', PARENT_SESSION_ID, kind);
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时: ${description}`);
}

/** 等待下一个审批请求文件出现并回写响应；nonce 照抄，responderSessionId 必须等于 targetSessionId。 */
async function respondToNextRequest(decision: { approved: boolean; state: string; denialReason?: string }): Promise<Record<string, unknown>> {
  await waitFor(
    () => existsSync(forwardingDir('requests')) && readdirSync(forwardingDir('requests')).some((name) => name.endsWith('.json')),
    '审批请求文件出现',
  );
  const requestFile = readdirSync(forwardingDir('requests')).find((name) => name.endsWith('.json'));
  assert.ok(requestFile);
  const request = JSON.parse(readFileSync(join(forwardingDir('requests'), requestFile), 'utf-8')) as Record<string, unknown>;

  mkdirSync(forwardingDir('responses'), { recursive: true });
  writeFileSync(
    join(forwardingDir('responses'), requestFile),
    JSON.stringify({
      requestId: request.id,
      responseNonce: request.responseNonce,
      approved: decision.approved,
      state: decision.state,
      ...(decision.denialReason ? { denialReason: decision.denialReason } : {}),
      responderSessionId: PARENT_SESSION_ID,
      respondedAt: Date.now(),
    }),
  );
  return request;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pi-permission-spike-'));
  agentHome = join(root, 'agent-home');
  projectCwd = join(root, 'project');
  mkdirSync(join(projectCwd, '.pi', 'agent'), { recursive: true });

  // 策略：bash 一律 ask，其余工具默认 deny。global 配置随 PI_CODING_AGENT_DIR 隔离到临时目录。
  writeFileSync(
    join(projectCwd, '.pi', 'agent', 'pi-permissions.jsonc'),
    `{
  // spike policy
  "bash": { "*": "ask" },
  "defaultPolicy": { "tools": "deny", "bash": "ask", "mcp": "deny", "skills": "deny" },
}
`,
  );

  // 扩展在模块顶层捕获 getAgentDir()，必须在动态 import 之前设置。
  setEnv('PI_CODING_AGENT_DIR', agentHome);
  setEnv('PI_IS_SUBAGENT', '1');
  setEnv('PI_AGENT_ROUTER_PARENT_SESSION_ID', PARENT_SESSION_ID);

  // AgentSession.prompt() 有 auth 前置检查；给 faux provider 一个占位 apiKey 即可通过，
  // 实际流式调用由 session.agent.streamFunction 覆写接管，不会触网。
  mkdirSync(agentHome, { recursive: true });
  writeFileSync(
    join(agentHome, 'models.json'),
    JSON.stringify({ providers: { faux: { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'faux', models: [{ id: 'faux-1' }] } } }),
  );

  const entry = vendorPermissionSystem(join(root, 'vendor', 'pi-permission-system'));
  registerTsx();
  const loaded: { default: unknown } = await import(pathToFileURL(entry).href);
  assert.equal(typeof loaded.default, 'function', 'pi-permission-system 默认导出必须是扩展工厂函数');

  const resourceLoader = new DefaultResourceLoader({
    cwd: projectCwd,
    agentDir: agentHome,
    extensionFactories: [loaded.default as InlineExtension],
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
    tools: ['bash'],
  });
  session = created.session;
  // createAgentSession 不代发 session_start（CLI 模式内部才调 bindExtensions）；
  // 缺了它 pi-permission-system 不会用 ctx.cwd 重建 PermissionManager，项目策略不加载。
  await session.bindExtensions({});
  // 绕过真实 provider：主循环的 streamFn 直接走 faux 脚本。
  session.agent.streamFunction = faux.streamSimple;
});

after(() => {
  session?.dispose();
  restoreEnv();
  rmSync(root, { recursive: true, force: true });
});

describe('pi-permission-system spike（无 UI 宿主 + subagent 文件转发）', () => {
  it('批准路径：bash 命中 ask → 写请求文件 → 宿主写响应 → 工具执行、turn 完成', { timeout: 60_000 }, async () => {
    assert.ok(session);
    const markerPath = join(projectCwd, 'marker.txt');
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: `printf spike-ran > "${markerPath}"` }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('spike done'),
    ]);

    let answer = '';
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        answer += event.assistantMessageEvent.delta;
      }
    });

    try {
      const turn = session.prompt('请运行 spike 命令');
      const request = await respondToNextRequest({ approved: true, state: 'approved' });

      // 请求文件字段齐全性断言。
      assert.equal(typeof request.id, 'string');
      assert.equal(typeof request.responseNonce, 'string');
      assert.equal(typeof request.createdAt, 'number');
      assert.equal(typeof request.requesterSessionId, 'string');
      assert.equal(request.targetSessionId, PARENT_SESSION_ID);
      assert.equal(typeof request.requesterAgentName, 'string');
      assert.match(request.message as string, /printf spike-ran/);

      await turn;
      assert.ok(existsSync(markerPath), '审批通过后 bash 工具应真正执行');
      assert.equal(readFileSync(markerPath, 'utf-8'), 'spike-ran');
      assert.match(answer, /spike done/);
    } finally {
      unsubscribe();
    }
  });

  it('始终允许：同一命令第二次执行不再产生审批请求', { timeout: 60_000 }, async () => {
    assert.ok(session);
    const alwaysMarker = join(projectCwd, 'always-marker.txt');
    const command = `printf always-run > "${alwaysMarker}"`;

    const runTurn = async () => {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('always turn done'),
      ]);
      await session!.prompt('运行 always 命令');
    };

    // 第一次：命中 ask，响应 always。
    const firstTurn = runTurn();
    await respondToNextRequest({ approved: true, state: 'always' });
    await firstTurn;
    assert.ok(existsSync(alwaysMarker), '第一次批准后命令应执行');

    // 第二次：同一命令应直接命中会话级 allow 规则，不再写请求文件。
    rmSync(alwaysMarker, { force: true });
    const secondTurn = runTurn();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const leftoverRequests = existsSync(forwardingDir('requests'))
      ? readdirSync(forwardingDir('requests')).filter((name) => name.endsWith('.json'))
      : [];
    await secondTurn;
    assert.deepEqual(leftoverRequests, [], '始终允许后同一命令不应再次请求审批');
    assert.ok(existsSync(alwaysMarker), '第二次命令应无审批直接执行');
  });

  it('拒绝路径：approved=false 时工具被阻断，turn 正常收尾', { timeout: 60_000 }, async () => {
    assert.ok(session);
    const deniedMarker = join(projectCwd, 'denied-marker.txt');
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: `printf denied-run > "${deniedMarker}"` }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('denial handled'),
    ]);

    let answer = '';
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        answer += event.assistantMessageEvent.delta;
      }
    });

    try {
      const turn = session.prompt('再跑一次');
      await respondToNextRequest({ approved: false, state: 'denied', denialReason: 'spike 拒绝' });
      await turn;
      assert.ok(!existsSync(deniedMarker), '被拒绝的 bash 命令不得执行');
      assert.match(answer, /denial handled/);
    } finally {
      unsubscribe();
    }
  });
});
