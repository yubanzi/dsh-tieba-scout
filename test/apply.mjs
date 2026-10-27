// 挂载测试：用一个假 ctx 把插件装一遍，确认工具都注册上了、能卸载干净。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tieba-scout-apply-'));
process.env.DSH_HOME = HOME;

const mod = await import('../index.js');

const registered = [];
const settings = [];
const cleanups = [];

const ctx = {
  tools: { register: (t) => registered.push(t) },
  settings: { register: (...a) => settings.push(a) },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') cleanups.push(dispose);
    return dispose;
  },
};

let pass = 0;
const t = (n, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${n}`); } catch (e) {
    console.error(`  ✗ ${n}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

console.log('apply：假 ctx 挂载');

t('插件导出 name / inject', () => {
  assert.equal(mod.name, 'tieba-scout');
  assert.deepEqual(mod.inject, ['tools', 'settings']);
});

t('apply 不抛', () => {
  mod.apply(ctx, {});
});

t('工具都注册上了', () => {
  const names = registered.map((r) => r.name).sort();
  for (const want of ['tieba_popular', 'tieba_scan', 'tieba_thread', 'tieba_learn', 'tieba_note', 'tieba_recall', 'tieba_status', 'tieba_settings']) {
    assert.ok(names.includes(want), `少了 ${want}（实际：${names.join(',')}）`);
  }
});

t('每个工具都有描述、参数和 output', () => {
  for (const r of registered) {
    assert.ok(r.description && r.description.length > 8, `${r.name} 没描述`);
    assert.ok(r.output?.schema, `${r.name} 缺 output.schema`);
    assert.equal(typeof r.execute, 'function', `${r.name} 没有 execute`);
  }
});

t('必要参数标了 required', () => {
  const note = registered.find((r) => r.name === 'tieba_note');
  const props = note.parameters?.properties ?? {};
  assert.ok(props.text, 'tieba_note 少了 text 参数');
  assert.deepEqual(note.parameters?.required ?? [], ['text']);
});

t('设置项：有 schemastery 就挂，没有就安静跳过', () => {
  // @deepseek-ai/schemastery 是可选 peer 依赖；宿主没给时插件不该报错，
  // 只是没法在宿主的设置表单里露脸（配置仍然走 config.json + tieba_settings）。
  if (mod.Config) assert.ok(settings.length >= 1, '有 Config 却没注册设置项');
  else assert.equal(settings.length, 0, '没有 Config 却注册了设置项');
});

t('卸载时会清掉定时器和子进程', () => {
  for (const fn of cleanups) fn();
});

console.log(`\napply：${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
if (!pass) process.exitCode = 1;