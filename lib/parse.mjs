// 解析层：只做纯函数，不联网。
//
// 全部按 2026-10-27 抓到的真实响应结构写（见 test/fixtures/）。
// 贴吧改版时这些函数会先失败——测试里有 fixture 兜着，比线上炸了才发现好。

const toNum = (v, dflt = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

const clean = (s) => String(s ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/\r/g, '')
  .replace(/[ \t]+/g, ' ')
  .trim();

/** 水楼 / 广告 / 交易贴：标题命中就别浪费提炼额度 */
const JUNK = /陪玩|陪打|代练|代打|代肝|收号|出号|卖号|账号交易|号商|接单|接任意|任意段位|包上分|包月|低价出|出租|引流|加群|广告位|秒进|私信我|找老板/i;

export const isJunkTitle = (title) => JUNK.test(String(title ?? ''));

/**
 * 首页侧栏：人气榜 + 热话题 + 推荐吧。
 * - `right` = /c/f/pc/homeSidebarRight 的 JSON
 * - `left`  = /c/f/pc/homeSidebarLeft 的 JSON
 *
 * 只有「当前 tab」的 forum_list 有内容（其余 tab 是空数组），
 * 所以不要按 tab 逐个取，直接把有内容的那些摊平。
 */
export function parseSidebar({ right, left } = {}) {
  const forums = [];
  const seen = new Set();
  const topics = [];

  const data = right?.data ?? {};
  const tabs = Array.isArray(data?.forum_bang?.tab_list) ? data.forum_bang.tab_list : [];

  const push = (item, source, extra = {}) => {
    const kw = String(item?.forum_name ?? item?.name ?? '').trim();
    if (!kw || seen.has(kw)) return;
    seen.add(kw);
    forums.push({
      kw,
      fid: String(item?.forum_id ?? item?.id ?? ''),
      members: toNum(item?.member_count ?? item?.member_num),
      score: String(item?.score_desc ?? ''),
      hotThread: item?.hot_thread?.title ? {
        tid: String(item.hot_thread.thread_id ?? ''),
        title: String(item.hot_thread.title ?? ''),
      } : null,
      source,
      ...extra,
    });
  };

  for (const tab of tabs) {
    const label = String(tab?.name ?? '');
    for (const item of Array.isArray(tab?.forum_list) ? tab.forum_list : []) {
      push(item, 'rank', { tab: label, sortRule: String(tab?.sort_rule ?? '') });
    }
  }

  for (const item of Array.isArray(data?.hot_topic_list) ? data.hot_topic_list : []) {
    const title = String(item?.topic_name ?? '').trim();
    if (!title) continue;
    topics.push({
      id: String(item?.topic_id ?? ''),
      title,
      discuss: toNum(item?.discuss_num),
      tag: toNum(item?.tag),
    });
  }
  topics.sort((a, b) => b.discuss - a.discuss);

  for (const item of Array.isArray(left?.data?.recom_forum_list) ? left.data.recom_forum_list : []) {
    push(item, 'recom', { desc: clean(item?.desc).slice(0, 60) });
  }

  forums.sort((a, b) => b.members - a.members);
  return {
    forums,
    topics,
    tabCount: tabs.length,
    currentTab: String(data?.forum_bang?.current_tab_code ?? ''),
  };
}

/**
 * 吧内帖子列表：POST /c/f/frs/page_pc。
 * 回复数只在 `feed.components[].feed_social.comment_num`；
 * `business_info_map.post_num` 是**整个吧**的帖子数（七千万级），拿它当回复数会全错。
 */
export function parseForumPage(json) {
  const feeds = Array.isArray(json?.page_data?.feed_list) ? json.page_data.feed_list : [];
  const threads = [];
  const seen = new Set();

  for (const item of feeds) {
    const feed = item?.feed ?? {};
    const map = feed?.business_info_map;
    if (!map?.thread_id || seen.has(String(map.thread_id))) continue;
    seen.add(String(map.thread_id));
    const social = (Array.isArray(feed.components) ? feed.components : [])
      .map((c) => c?.feed_social)
      .find(Boolean);
    threads.push({
      tid: String(map.thread_id),
      title: clean(map.title),
      abstract: clean(map.abstract),
      views: toNum(map.view_num),
      replies: toNum(social?.comment_num),
      isGood: String(map.is_good ?? '0') === '1',
      author: String(map.author_name ?? map.user_name ?? ''),
      createdAt: toNum(map.create_time) * 1000,
      pics: toNum(map.pic_count),
    });
  }

  return {
    kw: String(json?.forum?.name ?? '').trim(),
    members: toNum(json?.forum?.user_num ?? json?.forum?.member_num),
    threadNum: toNum(json?.forum?.thread_num),
    page: toNum(json?.page?.current_page, 1),
    totalPage: toNum(json?.page?.total_page, 1),
    threads,
  };
}

/** 把楼层 content 数组拆成「正文 + 图片」 */
function splitContent(content) {
  const parts = [];
  const images = [];
  for (const node of Array.isArray(content) ? content : []) {
    if (!node || typeof node !== 'object') continue;
    if (node.text) parts.push(String(node.text));
    for (const key of ['cdn_src', 'big_cdn_src', 'origin_src', 'src']) {
      const v = node[key];
      if (typeof v === 'string' && /^https?:\/\//.test(v)) {
        if (!/\/editor\/images\/|image_emoticon/.test(v) && !images.includes(v)) images.push(v);
        break;
      }
    }
    for (const sub of Array.isArray(node.sub) ? node.sub : []) {
      if (sub?.text) parts.push(String(sub.text));
    }
  }
  return { text: clean(parts.join(' ')), images };
}

/** 帖子楼层：POST /c/f/pb/page_pc */
export function parseThreadPage(json) {
  const thread = json?.thread ?? {};
  const users = new Map();
  for (const u of Array.isArray(json?.user_list) ? json.user_list : []) {
    const id = String(u?.id ?? u?.user_id ?? '');
    if (id) users.set(id, String(u?.name ?? u?.name_show ?? u?.show_nickname ?? '').trim());
  }

  const posts = [];
  for (const post of Array.isArray(json?.post_list) ? json.post_list : []) {
    const { text, images } = splitContent(post?.content);
    const uid = String(post?.author_id ?? '');
    const subPosts = Array.isArray(post?.sub_post_list)
      ? post.sub_post_list.map((s) => clean(s?.content)).filter(Boolean)
      : [];
    if (!text && !images.length && !subPosts.length) continue;
    posts.push({
      pid: String(post?.id ?? ''),
      floor: toNum(post?.floor),
      uid,
      author: users.get(uid) || (uid ? `用户${uid}` : '匿名'),
      time: toNum(post?.time) * 1000,
      text,
      images,
      agree: toNum(post?.agree?.agree_num),
      subCount: toNum(post?.sub_post_number),
      subPosts,
    });
  }

  return {
    tid: String(thread.id ?? ''),
    title: clean(thread.title),
    forum: String(json?.forum?.name ?? ''),
    author: String(thread.author?.name ?? ''),
    replyNum: toNum(thread.reply_num),
    agreeNum: toNum(thread.agree_num),
    createdAt: toNum(thread.create_time) * 1000,
    isGood: Boolean(thread.is_excellent_thread),
    page: toNum(json?.page?.current_page, 1),
    totalPage: toNum(json?.page?.total_page, 1),
    posts,
  };
}

/** 按赞数挑「值得学」的楼层：赞高、字够长、不是纯表情 */
export function pickHotPosts(posts, { limit = 6, minChars = 12 } = {}) {
  return posts
    .filter((p) => p.text.length >= minChars)
    .filter((p) => !/^(?:[0-9+]{1,3}|cy|插眼|顶|前排|沙发|打卡|签到)$/i.test(p.text.trim()))
    .map((p) => ({ ...p, heat: p.agree * 2 + p.subCount + (p.text.length >= 40 ? 1 : 0) }))
    .sort((a, b) => b.heat - a.heat)
    .slice(0, limit);
}

const clamp = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 渲染帖子列表（给模型看） */
export function renderForumList(data, { limit = 20 } = {}) {
  const lines = [
    `【贴吧】${data.kw || '未知吧'}｜${data.threads.length} 帖`
      + (data.members ? `｜关注 ${data.members}` : ''),
  ];
  for (const t of data.threads.slice(0, limit)) {
    const flag = t.isGood ? '（精品）' : '';
    lines.push(`- ${t.tid}｜${clamp(t.title, 60)}${flag}｜回复 ${t.replies}｜浏览 ${t.views}`);
    if (t.abstract) lines.push(`  ${clamp(t.abstract, 110)}`);
  }
  return lines.join('\n');
}

/** 渲染楼层正文（给模型看） */
export function renderThread(data, { maxPosts = 12, maxChars = 400, hotOnly = false, hotLimit = 6 } = {}) {
  const list = hotOnly ? pickHotPosts(data.posts, { limit: hotLimit }) : data.posts.slice(0, maxPosts);
  const lines = [
    `【贴吧】${data.forum || '未知吧'} · ${data.title}`,
    `楼主：${data.author || '未知'}｜回复 ${data.replyNum}｜https://tieba.baidu.com/p/${data.tid}`,
  ];
  for (const p of list) {
    lines.push('');
    lines.push(`[${p.floor}楼] ${p.author}${p.agree ? ` 赞${p.agree}` : ''}${p.subCount ? ` 楼中楼${p.subCount}` : ''}`);
    if (p.text) lines.push(clamp(p.text, maxChars));
    if (p.images.length) lines.push(`（配图 ${p.images.length} 张）`);
    for (const s of p.subPosts.slice(0, 3)) lines.push(`  ↳ ${clamp(s, 200)}`);
  }
  return lines.join('\n');
}