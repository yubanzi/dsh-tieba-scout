// 重新抓一份真实响应，覆盖 test/fixtures/ 里那几份。
//
// 什么时候要跑：解析测试开始红了、贴吧界面改版、或者想确认签名还活着。
// 抓到之后 `node test/smoke.mjs` 应该全绿；红了就说明接口形状变了，按新形状改 parse.mjs。
//
//   node scripts/capture-fixtures.mjs            # 默认 steam 吧
//   node scripts/capture-fixtures.mjs 影之刃零
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNet } from '../lib/net.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'test', 'fixtures');
const kw = process.argv[2] || 'steam';

const net = createNet({ gapMs: 1200, log: (m) => console.log('·', m) });
const api = net.api;

const write = (name, json) => {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, JSON.stringify(json));
  console.log(`  ${name}  ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
};

console.log(`抓 fixture：${kw} 吧`);

const right = await api('/c/f/pc/homeSidebarRight', { label: '人气榜' });
write('sidebar-right.json', right);

const left = await api('/c/f/pc/homeSidebarLeft', { label: '推荐吧' });
write('sidebar-left.json', left);

const frs = await api('/c/f/frs/page_pc', {
  method: 'POST',
  withTbs: true,
  label: `${kw}吧列表`,
  referer: `https://tieba.baidu.com/f?kw=${encodeURIComponent(kw)}`,
  params: { kw, pn: 1, sort_type: -1, is_newfrs: 1, is_newfeed: 1, rn: 30, rn_need: 10 },
});
// 只留前 8 条：测解析够用，仓库别太胖
if (frs.page_data?.feed_list) frs.page_data.feed_list = frs.page_data.feed_list.slice(0, 8);
write('frs.json', frs);

// 头几条可能是广告/推荐卡片，没有 business_info_map；往后找第一条真帖子。
// 注意形状是 feed_list[].feed.business_info_map（外层还有个 layout）。
const tid = String(
  (frs.page_data?.feed_list ?? [])
    .map((item) => item?.feed?.business_info_map?.thread_id)
    .find((id) => id && /^\d{6,}$/.test(String(id))) ?? '',
);
if (!tid) throw new Error('吧列表里没拿到 tid，换个吧试试');
const pb = await api('/c/f/pb/page_pc', {
  method: 'POST',
  withTbs: true,
  label: `帖子 ${tid}`,
  referer: `https://tieba.baidu.com/p/${tid}`,
  params: { pn: 1, lz: 0, r: 0, mark_type: 0, back: 0, fr: '', kz: tid, session_request_times: 1 },
});
write('pb.json', pb);

console.log(`\n抓完了。跑一下回归：node test/smoke.mjs`);