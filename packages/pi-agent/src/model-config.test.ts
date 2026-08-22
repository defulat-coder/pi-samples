import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPiModelConfig, getPiThinkingLevel } from './model-config.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureCwd(settings: Record<string, unknown>): { cwd: string; file: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-settings-'));
  roots.push(cwd);
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  const file = join(cwd, '.pi', 'settings.json');
  writeFileSync(file, JSON.stringify(settings));
  return { cwd, file };
}

describe('settings.json mtime 缓存', () => {
  it('mtime 不变时复用缓存，文件改写（mtime 变化）后配置随之更新', () => {
    const { cwd, file } = fixtureCwd({ defaultProvider: 'kimi-coding', defaultModel: 'k3', defaultThinkingLevel: 'low' });
    assert.equal(getPiModelConfig({}, cwd).model, 'k3');
    assert.equal(getPiThinkingLevel(undefined, cwd), 'low');

    // 改写配置并显式拨动 mtime，避免同毫秒写入被旧缓存命中。
    writeFileSync(file, JSON.stringify({ defaultProvider: 'kimi-coding', defaultModel: 'k3-256k', defaultThinkingLevel: 'high' }));
    const bumped = new Date(Date.now() + 5000);
    utimesSync(file, bumped, bumped);

    assert.equal(getPiModelConfig({}, cwd).model, 'k3-256k', 'mtime 变化后必须重读 settings.json');
    assert.equal(getPiThinkingLevel(undefined, cwd), 'high');
  });

  it('不同 cwd 的 settings.json 分别缓存、互不污染', () => {
    const alpha = fixtureCwd({ defaultModel: 'k3' });
    const beta = fixtureCwd({ defaultModel: 'kimi-for-coding-highspeed' });
    assert.equal(getPiModelConfig({}, alpha.cwd).model, 'k3');
    assert.equal(getPiModelConfig({}, beta.cwd).model, 'kimi-for-coding-highspeed');

    writeFileSync(alpha.file, JSON.stringify({ defaultModel: 'k3-256k' }));
    const bumped = new Date(Date.now() + 5000);
    utimesSync(alpha.file, bumped, bumped);

    assert.equal(getPiModelConfig({}, alpha.cwd).model, 'k3-256k');
    assert.equal(getPiModelConfig({}, beta.cwd).model, 'kimi-for-coding-highspeed', 'beta 的缓存不受 alpha 改写影响');
  });
});
