import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiAgentSession, getPiModelConfig, getPiProjectRoot, listPiModels } from './index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureCwd(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-'));
  roots.push(root);
  mkdirSync(join(root, '.pi', 'agents'), { recursive: true });
  for (const id of ['agent-one', 'agent-two']) {
    writeFileSync(join(root, '.pi', 'agents', `${id}.md`), `---\nname: ${id}\nmark: ${id[0]}\ntagline: 测试\ndescription: 测试 agent。\nsuggestions:\n  - 你好\n---\n\n你是 ${id}。\n`);
  }
  return root;
}

describe('pi agent runtime', () => {
  it('resolves the kimi-coding default model config', () => {
    const config = getPiModelConfig({}, getPiProjectRoot());
    assert.equal(config.provider, 'kimi-coding');
    assert.ok(config.model);
  });

  it('lists the static kimi-coding model catalog', async () => {
    const models = await listPiModels();
    const ids = models.map((model) => model.id);
    assert.ok(ids.includes('kimi-for-coding'));
    assert.ok(ids.includes('kimi-for-coding-highspeed'));
    assert.ok(ids.includes('k3'));
    assert.ok(ids.includes('k3-256k'));
  });

  it('creates a pure-chat session without any tools', async () => {
    const runtime = await createPiAgentSession({ cwd: fixtureCwd(), agentId: 'agent-one', persistSession: false });
    try {
      assert.equal(runtime.agentId, 'agent-one');
      assert.deepEqual(runtime.session.getActiveToolNames(), []);
      assert.match(runtime.session.systemPrompt, /你是 agent-one。/);
    } finally {
      runtime.close();
    }
  });

  it('refuses to open another agent session through the direct runtime interface', async () => {
    const cwd = fixtureCwd();
    const sessionDir = join(cwd, '.pi', 'sessions');
    const first = await createPiAgentSession({ cwd, agentId: 'agent-one', sessionId: 'owned-session', sessionDir });
    first.close();
    await assert.rejects(() => createPiAgentSession({ cwd, agentId: 'agent-two', sessionId: 'owned-session', sessionDir }), /AGENT_SESSION_MISMATCH/);
  });

  it('throws explicitly when the configured model is not in the catalog', async () => {
    await assert.rejects(() => createPiAgentSession({ cwd: fixtureCwd(), agentId: 'agent-one', persistSession: false, model: 'no-such-model' }), /Pi model not found/);
  });
});
