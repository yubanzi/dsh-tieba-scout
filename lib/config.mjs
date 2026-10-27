// 配置：自己的 config.json（不依赖宿主自动表单，那个在部分版本上不渲染）。
//
// 优先级：磁盘里的 > 宿主传进来的 > 内置默认。
import fs from 'node:fs';
import path from 'node:path';
import { sub } from './paths.mjs';

export function configFile() {
  return sub('config.json');
}

export const DEFAULTS = {
  enabled: true,

  // 要看的吧。留空 + discover=true 就是「自己挑人气高的」
  forums: [],
  discover: true,
  maxForums: 2,

  // 每个吧读几帖、每帖读几楼
  maxThreads: 3,
  pages: 1,
  maxPosts: 12,
  maxCharsPerPost: 400,
  hotOnly: true,          // 只取高赞楼层，别把整楼都塞给模型

  // 笔记库
  maxCards: 400,
  maxMaterialChars: 12_000,

  // 冷却
  cooldownDays: 3,        // 学过的吧多少天内不再选
  junkCooldownDays: 7,    // 一帖都没读成的吧晾多久

  // 请求
  minGapMs: 1200,
  breakerMin: 30,

  // 定时（可选：起 headless 子进程跑一轮）
  autoRun: false,
  times: ['12:00', '22:00'],
  headlessProfile: 'headless',
  dshBin: '',
};

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

const asList = (v) => {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v ?? '').split(/[\n,，\s]+/).map((s) => s.trim()).filter(Boolean);
};

export function normalize(raw = {}) {
  const times = asList(raw.times)
    .map((t) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t);
      if (!m) return '';
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (h > 23 || min > 59) return '';
      return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    })
    .filter(Boolean);

  return {
    enabled: raw.enabled !== false,
    forums: [...new Set(asList(raw.forums))].slice(0, 30),
    discover: raw.discover !== false,
    maxForums: clampInt(raw.maxForums, 1, 6, DEFAULTS.maxForums),
    maxThreads: clampInt(raw.maxThreads, 1, 10, DEFAULTS.maxThreads),
    pages: clampInt(raw.pages, 1, 5, DEFAULTS.pages),
    maxPosts: clampInt(raw.maxPosts, 1, 40, DEFAULTS.maxPosts),
    maxCharsPerPost: clampInt(raw.maxCharsPerPost, 100, 2000, DEFAULTS.maxCharsPerPost),
    hotOnly: raw.hotOnly !== false,
    maxCards: clampInt(raw.maxCards, 20, 2000, DEFAULTS.maxCards),
    maxMaterialChars: clampInt(raw.maxMaterialChars, 2000, 40_000, DEFAULTS.maxMaterialChars),
    cooldownDays: clampInt(raw.cooldownDays, 0, 30, DEFAULTS.cooldownDays),
    junkCooldownDays: clampInt(raw.junkCooldownDays, 0, 60, DEFAULTS.junkCooldownDays),
    minGapMs: clampInt(raw.minGapMs, 200, 10_000, DEFAULTS.minGapMs),
    breakerMin: clampInt(raw.breakerMin, 0, 720, DEFAULTS.breakerMin),
    autoRun: raw.autoRun === true,
    times: times.length ? [...new Set(times)].sort() : [...DEFAULTS.times],
    headlessProfile: String(raw.headlessProfile || DEFAULTS.headlessProfile).slice(0, 40),
    dshBin: String(raw.dshBin || '').slice(0, 300),
  };
}

export function readConfig(override = {}) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { /* 还没有配置文件 */ }
  return normalize({ ...DEFAULTS, ...override, ...saved });
}

export function writeConfig(patch = {}) {
  const next = normalize({ ...readConfig(), ...patch });
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 1) + '\n');
  return next;
}