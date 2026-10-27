/**
 * dsh-tieba-scout —— 主机半端
 * ============================================================================
 * 「贴吧探子」：自己从人气榜里挑吧，读帖取见闻，提炼成可检索的笔记卡片。
 *
 * 四条规矩：
 *   1. **只读**。不签到、不关注、不回帖、不发帖——没有任何写接口。
 *   2. **匿名**。不用 BDUSS、不存 cookie；走 PC 端 JSON 接口 + 签名，像普通访客一样看。
 *   3. **取素材与提炼分开**。插件里没有模型：`tieba_learn` 出素材，模型写成卡片，
 *      `tieba_note` 存下来。这样谁来当大脑都行（QQ 里的机器人、headless 定时）。
 *   4. **怕快不怕慢**。请求串行、默认 1.2 秒间隔、撞到验证立刻落盘熔断 30 分钟。
 *
 * 数据都在 `$DSH_HOME/tieba-scout/`：config.json / notes.json / cooldown.json / logs/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from './lib/toolkit.mjs';
import { createScout } from './lib/scout.mjs';
import { readConfig, writeConfig, DEFAULTS } from './lib/config.mjs';
import { sub } from './lib/paths.mjs';
import { runRound, readLog, isRunning, stopRound, readLastRound } from './lib/runner.mjs';

export const name = 'tieba-scout';
// webServer 不要写进 inject：headless 里没有这个服务，写进去整个插件会 pending。
export const inject = ['tools', 'settings'];

let z;
try { z = (await import('@deepseek-ai/schemastery')).default; } catch { z = null; }

/** 宿主表单（有就用，没有也能跑） */
export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  forums: z.array(z.string()).default(DEFAULTS.forums),
  discover: z.boolean().default(DEFAULTS.discover),
  maxForums: z.natural().default(DEFAULTS.maxForums),
  autoRun: z.boolean().default(DEFAULTS.autoRun),
});

const scheduleFile = () => sub('schedule.json');
const today = (now = new Date()) => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

function readSchedule() {
  try { return JSON.parse(fs.readFileSync(scheduleFile(), 'utf8')); } catch { return { date: '', done: {} }; }
}

function writeSchedule(state) {
  fs.mkdirSync(sub(), { recursive: true });
  fs.writeFileSync(scheduleFile(), JSON.stringify(state, null, 1));
  return state;
}

