// 纯函数测试：签名、配置、人气挑选、笔记库。全部离线，不联网。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tieba-scout-test-'));
process.env.DSH_HOME = HOME;

const { signOf, signText, signRequest, SALT_PC } = await import('../lib/sign.mjs');
const { normalize, DEFAULTS } = await import('../lib/config.mjs');
const { pickForums, mergeCandidates } = await import('../lib/discover.mjs');
const { createStore, grams, readNotes, notesBlock } = await import('../lib/store.mjs');

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

console.log('gates：纯函数');

// ── 签名 ──────────────────────────────────────────────────────────────────
t('签名与线上抓到的两枚真值一致', () => {
  assert.equal(signOf({ subapp_type: 'pc', _client_type: 20 }), 'e9b101df871c39eedcf9a232c2d26ec8');
  assert.equal(
    signOf({ subapp_type: 'pc', _client_type: 20, forum_name: 'steam' }),
    'ea51a9853f6ea10e78bf9bd2f679e6d5',
  );
});

t('签名与键的书写顺序无关', () => {
  assert.equal(signOf({ b: '2', a: '1' }), signOf({ a: '1', b: '2' }));
});

t('空值被剔掉（否则签出来的串和服务器算的不一样）', () => {
  assert.equal(signText({ a: '1', b: undefined }, 'X'), 'a=1X');
  assert.equal(signText({ a: '1', b: null }, 'X'), 'a=1X');
});

t('signRequest 自动补 PC 公共参数', () => {
  const r = signRequest({ kw: 'steam' });
  assert.equal(r.subapp_type, 'pc');
  assert.equal(r._client_type, 20);
  assert.ok(/^[0-9a-f]{32}$/.test(r.sign));
});

t('signRequest 不会把 sign 自己算进去', () => {
  const a = signRequest({ kw: 'steam' });
  const b = signRequest({ kw: 'steam', sign: 'deadbeef' });
  assert.equal(a.sign, b.sign);
});

t('app 端盐和 PC 端盐算出不同结果', () => {
  const expect = createHash('md5').update('a=1tiebaclient!!!').digest('hex');
  assert.equal(signOf({ a: '1' }, 'tiebaclient!!!'), expect);
  assert.notEqual(signOf({ a: '1' }), expect);
});

t('PC 盐没写错', () => {
  assert.equal(SALT_PC, '36770b1f34c9bbf2e7d1a99d2b82fa9e');
});

// ── 配置 ──────────────────────────────────────────────────────────────────
t('默认就是「自己挑人气高的」', () => {
  const c = normalize({});
  assert.deepEqual(c.forums, []);
  assert.equal(c.discover, true);
  assert.ok(c.maxForums >= 1);
  assert.deepEqual(c.times, DEFAULTS.times);
});

t('bar 名单能接受字符串/数组/换行', () => {
  assert.deepEqual(normalize({ forums: 'steam, bilibili\n原神' }).forums, ['steam', 'bilibili', '原神']);
  assert.deepEqual(normalize({ forums: ['a', ' a ', 'b'] }).forums, ['a', 'b']);
});

t('时间归一化：非法丢弃，合法补零排序', () => {
  assert.deepEqual(normalize({ times: ['9:05', '22:00', '25:00', 'x'] }).times, ['09:05', '22:00']);
});

t('数值越界会被夹住', () => {
  const c = normalize({ maxForums: 99, maxThreads: 0, minGapMs: 1, breakerMin: 9999 });
  assert.equal(c.maxForums, 6);
  assert.equal(c.maxThreads, 1);
  assert.equal(c.minGapMs, 200);
  assert.equal(c.breakerMin, 720);
});

// ── 人气挑选 ──────────────────────────────────────────────────────────────
const mk = (kw, members) => ({ kw, members });
const POOL = [mk('孙笑川', 7900000), mk('抗压背锅', 6100000), mk('steam', 4800000), mk('bilibili', 4800000), mk('吊图', 2000000), mk('影之刃零', 18000)];

t('按关注数挑，小吧排不上', () => {
  const { picked } = pickForums(POOL, { count: 2, cursor: 0 });
  assert.deepEqual(picked.map((p) => p.kw), ['孙笑川', '抗压背锅']);
});

t('cursor 轮转，不会永远霸榜', () => {
  const first = pickForums(POOL, { count: 2, cursor: 0 });
  const second = pickForums(POOL, { count: 2, cursor: first.cursor });
  const third = pickForums(POOL, { count: 2, cursor: second.cursor });
  const all = new Set([...first.picked, ...second.picked, ...third.picked].map((p) => p.kw));
  assert.ok(all.size >= 3, `三轮只覆盖了 ${all.size} 个吧`);
});

