// runner 的管道测试：不联网、不调模型，用一个假 dsh 验证
// 「起子进程 → 传 prompt 文件 → 落日志 → 放锁 → 记结果」这条路。
//
// 这一层踩过两个坑，测试就是来钉住它们的：
//   1. 直接 spawn(.cmd) 时 Node 会给参数加引号，cmd 不认 `\"`；
//   2. 长 prompt 不能上命令行，必须落文件传路径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tieba-scout-runner-'));
process.env.DSH_HOME = HOME;

const { runRound, resolveDshBin, dshBinProblem, explainFailure, readLastRound } =
  await import('../lib/runner.mjs');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

const isWin = process.platform === 'win32';
const stub = path.join(HOME, isWin ? 'fake-dsh.cmd' : 'fake-dsh');
if (isWin) {
  fs.writeFileSync(stub, '@echo off\r\necho FAKE-DSH-OK\r\nexit /b 0\r\n');
} else {
  fs.writeFileSync(stub, '#!/bin/sh\necho FAKE-DSH-OK\nexit 0\n');
  fs.chmodSync(stub, 0o755);
}

console.log('runner：管道');

await t('假 dsh 能跑通，返回 ok', async () => {
  const r = await runRound({ profile: 'headless', dshBin: stub, timeoutMs: 30_000 });
  assert.equal(r.ok, true, `失败：${r.error}`);
  assert.equal(r.code, 0);
});

await t('prompt 落成了文件，而且带上了 duty.md 的正文', async () => {
  const dir = path.join(HOME, 'tieba-scout', 'logs');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('prompt-'));
  assert.ok(files.length >= 1, '没有 prompt 文件');
  const body = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.match(body, /这一轮做什么/);
  assert.ok(body.length > 300, `prompt 太短：${body.length}`);
});

await t('跑完要把锁放掉', async () => {
  assert.equal(fs.existsSync(path.join(HOME, 'tieba-scout', 'round.lock')), false);
});

await t('日志里留下了起止记录', async () => {
  const dir = path.join(HOME, 'tieba-scout', 'logs');
  const log = fs.readdirSync(dir).find((f) => f.startsWith('run-'));
  const text = fs.readFileSync(path.join(dir, log), 'utf8');
  assert.match(text, /起一轮/);
  assert.match(text, /结束 code=0/);
});

await t('结果记到了 last-round.json', async () => {
  const last = readLastRound();
  assert.equal(last.ok, true);
  assert.equal(last.code, 0);
});

await t('找不到 dsh 时给一句能照做的话，并且不留锁', async () => {
  const r = await runRound({ dshBin: path.join(HOME, 'nope-dsh.cmd'), timeoutMs: 5_000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /dshBin/);
  assert.equal(fs.existsSync(path.join(HOME, 'tieba-scout', 'round.lock')), false);
});

await t('子进程退出非 0 时，报错说人话', async () => {
  const bad = path.join(HOME, isWin ? 'bad.cmd' : 'bad.sh');
  if (isWin) fs.writeFileSync(bad, '@echo off\r\necho boom 1>&2\r\nexit /b 3\r\n');
  else { fs.writeFileSync(bad, '#!/bin/sh\necho boom >&2\nexit 3\n'); fs.chmodSync(bad, 0o755); }
  const r = await runRound({ dshBin: bad, timeoutMs: 30_000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.ok(r.error && r.error.length > 4, '没有错误说明');
  assert.equal(readLastRound().ok, false);
});

await t('MISSING_CREDENTIAL 翻译成人话', () => {
  const msg = explainFailure(1, 'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key');
  assert.match(msg, /密钥/);
  assert.match(msg, /DEEPSEEK_API_KEY/);
});

await t('dshBinProblem 对存在的文件返回空串', () => {
  assert.equal(dshBinProblem(stub), '');
  assert.ok(dshBinProblem(path.join(HOME, 'nothing')).length > 0);
});

await t('resolveDshBin：显式路径能用就用它', () => {
  assert.equal(resolveDshBin(stub), stub);
});

console.log(`\nrunner：${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
if (!pass) process.exitCode = 1;