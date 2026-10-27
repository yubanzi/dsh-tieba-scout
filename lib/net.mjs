// 贴吧 HTTP 通道：签名 + tbs + 串行限速 + 风控熔断。
//
// 为什么是纯 HTTP：2026-10-27 实测，PC 端接口 `/c/f/**` 只要带上正确的 `sign`
// 和 `tbs`，匿名（不带任何登录 cookie）就能拿到完整 JSON——
// 人气榜、推荐吧、吧内帖子列表、楼层正文全部可用。
// 这条路比开浏览器快两个数量级，也不吃本机 Chrome 与沙箱限制。
//
// 三个必须守的规矩：
//   · 请求串行，两条之间至少 gapMs（贴吧对突发很敏感）；
//   · 撞到「百度安全验证」立刻熔断，落盘，期间一个请求都不发（重启也认）；
//   · 参数与签名成对出现，缺 sign 会稳定回 110001，看起来像风控，其实不是。
import fs from 'node:fs';
import { sub } from './paths.mjs';
import { signRequest } from './sign.mjs';

export const BASE = 'https://tieba.baidu.com';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TiebaError extends Error {
  constructor(message, code = 'TIEBA', extra = {}) {
    super(message);
    this.name = 'TiebaError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const cooldownFile = () => sub('cooldown.json');

export function readCooldown() {
  try {
    const j = JSON.parse(fs.readFileSync(cooldownFile(), 'utf8'));
    const until = Number(j.until) || 0;
    return { until, reason: j.reason || '', active: until > Date.now() };
  } catch {
    return { until: 0, reason: '', active: false };
  }
}

export function remainingMs() {
  return Math.max(0, readCooldown().until - Date.now());
}

export function trip(minutes, reason = '百度安全验证') {
  const ms = Math.max(0, Number(minutes) || 0) * 60_000;
  if (!ms) return { active: false };
  const until = Date.now() + ms;
  fs.mkdirSync(sub(), { recursive: true });
  fs.writeFileSync(cooldownFile(), JSON.stringify({ until, reason, at: new Date().toISOString() }, null, 1) + '\n');
  return { active: true, until, reason };
}

export function clearCooldown() {
  try { fs.unlinkSync(cooldownFile()); } catch { /* 本来就没有 */ }
}

/**
 * 建一个通道实例。
 * 同一个实例内的请求串行；tbs 缓存在实例里。
 */
export function createNet({
  gapMs = 1200,
  breakerMin = 30,
  userAgent = UA,
  log = () => {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 25_000,
} = {}) {
  let lastAt = 0;
  let queue = Promise.resolve();
  let tbsCache = { value: '', at: 0 };

  const gap = () => Math.max(200, Number(gapMs) || 1200);

  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.then(() => {}, () => {});
    return run;
  }

  function assertNotBlocked() {
    const left = remainingMs();
    if (left > 0) {
      throw new TiebaError(`风控熔断中：还要等 ${Math.ceil(left / 60_000)} 分钟`, 'COOLDOWN', {
        cooldownUntil: readCooldown().until,
      });
    }
  }

  async function throttle() {
    const wait = gap() - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
  }

  function inspect(text, status) {
    if (status === 403 || /百度安全验证|请完成安全验证/.test(String(text).slice(0, 4000))) {
      const t = trip(breakerMin, `HTTP ${status} 安全验证`);
      throw new TiebaError(
        `被百度安全验证拦了（已熔断 ${breakerMin} 分钟）${
          t.active ? '' : '（breakerMin=0，未熔断）'
        }`,
        'BLOCKED',
        { cooldownUntil: t.until },
      );
    }
  }

  async function raw(path, { method = 'GET', params = {}, withTbs = false, label = '接口', referer = `${BASE}/` } = {}) {
    assertNotBlocked();
    const data = { ...params };
    if (withTbs) data.tbs = await tbs();

    const signed = signRequest(data);
    const form = Object.fromEntries(Object.entries(signed).map(([k, v]) => [k, String(v)]));
    let url = `${BASE}${path}`;
    let body;

    if (method === 'POST') {
      body = new URLSearchParams(form).toString();
    } else {
      url += '?' + new URLSearchParams(form).toString();
    }

    await throttle();

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          'user-agent': userAgent,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
          referer,
          'x-requested-with': 'XMLHttpRequest',
          ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TiebaError(`${label}请求失败：${error?.message ?? error}`, 'NETWORK');
    }

    const text = await res.text();
    inspect(text, res.status);

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TiebaError(`${label}返回的不是 JSON（HTTP ${res.status}，${text.length} 字节）`, 'NOT_JSON', {
        sample: text.slice(0, 200),
      });
    }

    const code = Number(json?.error_code ?? 0);
    if (code !== 0) {
      // 110001 是「签名/参数不对」，不是风控，所以不熔断，但要把话说清楚
      const hint = code === 110001 ? '（签名或参数不对，不是风控）' : '';
      throw new TiebaError(`${label}返回错误 ${code}：${json?.error_msg ?? ''}${hint}`, 'API', { apiCode: code });
    }
    return json;
  }

  /** tbs：POST 类接口都要，匿名也发。缓存 10 分钟。 */
  async function tbs(force = false) {
    if (!force && tbsCache.value && Date.now() - tbsCache.at < 10 * 60_000) return tbsCache.value;

    assertNotBlocked();
    await throttle();
    let res;
    try {
      res = await fetchImpl(`${BASE}/dc/common/tbs`, {
        headers: {
          'user-agent': userAgent,
          accept: 'application/json, text/plain, */*',
          referer: `${BASE}/`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TiebaError(`取 tbs 失败：${error?.message ?? error}`, 'NETWORK');
    }
    const text = await res.text();
    inspect(text, res.status);
    let json;
    try { json = JSON.parse(text); } catch { throw new TiebaError('tbs 没返回 JSON', 'NOT_JSON'); }
    const value = String(json?.tbs ?? '');
    if (!value) throw new TiebaError('tbs 为空（贴吧可能改版了）', 'NO_TBS');
    tbsCache = { value, at: Date.now() };
    log(`tbs 已取：${value.slice(0, 8)}…（is_login=${json?.is_login}）`);
    return value;
  }

  const api = (path, opt) => serialize(() => raw(path, opt));

  return {
    api,
    tbs,
    get gapMs() { return gap() },
    get blocked() { return remainingMs() > 0 },
    clearCooldown,
  };
}