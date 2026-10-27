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
  // 用户/配置明确给了路径，就照他说的来，别再自作聪明去猜：
  // 猜出来的「另一个 dsh」会让人对着莫名其妙的报错查半天。
  if (want && (path.isAbsolute(want) || want.includes(path.sep) || want.includes('/'))) return want;

  const cands = [];
  const nodeDir = path.dirname(process.execPath);
  const home = os.homedir();
  const exeName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';

  // 最靠谱的一条：插件跑在 DSH 自己的进程里，而 DSH 的 node 就在
  // `<安装目录>/resources/runtime/primary-runtime/dependencies/node/bin/`，
  // CLI 是它的兄弟目录 `<安装目录>/resources/runtime/cli/bin/dsh.cmd`。
  // 所以从 execPath 往上walk，看每一层的 cli/bin/ —— 不用猜盘符，也不用猜层级。
  let dir = nodeDir;
  for (let i = 0; i < 6; i += 1) {
    cands.push(path.join(dir, 'cli', 'bin', exeName));
    cands.push(path.join(dir, 'resources', 'runtime', 'cli', 'bin', exeName));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (process.platform === 'win32') {
    cands.push(path.join(nodeDir, 'dsh.cmd'), path.join(nodeDir, 'dsh.exe'));
    if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'dsh.cmd'));
    if (process.env.NVM_SYMLINK) cands.push(path.join(process.env.NVM_SYMLINK, 'dsh.cmd'));
    for (const base of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
      if (!base) continue;
      cands.push(path.join(base, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
      cands.push(path.join(base, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    }
    // 安装目录被挪到别的盘（本机就是这样：程序在 G:，家目录在 C:）。
    // 有界地扫几个盘，别去递归整个文件系统。
    const user = path.basename(home);
    for (const drive of ['C', 'D', 'E', 'F', 'G']) {
      if (!fs.existsSync(`${drive}:\\`)) continue;
      for (const base of [
        path.join(`${drive}:\\`, 'Users', user, 'AppData', 'Local', 'Programs'),
        path.join(`${drive}:\\`, 'Program Files'),
        path.join(`${drive}:\\`, 'Program Files (x86)'),
      ]) {
        cands.push(path.join(base, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
      }
    }
  } else {
    cands.push(
      path.join(nodeDir, 'dsh'),
      '/usr/local/bin/dsh', '/usr/bin/dsh', '/opt/homebrew/bin/dsh',
      path.join(home, '.local/bin/dsh'), path.join(home, '.bun/bin/dsh'),
    );
  }

  for (const c of cands) if (canExec(c)) return c;

  // 还没找到：PATH 里要是有就交给 spawn 去解析
  for (const p of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!p) continue;
    for (const name of process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']) {
      const c = path.join(p, name);
      if (canExec(c)) return c;
    }
  }
  if (want && (path.isAbsolute(want) || want.includes(path.sep))) return want;
  return want || 'dsh';
}

/**
 * 怎么把它跑起来。
 *
 * Windows 上 `dsh` 通常是个 .cmd 壳，里面其实是「Electron 带 ELECTRON_RUN_AS_NODE=1
 * 执行 app.asar 里的 cli.js」。直接 spawn(.cmd) 会让 Node 给参数加引号，而 cmd 不认
 * `\"`，结果是 `'\"G:\...\"' 不是内部或外部命令` —— 这个坑踩过。
 * 所以：能从壳的位置推出真实入口，就直接 spawn Electron + cli.js，参数数组原样传，
 * 不经过 shell；退而求其次才是 cmd /c，并且要用 windowsVerbatimArguments。
 */
function planInvocation(bin) {
  const isCmd = /\.(cmd|bat)$/i.test(bin);
  if (isCmd) {
    const binDir = path.dirname(bin);
    // <安装目录>/resources/runtime/cli/bin/dsh.cmd
    const root = path.resolve(binDir, '..', '..', '..', '..');
    const exe = path.join(root, 'DeepSeek Harness.exe');
    const cliJs = path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules',
      '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    if (fs.existsSync(exe) && fs.existsSync(path.join(root, 'resources', 'app.asar'))) {
      // app.asar 是个文件，里面的 cli.js 普通 node 看不见（existsSync 会 false），
      // 所以只验外壳在不在，路径按桌面版的固定布局拼。
      return {
        command: exe,
        prefix: ['--expose-internals', cliJs],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        shell: false,
      };
    }
    return { command: process.env.ComSpec || 'cmd.exe', prefix: ['/d', '/s', '/c'], env: {}, shell: true };
  }
  return { command: bin, prefix: [], env: {}, shell: false };
}

/** 把一条命令拼成 cmd 能吃的字符串（只在 shell:true 时用） */
const quoteForCmd = (v) => `"${String(v).replace(/"/g, '""')}"`;

/** 给日志看的一句话：这个路径到底能不能用 */
export function dshBinProblem(bin) {
  if (bin && (canExec(bin) || fs.existsSync(bin))) return '';
  return `找不到 dsh 可执行文件（试过 "${bin}"）。在配置里把 dshBin 指到它，`
    + 'Windows 桌面版一般在 <安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd';
}

/** 把子进程的失败翻译成一句看得懂的话（日志里有全文，但状态栏只放得下一句） */
export function explainFailure(code, text = '') {
  const tail = String(text || '');
  if (/MISSING_CREDENTIAL/.test(tail)) {
    return '这台 DSH 的模型密钥没进到子进程（MISSING_CREDENTIAL）。'
      + '桌面版把密钥存在应用里、只在它自己的进程里注入；想单独跑定时，'
      + '给启动环境加 DEEPSEEK_API_KEY，或在设置页把 key 写进凭据服务。';
  }
  if (/no such file|ENOENT|is not recognized|不是内部或外部命令/i.test(tail)) {
    return `dsh 起不来（${tail.split('\n').find((l) => l.trim()) ?? '找不到可执行文件'}）。配置里指定 dshBin。`;
  }
  if (/profile .* not found|未知的 profile/i.test(tail)) {
    return '目标 profile 不存在：把 headlessProfile 改成有的（一般 headless 会在首次使用时自动初始化）。';
  }
  return `这一轮失败（退出码 ${code}），细节见日志。`;
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
  const problem = dshBinProblem(bin);
  if (problem) {
    releaseLock();
    try {
      fs.mkdirSync(logsDir(), { recursive: true });
      fs.appendFileSync(logFile(), `\n===== ${new Date().toISOString()} 没起起来 =====\n${problem}\n`);
    } catch { /* ignore */ }
    return Promise.resolve({ ok: false, code: -1, log: logFile(), error: problem });
  }

  // 长 prompt 里的引号/换行会被任何 shell 拆坏 —— 落文件，命令行只传一句短的。
  fs.mkdirSync(logsDir(), { recursive: true });
  const promptPath = path.join(logsDir(), `prompt-${Date.now()}.md`);
  fs.writeFileSync(promptPath, prompt);
  const instruction = `读取文件 ${promptPath} ，严格按那里的说明完成这一轮。`;

  const plan = planInvocation(bin);
  let command = plan.command;
  let args = [...plan.prefix, profile, instruction];
  if (plan.shell) {
    // 走到这里说明没能直接调 Electron：只能让 cmd 拼。
    // cmd /c 的规矩：命令串最外层还要再包一层引号，否则第一个带空格的路径会被截断
    // （"C:\...\DeepSeek Harness\..." 会变成 'C:\...\DeepSeek' 不是内部或外部命令）。
    const line = [quoteForCmd(bin), quoteForCmd(profile), quoteForCmd(instruction)].join(' ');
    args = [...plan.prefix, `"${line}"`];
  }

  const file = logFile();
  fs.mkdirSync(logsDir(), { recursive: true });
  const fd = fs.openSync(file, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} 起一轮 =====\n$ ${command} ${args.slice(0, 2).join(' ')} <prompt ${prompt.length} 字>\n`);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: process.env.DSH_WORKSPACE || os.homedir(),
        env: { ...process.env, ...plan.env, TIEBA_SCOUT_NO_SCHEDULE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsVerbatimArguments: plan.shell,
        windowsHide: true,
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
    let tail = '';                       // 留最后几 KB，用来翻译失败原因
    const keep = (d) => {
      tail = (tail + d.toString('utf8')).slice(-4000);
      try { fs.writeSync(fd, d) } catch { /* 盘满 */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch { /* 已经没了 */ }
    }, timeoutMs);

    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
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
      const ok = code === 0 && !timedOut;
      const error = ok ? '' : (timedOut ? '一轮超过 20 分钟，被杀掉了（多半是卡在模型或网络）' : explainFailure(code, tail));
      try {
        fs.writeFileSync(sub('last-round.json'), JSON.stringify({ at: Date.now(), ok, code, error, log: file }, null, 1));
      } catch { /* ignore */ }
      resolve({ ok, code, log: file, timedOut, ...(ok ? {} : { error }) });
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

/** 上一轮定时任务的结果（状态里显示一句话，不用去翻日志） */
export function readLastRound() {
  try { return JSON.parse(fs.readFileSync(sub('last-round.json'), 'utf8')); } catch { return null; }
}