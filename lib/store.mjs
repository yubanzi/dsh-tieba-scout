// 笔记库：卡片 + 检索 + 每个吧的学习历史。
//
// 为什么不是「把帖子存下来」：原文是别人的话，几百字一张卡，检索又慢又容易被
// 脏话带偏。这里只存**提炼过的见闻**（一条一张卡，带上吧名和来源 tid 便于回看），
// 聊到相关话题时按二元组命中度捞几条出来当上下文。
import fs from 'node:fs';
import path from 'node:path';
import { sub } from './paths.mjs';

const VERSION = 1;
const MAX_CARDS_HARD = 2000;

export function notesFile() {
  return sub('notes.json');
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const emptyState = () => ({
  version: VERSION,
  cards: [],
  stats: { byForum: {}, forumCursor: 0, rounds: 0, lastRunAt: 0, lastError: '' },
});

export function readNotes() {
  try {
    const j = JSON.parse(fs.readFileSync(notesFile(), 'utf8'));
    return {
      version: j.version ?? VERSION,
      cards: Array.isArray(j.cards) ? j.cards : [],
      stats: { ...emptyState().stats, ...(j.stats ?? {}) },
    };
  } catch {
    return emptyState();
  }
}

export function writeNotes(state) {
  atomicWrite(notesFile(), JSON.stringify(state, null, 1));
  return state;
}

/** 二元组：中文没有空格，用相邻两字当索引就够用，且不必分词 */
export function grams(text) {
  const flat = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const out = new Set();
  for (let i = 0; i < flat.length - 1; i++) out.add(flat.slice(i, i + 2));
  return out;
}

export function createStore({ maxCards = 400 } = {}) {
  const cap = Math.min(Math.max(Number(maxCards) || 400, 20), MAX_CARDS_HARD);

  const store = {
    get state() { return readNotes() },

    /** 写入一张卡；同一 tid + 同一条正文视为重复，只更新时间 */
    add(card, now = Date.now()) {
      const text = String(card?.text ?? '').trim();
      if (!text) throw new Error('卡片正文空着');
      const state = readNotes();
      const tid = String(card.tid ?? '');
      const kw = String(card.kw ?? '').trim();
      const key = `${tid}|${text}`;
      const existing = state.cards.find((c) => `${c.tid}|${c.text}` === key);
      if (existing) {
        existing.learnedAt = now;
        existing.tags = [...new Set([...(existing.tags ?? []), ...(card.tags ?? [])])];
        writeNotes(state);
        return { added: false, card: existing };
      }
      const record = {
        id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        tid,
        kw,
        title: String(card.title ?? '').slice(0, 120),
        text: text.slice(0, 600),
        tags: [...new Set((card.tags ?? []).map((t) => String(t).slice(0, 16)))].slice(0, 6),
        quality: Number(card.quality ?? 0.5),
        learnedAt: now,
      };
      state.cards.push(record);
      prune(state, cap);
      writeNotes(state);
      return { added: true, card: record };
    },

    /** 记一次「这个吧学过了，捞到 N 条」——冷却用 */
    noteAttempt(kw, learned, now = Date.now(), { junkCooldownDays = 7 } = {}) {
      const state = readNotes();
      const key = String(kw ?? '').trim();
      if (!key) return state;
      state.stats.rounds = (Number(state.stats.rounds) || 0) + 1;
      state.stats.lastRunAt = now;
      state.stats.byForum[key] = {
        at: now,
        learned: Number(learned) || 0,
        days: Number(learned) > 0 ? undefined : junkCooldownDays,
      };
      writeNotes(state);
      return state;
    },

    setCursor(cursor) {
      const state = readNotes();
      state.stats.forumCursor = Math.max(0, Number(cursor) || 0);
      writeNotes(state);
      return state;
    },

    setError(message) {
      const state = readNotes();
      state.stats.lastError = String(message ?? '').slice(0, 300);
      writeNotes(state);
      return state;
    },

    /** 冷却表：kw → {at, days} */
    recent(now = Date.now()) {
      const { byForum } = readNotes().stats;
      return new Map(Object.entries(byForum ?? {}).map(([kw, v]) => [kw, { at: Number(v?.at) || 0, days: v?.days }]));
    },

    /**
     * 检索：二元组重合度 / √(卡片长度) —— 长卡片不该因为字多就永远赢。
     * 吧名或标题命中再补一点分。
     */
    recall(query, { limit = 6, minScore = 0.02 } = {}, ) {
      const q = grams(query);
      if (!q.size) return [];
      const cards = readNotes().cards;
      const scored = [];
      for (const card of cards) {
        const body = grams(`${card.title} ${card.text} ${(card.tags ?? []).join(' ')}`);
        if (!body.size) continue;
        let hit = 0;
        for (const g of q) if (body.has(g)) hit += 1;
        if (!hit) continue;
        let score = hit / Math.sqrt(body.size);
        const qLower = String(query).toLowerCase();
        if (card.kw && qLower.includes(String(card.kw).toLowerCase())) score += 0.15;
        if (card.title && qLower.includes(String(card.title).toLowerCase().slice(0, 6))) score += 0.1;
        if (score >= minScore) scored.push({ card, score });
      }
      scored.sort((a, b) => b.score - a.score || (b.card.learnedAt ?? 0) - (a.card.learnedAt ?? 0));
      return scored.slice(0, Math.max(1, limit));
    },

    /** 最近学的卡片 */
    latest(limit = 10) {
      return [...readNotes().cards]
        .sort((a, b) => (b.learnedAt ?? 0) - (a.learnedAt ?? 0))
        .slice(0, Math.max(1, limit));
    },

    summary() {
      const { cards, stats } = readNotes();
      const byForum = {};
      for (const c of cards) if (c.kw) byForum[c.kw] = (byForum[c.kw] ?? 0) + 1;
      return {
        cards: cards.length,
        byForum,
        rounds: Number(stats.rounds) || 0,
        lastRunAt: Number(stats.lastRunAt) || 0,
        cursor: Number(stats.forumCursor) || 0,
        lastError: stats.lastError || '',
        file: notesFile(),
      };
    },
  };

  return store;
}

function prune(state, cap) {
  if (state.cards.length <= cap) return 0;
  state.cards.sort((a, b) => (a.learnedAt ?? 0) - (b.learnedAt ?? 0));
  const drop = state.cards.length - cap;
  state.cards.splice(0, drop);
  return drop;
}

/** 拼成给模型看的上下文块 */
export function notesBlock(hits, { maxChars = 1400 } = {}) {
  const lines = [];
  let used = 0;
  for (const { card } of hits) {
    const tag = card.tags?.length ? `（${card.tags.join('/')}）` : '';
    const line = `· ${card.text}${card.kw ? ` ——${card.kw}吧` : ''}${tag}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}