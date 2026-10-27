// 解析器的回归测试：拿真实响应跑，改版时这里先红。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  parseSidebar, parseForumPage, parseThreadPage,
  pickHotPosts, renderThread, renderForumList, isJunkTitle,
} from '../lib/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', n), 'utf8'));

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

console.log('smoke：真实页面 fixture');

const right = fixture('sidebar-right.json');
const left = fixture('sidebar-left.json');

t('人气榜能解析出吧和热话题', () => {
  const { forums, topics, tabCount } = parseSidebar({ right, left });
  assert.ok(forums.length >= 20, `吧太少：${forums.length}`);
  assert.ok(topics.length === 30, `话题数不对：${topics.length}`);
  assert.ok(tabCount >= 5, 'tab 数不对');
  assert.ok(topics[0].discuss >= topics.at(-1).discuss, '话题没按讨论数排');
});

t('吧按关注数降序', () => {
  const { forums } = parseSidebar({ right, left });
  for (let i = 1; i < forums.length; i++) {
    assert.ok(forums[i - 1].members >= forums[i].members, `${forums[i - 1].kw} 排在了 ${forums[i].kw} 前面`);
  }
});

t('同一吧不会重复出现（人气榜 + 推荐吧合并）', () => {
  const { forums } = parseSidebar({ right, left });
  assert.equal(new Set(forums.map((f) => f.kw)).size, forums.length);
});

t('推荐吧带 desc', () => {
  const { forums } = parseSidebar({ left });
  const withDesc = forums.filter((f) => f.source === 'recom');
  assert.ok(withDesc.length > 0, '没有推荐吧');
  assert.ok(withDesc[0].fid, '推荐吧缺 fid');
});

t('吧列表：回复数取自 feed_social，不是整吧 post_num', () => {
  const page = parseForumPage(fixture('frs.json'));
  assert.ok(page.threads.length > 0, '没解析出帖子');
  assert.ok(page.kw, '没有吧名');
  for (const th of page.threads) {
    assert.ok(th.replies >= 0 && th.replies < 1_000_000, `回复数异常：${th.replies}（像是拿了整吧 post_num）`);
    assert.ok(/^\d{6,}$/.test(th.tid), `tid 异常：${th.tid}`);
    assert.ok(th.title.length > 0, '标题空');
  }
});

t('吧列表渲染成文本', () => {
  const text = renderForumList(parseForumPage(fixture('frs.json')), { limit: 5 });
  assert.match(text, /【贴吧】/);
  assert.match(text, /回复 \d+/);
  assert.ok(text.split('\n').length >= 5);
});

t('楼层：解析出真实楼层号（不是热门回复模块）', () => {
  const thread = parseThreadPage(fixture('pb.json'));
  assert.ok(thread.posts.length > 0, '没解析出楼层');
  assert.ok(thread.tid, '没有 tid');
  const floors = thread.posts.map((p) => p.floor).filter((n) => n > 0);
  assert.ok(floors.length > 0, '楼层号全是 0 —— 又用了 r=2 的热门回复模块');
});

t('楼层：赞数与作者都在', () => {
  const thread = parseThreadPage(fixture('pb.json'));
  const liked = thread.posts.filter((p) => p.agree > 0);
  assert.ok(liked.length > 0, '一个赞都没有，字段可能换了');
  assert.ok(thread.posts.every((p) => p.author), '有楼层没作者');
});

t('高赞楼层排序：赞高的在前，纯水贴被剔掉', () => {
  const thread = parseThreadPage(fixture('pb.json'));
  const hot = pickHotPosts(thread.posts, { limit: 5 });
  assert.ok(hot.length > 0, '没挑出楼层');
  for (let i = 1; i < hot.length; i++) assert.ok(hot[i - 1].heat >= hot[i].heat, '热度没降序');
  assert.ok(hot.every((p) => p.text.length >= 12), '有太短的楼层混进来');
});

t('渲染楼层带楼主、链接、楼层号', () => {
  const text = renderThread(parseThreadPage(fixture('pb.json')), { hotOnly: true, hotLimit: 3 });
  assert.match(text, /https:\/\/tieba\.baidu\.com\/p\/\d+/);
  assert.match(text, /\[\d+楼\]/);
});

t('水贴广告标题被识别', () => {
  assert.equal(isJunkTitle('接单代练任意段位包上分'), true);
  assert.equal(isJunkTitle('影之刃零值得买吗'), false);
  assert.equal(isJunkTitle('UID:12345 出号低价'), true);
});

t('接口报错不是 0 时解析器不炸', () => {
  const bad = { error_code: 110001, error_msg: '未知错误' };
  assert.deepEqual(parseForumPage(bad).threads, []);
  assert.deepEqual(parseThreadPage(bad).posts, []);
  assert.equal(parseSidebar({}).forums.length, 0);
});

console.log(`\nsmoke：${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
if (!pass) process.exitCode = 1;