t('冷却期内的吧被跳过', () => {
  const recent = new Map([['孙笑川', { at: Date.now() }]]);
  const { picked } = pickForums(POOL, { count: 2, cursor: 0, recent });
  assert.ok(!picked.some((p) => p.kw === '孙笑川'), '冷却失效');
});

t('冷却按天算，过期的能重新选', () => {
  const recent = new Map([['孙笑川', { at: Date.now() - 4 * 86400_000, days: 3 }]]);
  const { picked } = pickForums(POOL, { count: 2, cursor: 0, recent });
  assert.ok(picked.some((p) => p.kw === '孙笑川'), '过冷却期还被挡');
});

t('一帖没读成的吧晾得更久（junkCooldownDays）', () => {
  const recent = new Map([['孙笑川', { at: Date.now() - 4 * 86400_000, days: 7 }]]);
  const { picked } = pickForums(POOL, { count: 2, cursor: 0, recent });
  assert.ok(!picked.some((p) => p.kw === '孙笑川'), '7 天冷却没生效');
});

t('全都冷却时也不空手（退一步继续挑）', () => {
  const recent = new Map(POOL.map((p) => [p.kw, { at: Date.now(), days: 99 }]));
  const { picked } = pickForums(POOL, { count: 2, cursor: 0, recent });
  assert.equal(picked.length, 2);
});

t('候选合并去重，保留关注数大的', () => {
  const merged = mergeCandidates([mk('steam', 100)], [mk('steam', 900), mk('bilibili', 50)]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((m) => m.kw === 'steam').members, 900);
});

t('空候选不炸', () => {
  assert.deepEqual(pickForums([], { count: 2 }).picked, []);
});

// ── 笔记库 ────────────────────────────────────────────────────────────────
t('中文二元组', () => {
  const g = grams('影之刃零');
  assert.ok(g.has('影之'));
  assert.ok(g.has('之刃'));
  assert.equal(grams('').size, 0);
});

t('写卡、去重、检索', () => {
  const store = createStore({ maxCards: 50 });
  const a = store.add({ tid: '1', kw: 'steam', title: '影之刃零评分', text: '影之刃零 ign 给了 9 分，国产单机里少见。', tags: ['游戏', '评分'] });
  assert.equal(a.added, true);
  const dup = store.add({ tid: '1', kw: 'steam', title: '影之刃零评分', text: '影之刃零 ign 给了 9 分，国产单机里少见。', tags: ['评分', '动作'] });
  assert.equal(dup.added, false, '相同正文应判重');
  assert.deepEqual(dup.card.tags.sort(), ['动作', '游戏', '评分'].sort());

  const hits = store.recall('影之刃 评分', { limit: 3 });
  assert.ok(hits.length >= 1, '检索不到');
  assert.equal(hits[0].card.tid, '1');
});

t('检索：不相关的话题不返回', () => {
  const store = createStore({ maxCards: 50 });
  store.add({ tid: '2', kw: 'bilibili', title: '舰R', text: '舰r 的铃兰活动结束了。', tags: ['二次元'] });
  const hits = store.recall('显卡驱动怎么装', { limit: 3 });
  assert.equal(hits.length, 0);
});

t('卡片上限：超了丢最旧的', () => {
  const store = createStore({ maxCards: 20 });
  for (let i = 0; i < 25; i++) {
    store.add({ tid: String(1000 + i), kw: 'steam', title: `帖${i}`, text: `第 ${i} 条互不相同的见闻内容测试。` }, Date.now() + i * 1000);
  }
  const { cards } = readNotes();
  assert.equal(cards.length, 20);
  assert.ok(!cards.some((c) => c.title === '帖0'), '最旧的没被丢');
});

t('学习记录带冷却天数', () => {
  const store = createStore({ maxCards: 20 });
  store.noteAttempt('孙笑川', 0, Date.now(), { junkCooldownDays: 7 });
  store.noteAttempt('steam', 2, Date.now());
  const recent = store.recent();
  assert.equal(recent.get('孙笑川').days, 7);
  assert.equal(recent.get('steam').days, undefined);
});

t('笔记块按预算拼接', () => {
  const block = notesBlock([{ card: { text: '一句话', kw: 'steam', tags: [] } }]);
  assert.match(block, /一句话/);
  assert.match(block, /steam/);
});

t('空正文拒绝入库', () => {
  const store = createStore({ maxCards: 20 });
  assert.throws(() => store.add({ text: '   ' }), /空/);
});

console.log(`\ngates：${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
if (!pass) process.exitCode = 1;