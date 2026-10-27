// 人气榜 → 挑吧。
//
// 规则（和线上那套一致）：
//   1. 候选按关注人数降序，只在前 `poolSize` 名里挑——太小的吧没什么可学的；
//   2. 用 `cursor` 轮转，避免孙笑川、抗压背锅这种头部吧永远霸榜；
//   3. 冷却：学过的吧 `cooldownDays` 天内不再选；一条卡片都没捞到的
//      （纯图楼、全是水贴）晾 `junkCooldownDays` 天，别反复烧额度。
export const DEFAULT_COOLDOWN_DAYS = 3;
export const DEFAULT_JUNK_COOLDOWN_DAYS = 7;

/**
 * @param {Array<{kw:string, members:number}>} candidates
 * @param {object} opt
 * @param {Map<string,{at:number,days?:number}>|Record<string,{at:number,days?:number}>} opt.recent
 */
export function pickForums(candidates, {
  count = 2,
  cursor = 0,
  recent = new Map(),
  now = Date.now(),
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
  junkCooldownDays = DEFAULT_JUNK_COOLDOWN_DAYS,
  poolSize = 20,
} = {}) {
  const recentMap = recent instanceof Map ? recent : new Map(Object.entries(recent || {}));

  const seen = new Set();
  const pool = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && c.kw && !seen.has(c.kw) && seen.add(c.kw))
    .sort((a, b) => (b.members ?? 0) - (a.members ?? 0))
    .slice(0, Math.max(1, poolSize));

  if (!pool.length) return { picked: [], cursor: 0, cold: 0 };

  const cooled = (c) => {
    const entry = recentMap.get(c.kw);
    if (!entry) return false;
    const at = Number(typeof entry === 'number' ? entry : entry.at) || 0;
    if (!at) return false;
    const days = Number(
      typeof entry === 'number' ? cooldownDays : (entry.days ?? cooldownDays),
    );
    return now - at < Math.max(0, days) * 86_400_000;
  };

  const picked = [];
  let cold = 0;
  const start = ((Number(cursor) || 0) % pool.length + pool.length) % pool.length;
  let i = 0;

  // 第一圈：守冷却，挑够就走
  while (picked.length < count && i < pool.length) {
    const c = pool[(start + i) % pool.length];
    i += 1;
    if (cooled(c)) { cold += 1; continue; }
    picked.push(c);
  }

  // 全在冷却里也不空手：放宽冷却补位（总比这一轮啥也不学强）
  let j = 0;
  while (picked.length < count && j < pool.length) {
    const c = pool[(start + j) % pool.length];
    j += 1;
    if (!picked.some((p) => p.kw === c.kw)) picked.push(c);
  }

  const next = (start + Math.max(1, i)) % pool.length;
  return { picked, cursor: next, cold: Math.min(cold, pool.length) };
}

/** 把候选摊平去重（人气榜 + 推荐吧），保留关注数最大的那条 */
export function mergeCandidates(...lists) {
  const byKw = new Map();
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const kw = String(item?.kw ?? '').trim();
      if (!kw) continue;
      const prev = byKw.get(kw);
      if (!prev || (item.members ?? 0) > (prev.members ?? 0)) {
        byKw.set(kw, { ...prev, ...item, kw, members: Math.max(item.members ?? 0, prev?.members ?? 0) });
      }
    }
  }
  return [...byKw.values()];
}