export function apply(ctx, config = {}) {
  const log = (...a) => console.log('[tieba-scout]', ...a);
  const cfgOf = () => readConfig(config);
  const scout = createScout({ getConfig: cfgOf, log });

  const tool = (spec) => {
    const wrapped = {
      ...spec,
      execute: async (...args) => {
        try {
          return await spec.execute(...args);
        } catch (error) {
          log(`工具 ${spec.name} 失败：${error?.message ?? error}`);
          throw error;
        }
      },
    };
    try { ctx.tools.register(defineTool(wrapped)); } catch (error) {
      log(`工具 ${spec.name} 没注册上（不影响别的）：${error?.message ?? error}`);
    }
  };

  if (typeof ctx.settings?.register === 'function' && Config) {
    try { ctx.settings.register('tieba-scout', Config, { base: {}, applies: 'live' }); } catch (error) {
      log(`宿主设置项没挂上（不影响用）：${error?.message ?? error}`);
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────────────

  tool({
    name: 'tieba_popular',
    description: '看贴吧现在什么火：人气榜（按关注数排）、全站热话题、推荐吧。'
      + '不知道该看哪个吧的时候先调这个。结果缓存 30 分钟。',
    parameters: { refresh: { type: 'boolean', description: '强制刷新（默认用缓存）' } },
    execute: async (args) => {
      const pop = await scout.popular({ force: args.refresh === true });
      return {
        forums: pop.forums.slice(0, 12).map((f) => ({
          kw: f.kw, members: f.members, score: f.score, tab: f.tab ?? '',
          hotThread: f.hotThread?.title ?? '',
        })),
        topics: pop.topics.slice(0, 10).map((t) => ({ title: t.title, discuss: t.discuss })),
        cached: pop.cached,
        note: '挑吧时优先关注人数高的；小吧（几万以下）内容通常很稀。',
      };
    },
  });

  tool({
    name: 'tieba_scan',
    description: '列出某个吧最近在聊什么（标题 / 回复数 / 浏览数 / 是否精品）。'
      + '只看标题就够判断要不要读帖，别为了读而读。',
    parameters: {
      kw: { type: 'string', description: '吧名，例如 steam、bilibili', required: true },
      pages: { type: 'number', description: '取几页（默认按配置，一般 1 页就够）' },
    },
    execute: async (args) => {
      const data = await scout.scan({ kw: args.kw, pages: Number(args.pages) || undefined });
      return {
        kw: data.kw,
        members: data.members,
        count: data.threads.length,
        threads: data.threads.slice(0, 25).map((t) => ({
          tid: t.tid, title: t.title, replies: t.replies, views: t.views,
          isGood: t.isGood, abstract: t.abstract.slice(0, 80),
        })),
      };
    },
  });

  tool({
    name: 'tieba_thread',
    description: '读一个帖子的楼层正文（首页 + 末页，按赞数挑高赞楼）。'
      + '要判断「值不值得记」就读几个楼，别只信标题。',
    parameters: {
      tid: { type: 'string', description: '帖子号（数字）', required: true },
      kw: { type: 'string', description: '吧名（可选，带上更稳）' },
      maxPosts: { type: 'number', description: '最多几楼（默认按配置）' },
    },
    execute: async (args) => {
      const cfg = cfgOf();
      const data = await scout.read({ tid: args.tid, kw: args.kw });
      const text = (await import('./lib/parse.mjs'))
        .renderThread(data, { hotOnly: cfg.hotOnly, hotLimit: Number(args.maxPosts) || cfg.maxPosts, maxChars: cfg.maxCharsPerPost });
      return {
        tid: data.tid, title: data.title, forum: data.forum,
        replies: data.replyNum, agree: data.agreeNum,
        url: `https://tieba.baidu.com/p/${data.tid}`,
        posts: data.posts.length, text,
      };
    },
  });

  tool({
    name: 'tieba_learn',
    description: '跑一轮取素材：不带参数就自己从人气榜挑几个吧（跳过最近学过的），'
      + '读几帖的高赞楼层，返回素材包。**这一步不产生卡片**，卡片要你自己提炼后用 tieba_note 存。',
    parameters: {
      kw: { type: 'string', description: '只看这个吧（不传就自动挑）' },
      threads: { type: 'number', description: '每个吧读几帖（默认按配置）' },
    },
    execute: async (args) => {
      const result = await scout.learn({ kw: args.kw, threads: Number(args.threads) || undefined });
      return {
        forums: result.forums,
        learnedThreads: result.learnedThreads,
        threads: result.threads.map((t) => ({ tid: t.tid, kw: t.kw, title: t.title, url: t.url })),
        material: result.material || '（这一轮没读到可用内容，直接结束）',
        next: '把素材提炼成卡片，每条一次 tieba_note；quality < 0.2 的别存。',
      };
    },
  });

  tool({
    name: 'tieba_note',
    description: '存一张见闻卡片（一条一卡，一到三句，别搬原文）。同一 tid 同一条正文不会重复存。',
    parameters: {
      text: { type: 'string', description: '卡片正文，40~160 字，一到三句', required: true },
      kw: { type: 'string', description: '来自哪个吧' },
      tid: { type: 'string', description: '来源帖子号（便于回看）' },
      title: { type: 'string', description: '来源帖子标题' },
      tags: { type: 'array', items: { type: 'string' }, description: '两三个短标签，方便检索' },
      quality: { type: 'number', description: '0~1，纯花边给 0.3~0.5，能改变判断的给 0.6 以上' },
    },
    execute: async (args) => {
      const saved = scout.note({
        text: args.text, kw: args.kw, tid: args.tid, title: args.title,
        tags: Array.isArray(args.tags) ? args.tags : [], quality: Number(args.quality ?? 0.5),
      });
      return { added: saved.added, id: saved.card.id, cards: scout.status().cards };
    },
  });

  tool({
    name: 'tieba_recall',
    description: '从笔记库里按话题检索见闻卡片。聊天里遇到相关话题时先查这里，别凭空说。',
    parameters: {
      query: { type: 'string', description: '话题或关键词', required: true },
      limit: { type: 'number', description: '最多几条（默认 6）' },
    },
    execute: async (args) => {
      const result = scout.recall(String(args.query), { limit: Number(args.limit) || 6 });
      return { count: result.hits.length, hits: result.hits, block: result.block };
    },
  });

  tool({
    name: 'tieba_status',
    description: '看笔记库与运行状态：多少张卡、来自哪些吧、上次学的时间、是否在风控熔断、下次定时。',
    parameters: {},
    execute: async () => {
      const cfg = cfgOf();
      const st = scout.status();
      const sch = readSchedule();
      return {
        ...st,
        autoRun: cfg.autoRun,
        times: cfg.times,
        running: isRunning(),
        schedule: { date: sch.date, done: Object.keys(sch.done ?? {}) },
        lastRound: readLastRound(),
        log: readLog({ lines: 20 }).text?.slice(-400) ?? '',
      };
    },
  });

  tool({
    name: 'tieba_settings',
    description: '读当前配置；传 patch 就改（会写回 config.json）。'
      + '可改：forums / discover / maxForums / maxThreads / times / autoRun / cooldownDays / minGapMs。',
    parameters: { patch: { type: 'object', description: '要改的字段，例如 {"maxForums": 2}' } },
    execute: async (args) => {
      const patch = args.patch && typeof args.patch === 'object' ? args.patch : null;
      const cfg = patch ? writeConfig(patch) : cfgOf();
      return { config: cfg, file: sub('config.json') };
    },
  });

  // ── 定时 ────────────────────────────────────────────────────────────────────

  ctx.effect(() => {
    const timer = setInterval(async () => {
      const cfg = cfgOf();
      if (!cfg.enabled || !cfg.autoRun) return;
      if (process.env.TIEBA_SCOUT_NO_SCHEDULE === '1') return;
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (!cfg.times.includes(hhmm)) return;

      const date = today(now);
      const sch = readSchedule();
      if (sch.date === date && sch.done?.[hhmm]) return;
      if (isRunning()) return;

      writeSchedule({ date, done: { ...(sch.date === date ? sch.done : {}), [hhmm]: new Date().toISOString() } });
      log(`到点 ${hhmm}，起一轮 headless`);
      const result = await runRound({ profile: cfg.headlessProfile, dshBin: cfg.dshBin });
      log(result.ok ? `这一轮跑完了：${result.log}` : `这一轮失败：${result.error ?? result.code}`);
      if (!result.ok) {
        // 一轮失败不应该让插件崩，也不该每分钟重试：这个点已经记成「跑过了」。
        log('（今天这个点不会再自动重试；手动调 tieba_learn 或改 times）');
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, 'tieba-scout: 定时一轮');

  ctx.effect(() => () => { try { stopRound(); } catch { /* ignore */ } }, 'tieba-scout: 卸载时收掉子进程');

  log(`贴吧探子已就绪：${cfgOf().autoRun ? `定时 ${cfgOf().times.join(' / ')}` : '定时未开（autoRun=false）'}，笔记 ${scout.status().cards} 张`);
}

export const core = { readConfig, writeConfig, createScout, sub, path };