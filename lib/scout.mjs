// 核心：把通道、解析、人气发现、笔记库拧成四个动作。
//   popular  看现在什么火
//   scan     看某个吧在聊什么
//   learn    自己挑吧、挑帖、读楼，产出一份「素材包」
//   note     把提炼过的见闻存成卡
//
// 提炼故意不在这一层做：插件里没有模型，取素材和写卡片分开，
// 谁来提炼交给调用方（QQ 里的桥接用独立会话，headless 里用当轮模型）。
import { createNet, remainingMs, trip, clearCooldown as clearCd, readCooldown } from './net.mjs';
import {
  parseSidebar, parseForumPage, parseThreadPage,
  pickHotPosts, renderThread, isJunkTitle,
} from './parse.mjs';
import { pickForums, mergeCandidates } from './discover.mjs';
import { createStore, notesBlock } from './store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

export function createScout({ getConfig, log = () => {}, fetchImpl, store } = {}) {
  const cfg = () => getConfig();
  const notes = store ?? createStore({ maxCards: cfg().maxCards });

  let net = null;
  let netKey = '';

  function channel() {
    const c = cfg();
    const key = `${c.minGapMs}|${c.breakerMin}`;
    if (!net || netKey !== key) {
      net = createNet({ gapMs: c.minGapMs, breakerMin: c.breakerMin, log, fetchImpl });
      netKey = key;
    }
    return net;
  }

  let popularCache = { at: 0, value: null };

  async function popular({ force = false, maxAgeMs = 30 * 60_000 } = {}) {
    if (!force && popularCache.value && Date.now() - popularCache.at < maxAgeMs) {
      return { ...popularCache.value, cached: true };
    }
    const api = channel().api;
    const [right, left] = await Promise.allSettled([
      api('/c/f/pc/homeSidebarRight', { label: '人气榜' }),
      api('/c/f/pc/homeSidebarLeft', { label: '推荐吧' }),
    ]);
    if (right.status === 'rejected' && left.status === 'rejected') throw right.reason;
    const parsed = parseSidebar({
      right: right.status === 'fulfilled' ? right.value : null,
      left: left.status === 'fulfilled' ? left.value : null,
    });
    const value = { ...parsed, at: Date.now() };
    popularCache = { at: Date.now(), value };
    return { ...value, cached: false };
  }

  async function scan({ kw, pages } = {}) {
    const c = cfg();
    const name = String(kw ?? '').trim();
    if (!name) throw new Error('要给个吧名');
    const pageCount = Math.max(1, Number(pages) || c.pages);
    const api = channel().api;
    const all = [];
    let meta = null;
    for (let pn = 1; pn <= pageCount; pn++) {
      const json = await api('/c/f/frs/page_pc', {
        method: 'POST',
        withTbs: true,
        label: `${name}吧第 ${pn} 页`,
        referer: `https://tieba.baidu.com/f?kw=${encodeURIComponent(name)}`,
        params: {
          kw: name, pn, sort_type: -1, is_newfrs: 1, is_newfeed: 1,
          rn: 30, rn_need: 10,
        },
      });
      const page = parseForumPage(json);
      meta = meta ?? page;
      all.push(...page.threads);
      if (page.totalPage && pn >= page.totalPage) break;
    }
    const seen = new Set();
    const threads = all.filter((t) => (seen.has(t.tid) ? false : seen.add(t.tid)));
    return { kw: meta?.kw || name, members: meta?.members ?? 0, threads };
  }

  /** 读一页楼层。r=0 是正序（带真实楼层号）；r=2 是「热门回复」模块，没有楼层号，别用。 */
  async function readPage(id, pn, kw) {
    const json = await channel().api('/c/f/pb/page_pc', {
      method: 'POST',
      withTbs: true,
      label: `帖子 ${id} 第 ${pn} 页`,
      referer: `https://tieba.baidu.com/p/${id}`,
      params: {
        pn, lz: 0, r: 0, mark_type: 0, back: 0, fr: '',
        kz: id, session_request_times: 1,
        ...(kw ? { kw: String(kw) } : {}),
      },
    });
    return parseThreadPage(json);
  }

  async function read({ tid, kw, deep = true } = {}) {
    const id = String(tid ?? '').trim();
    if (!/^\d{6,}$/.test(id)) throw new Error('帖子号（tid）看起来不对');
    const first = await readPage(id, 1, kw);
    // 长帖只读首页会全是楼主和早期回复；补一次末页，拿最新那批。
    if (deep && first.totalPage > 1) {
      try {
        const last = await readPage(id, first.totalPage, kw);
        const seen = new Set(first.posts.map((p) => p.pid));
        const extra = last.posts.filter((p) => p.pid && !seen.has(p.pid));
        if (extra.length) {
          return {
            ...first,
            posts: [...first.posts, ...extra].sort((a, b) => a.floor - b.floor),
            page: first.page,
            totalPage: first.totalPage,
          };
        }
      } catch (error) {
        log(`帖子 ${id} 末页没读到（不影响）：${error?.message ?? error}`);
      }
    }
    return first;
  }

  /** 挑帖：先排水贴广告，再按「精品 > 回复多 > 浏览多」排 */
  function pickThreads(threads, limit) {
    return [...threads]
      .filter((t) => !isJunkTitle(t.title))
      .sort((a, b) => (Number(b.isGood) - Number(a.isGood)) || (b.replies - a.replies) || (b.views - a.views))
      .slice(0, Math.max(1, limit));
  }

  /**
   * 跑一轮学习，返回素材包（不给卡片）。
   * `kw` 指定只看这个吧；不传就按人气榜自己挑。
   */
  async function learn({ kw, threads: threadCount } = {}) {
    const c = cfg();
    const want = Math.max(1, Number(threadCount) || c.maxThreads);
    let forums = [];
    let cursor = 0;

    if (kw) {
      forums = [String(kw).trim()];
    } else if (c.forums.length && !c.discover) {
      forums = c.forums.slice(0, c.maxForums);
    } else {
      const pop = await popular();
      const candidates = mergeCandidates(pop.forums, pop.recom ?? []);
      const picked = pickForums(candidates, {
        count: c.maxForums,
        cursor: notes.state.stats.forumCursor,
        recent: notes.recent(),
        cooldownDays: c.cooldownDays,
        junkCooldownDays: c.junkCooldownDays,
      });
      forums = picked.picked.map((p) => p.kw);
      cursor = picked.cursor;
      if (!forums.length) {
        // 全在冷却里：退一步，用配置里的固定名单（如果有）
        forums = c.forums.slice(0, c.maxForums);
      }
    }

    if (!forums.length) throw new Error('没有可学的吧（人气榜没拿到，配置里也没填 forums）');

    const material = [];
    const picked = [];
    let learnedThreads = 0;
    let used = 0;

    for (const name of forums) {
      let listed;
      try {
        listed = await scan({ kw: name });
      } catch (error) {
        log(`${name}吧列表失败：${error?.message ?? error}`);
        notes.noteAttempt(name, 0, Date.now(), { junkCooldownDays: c.junkCooldownDays });
        continue;
      }
      const chosen = pickThreads(listed.threads, want);
      const block = [`## ${name}吧（关注 ${listed.members}｜本轮 ${chosen.length} 帖）`];
      let perForum = 0;

      for (const t of chosen) {
        if (used >= c.maxMaterialChars) break;
        let thread;
        try {
          thread = await read({ tid: t.tid, kw: name });
        } catch (error) {
          log(`帖子 ${t.tid} 读取失败：${error?.message ?? error}`);
          continue;
        }
        const hot = pickHotPosts(thread.posts, { limit: c.hotOnly ? c.maxPosts : 99 });
        const body = c.hotOnly
          ? renderThread(thread, { hotOnly: true, hotLimit: c.maxPosts, maxChars: c.maxCharsPerPost })
          : renderThread(thread, { maxPosts: c.maxPosts, maxChars: c.maxCharsPerPost });
        const text = `${body}`.slice(0, Math.max(400, c.maxCharsPerPost * Math.max(1, hot.length) + 200));
        if (!hot.length && !thread.posts.length) continue;
        block.push('');
        block.push(text);
        perForum += 1;
        used += text.length;
        picked.push({ tid: t.tid, kw: name, title: thread.title || t.title, url: `https://tieba.baidu.com/p/${t.tid}` });
      }

      if (perForum) {
        material.push(block.join('\n'));
        learnedThreads += perForum;
      } else {
        log(`${name}吧：一条可用的都没读成`);
      }
      notes.noteAttempt(name, perForum, Date.now(), { junkCooldownDays: c.junkCooldownDays });
    }

    if (cursor) notes.setCursor(cursor);

    return {
      forums,
      threads: picked,
      learnedThreads,
      material: material.join('\n\n').slice(0, c.maxMaterialChars),
      cursor,
    };
  }

  function note(card) {
    const saved = notes.add(card);
    return saved;
  }

  function recall(query, { limit = 6, minScore = 0.02 } = {}) {
    const hits = notes.recall(query, { limit, minScore });
    return {
      hits: hits.map((h) => ({ ...h.card, score: Number(h.score.toFixed(3)) })),
      block: notesBlock(hits),
    };
  }

  function status() {
    const c = cfg();
    const cd = readCooldown();
    return {
      ...notes.summary(),
      forums: c.forums,
      discover: c.discover,
      maxForums: c.maxForums,
      times: c.times,
      autoRun: c.autoRun,
      enabled: c.enabled,
      cooldown: {
        active: remainingMs() > 0,
        until: cd.until || 0,
        reason: cd.reason || '',
        minutesLeft: Math.ceil(remainingMs() / 60_000),
      },
    };
  }

  return {
    popular, scan, read, learn, note, recall, status,
    notes,
    get channel() { return channel() },
    clearCooldown: () => { clearCd(); return { ok: true } },
    trip: (min) => trip(min, '手动熔断'),
    sleep,
  };
}

export { clamp };