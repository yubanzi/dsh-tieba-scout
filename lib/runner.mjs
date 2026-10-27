// 定时一轮：起一个 headless 子进程，把 prompts/duty.md 交给它。
//
// 为什么不在插件里直接生成：插件里没有模型。要让它「自己学」，只能借一个
// 带模型的进程 —— `dsh --profile headless "<说明>"`，跑完把日志落盘。
//
// 保守设计：默认关；一天一次；20 分钟超时；同一时间只允许一轮；输出不往宿主控制台灌。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sub } from './paths.mjs';

export const pluginDir = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const logsDir = () => sub('logs');
export const logFile = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return path.join(logsDir(), `run-${y}-${m}-${d}.log`);
};
const lockFile = () => sub('round.lock');

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function acquireLock() {
  try {
    const j = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    const pid = Number(j.pid);
    const fresh = Date.now() - Number(j.at || 0) < 30 * 60_000;
    if (pid && fresh && alive(pid)) return { ok: false, pid };
  } catch { /* 没有锁 */ }
  fs.mkdirSync(sub(), { recursive: true });
  fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() }));
  return { ok: true };
}

function releaseLock() {
  try {
    const j = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    if (Number(j.pid) === process.pid) fs.unlinkSync(lockFile());
  } catch { /* ignore */ }
}

const canExec = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };

/** GUI 进程的 PATH 里常常没有 dsh；按常见安装位置找绝对路径 */
export function resolveDshBin(explicit = '') {
  const want = String(explicit || '').trim();
  if (want && canExec(want)) return want;
  const cands = [];
  const nodeDir = path.dirname(process.execPath);
  const home = os.homedir();
  if (process.platform === 'win32') {
    cands.push(path.join(nodeDir, 'dsh.cmd'), path.join(nodeDir, 'dsh.exe'));
    if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'dsh.cmd'));
    if (process.env.NVM_SYMLINK) cands.push(path.join(process.env.NVM_SYMLINK, 'dsh.cmd'));
  } else {
    cands.push(
      path.join(nodeDir, 'dsh'),
      '/usr/local/bin/dsh', '/usr/bin/dsh', '/opt/homebrew/bin/dsh',
      path.join(home, '.local/bin/dsh'), path.join(home, '.bun/bin/dsh'),
    );
  }
  for (const c of cands) if (canExec(c)) return c;
  if (want && (path.isAbsolute(want) || want.includes(path.sep))) return want;
  return want || 'dsh';
}

function dutyPrompt({ extra = '' } = {}) {
  try {
    const text = fs.readFileSync(path.join(pluginDir(), 'prompts', 'duty.md'), 'utf8');
    return [text, extra].filter(Boolean).join('\n');
  } catch { return ''; }
}

let current = null;
export const isRunning = () => Boolean(current && current.exitCode === null && !current.killed);

export function stopRound() {
  if (!current) return { ok: false, error: '当前没有在跑的轮次' };
  const pid = current.pid;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* 已经没了 */ }
  return { ok: true, pid };
}

/**
 * 跑一轮。永远不抛：错误也写进日志。
 * @returns {Promise<{ok:boolean, code:number, log:string, timedOut?:boolean, error?:string}>}
 */
export function runRound({ profile = 'headless', dshBin = '', timeoutMs = 20 * 60_000, extra = '' } = {}) {
  const prompt = [
    '你现在替使用者刷一轮贴吧。先 tieba_status 看状态，再照下面的说明做。',
    '',
    dutyPrompt({ extra }),
  ].join('\n');

  const lock = acquireLock();
  if (!lock.ok) {
    return Promise.resolve({ ok: false, error: `另一个进程正在跑（pid ${lock.pid}）`, log: logFile() });
  }

  let bin = resolveDshBin(dshBin || process.env.DSH_BIN || '');
  let args = [profile, prompt];

  if (process.platform === 'win32') {
    // npm 装的 dsh 是 .cmd；而且长 prompt 里的引号/换行会被 cmd 拆坏 —— 落文件，命令行只传一句。
    const pf = path.join(logsDir(), `prompt-${Date.now()}.md`);
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(pf, prompt);
    const instruction = `读取文件 ${pf} ，严格按那里的说明完成这一轮。`;
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    if (/\.(cmd|bat)$/i.test(bin) || !path.extname(bin)) {
      args = ['/d', '/s', '/c', `${q(bin)} ${q(profile)} ${q(instruction)}`];
      bin = process.env.ComSpec || 'cmd.exe';
    } else {
      args = [profile, instruction];
    }
  }

  const file = logFile();
  fs.mkdirSync(logsDir(), { recursive: true });
  const fd = fs.openSync(file, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} 起一轮 =====\n$ ${bin} ${args.slice(0, 2).join(' ')} <prompt ${prompt.length} 字>\n`);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: process.env.DSH_WORKSPACE || os.homedir(),
        env: { ...process.env, TIEBA_SCOUT_NO_SCHEDULE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      child.unref();
      current = child;
    } catch (e) {
      fs.writeSync(fd, `spawn 失败：${e.message}\n`);
      fs.closeSync(fd);
      releaseLock();
      return resolve({ ok: false, code: -1, log: file, error: e.message });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch { /* 已经没了 */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { try { fs.writeSync(fd, d) } catch { /* 盘满 */ } });
    child.stderr.on('data', (d) => { try { fs.writeSync(fd, d) } catch { /* 盘满 */ } });
    child.on('error', (e) => {
      clearTimeout(timer);
      try { fs.writeSync(fd, `子进程错误：${e.message}\n`) } catch { /* ignore */ }
      try { fs.closeSync(fd) } catch { /* ignore */ }
      releaseLock();
      resolve({ ok: false, code: -1, log: file, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { fs.writeSync(fd, `\n===== 结束 code=${code}${timedOut ? '（超时被杀）' : ''} =====\n`) } catch { /* ignore */ }
      try { fs.closeSync(fd) } catch { /* ignore */ }
      current = null;
      releaseLock();
      resolve({ ok: code === 0 && !timedOut, code, log: file, timedOut });
    });
  });
}

export function readLog({ date = new Date(), lines = 200 } = {}) {
  const file = logFile(date);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { ok: true, file, text: raw.split('\n').slice(-Math.max(20, lines)).join('\n').trim() };
  } catch {
    return { ok: false, file, error: '还没有运行日志' };
  }
}