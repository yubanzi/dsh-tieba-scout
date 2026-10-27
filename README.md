# dsh-tieba-scout

给 [DSH](https://github.com/deepseek-ai) 的贴吧插件：**自己挑人气高的吧，读帖取见闻，提炼成能检索的笔记卡片。**

只读、匿名、零依赖。不发帖、不签到、不关注、不要 BDUSS、不要浏览器。

```
tieba_popular → 今天哪些吧人气高
tieba_scan    → 那个吧在聊什么
tieba_learn   → 读几帖高赞楼层，出素材
tieba_note    → 把素材写成卡片存下来
tieba_recall  → 聊天时按话题翻出来
```

## 和 dsh-tieba-scroll 的区别

两个插件解决的是同一个问题，路子不一样。这个项目是在读了
[Nekomeow114/dsh-tieba-scroll](https://github.com/Nekomeow114/dsh-tieba-scroll) 之后重写的，
**借了它的三个好主意**（fixture 回归、水位式限速、定时 runner），其余是另一套取舍：

| | dsh-tieba-scroll | 本插件 |
|---|---|---|
| 通道 | `curl` 抓手机版 HTML（`/mo/q/m?kw=`） | PC 端 JSON 接口 + 前端同款 md5 签名 |
| 登录 | 需要 BDUSS | **不需要**，匿名访客 |
| 会不会被 403 | 手机版页面常年 403 安全验证 | 接口层验的是签名和 tbs，不是 cookie |
| 选吧 | `bars` 手动填，不填就不知道看谁 | 人气榜自动挑 + 冷却轮转 |
| 写操作 | 签到 / 关注 / 回帖 / 发帖 / 发图（默认关，但代码在） | **一行都没有** |
| 提炼 | 插件内置，跟着宿主模型走 | 拆开：`learn` 只出素材，谁来当大脑都行 |
| 定时 | 峰谷调度 + runner | 定点（默认 12:00 / 22:00）+ runner |
| 依赖 | 若干 | 零（只有 Node 内置模块） |

说清楚谁抄谁：**fixture 回归测试、`round.lock` 的防重入、`cmd /c` 传长 prompt 要落文件**
这三件事是看了它的实现才想到的。反过来，匿名 JSON 接口这条路由、人气榜选吧、
「素材与提炼分离」是这边自己的。

## 装上

```bash
# 从 GitHub 装
dsh plugin --profile web add github:yubanzi/dsh-tieba-scout

# 或者本地开发
dsh plugin --profile web add link:/path/to/dsh-tieba-scout
```

装完重开一次 DSH。`dsh plugin list --profile web` 里应该能看到 `tieba-scout`。

没有任何必填配置——它自己知道该看哪些吧。

## 一轮是怎么走的

```
1. tieba_status          看一眼：多少张卡、熔断没有、上次什么时候学的
2. tieba_learn           不带参数 → 从人气榜挑 2 个吧（跳过最近学过的），读 3 帖
3. （模型读素材，写成卡片）
4. tieba_note  × N       一条一卡
```

第 3 步刻意不在插件里做。插件里没有模型，硬塞一个只会让它绑死某个 provider；
现在这样，谁来跑都行——`dsh` 里的会话、QQ 机器人、headless 定时任务，
用的都是同一个 `tieba_note`。

## 工具

| 工具 | 干什么 |
|---|---|
| `tieba_popular` | 人气榜（按关注数排）+ 全站热话题 + 推荐吧。缓存 30 分钟 |
| `tieba_scan` | 某吧最新帖列表：标题 / 回复数 / 浏览数 / 精品 |
| `tieba_thread` | 读一个帖：首页 + 末页，按赞数挑高赞楼 |
| `tieba_learn` | 跑一轮取素材，返回素材包（**不产生卡片**） |
| `tieba_note` | 存一张卡片（同 tid 同正文不重复存） |
| `tieba_recall` | 按话题检索卡片 |
| `tieba_status` | 状态：卡片数、来源吧、上次学习、熔断、定时 |
| `tieba_settings` | 读/改配置（写回 `config.json`） |

## 让它自己学

配置里打开 `autoRun`，到点（默认 `12:00`、`22:00`）会起一个 headless 子进程，
把 `prompts/duty.md` 交给它跑一轮：

```json
{
  "autoRun": true,
  "times": ["12:00", "22:00"],
  "headlessProfile": "headless"
}
```

子进程的日志在 `$DSH_HOME/tieba-scout/logs/run-YYYY-MM-DD.log`（超长 prompt 会先落成 `prompt-*.md` 再传路径）。
一轮最多 20 分钟，超时会被杀；同一时间只允许一轮（`round.lock`）；
子进程里 `TIEBA_SCOUT_NO_SCHEDULE=1`，不会自己再套一层。

不想让它自己跑就 `"autoRun": false`，聊天里喊一句再学。默认就是关的。

## 配置

`$DSH_HOME/tieba-scout/config.json`

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `forums` | `[]` | 固定要看的吧；留空 = 自己去人气榜挑 |
| `discover` | `true` | 允许自动挑吧 |
| `maxForums` | `2` | 一轮挑几个吧 |
| `maxThreads` | `3` | 每吧读几帖 |
| `pages` | `1` | 每帖读几页 |
| `hotOnly` | `true` | 只取高赞楼（否则全量渲染） |
| `maxPosts` | `12` | 每帖最多几楼 |
| `maxCharsPerPost` | `400` | 每楼截断 |
| `maxCards` | `400` | 卡片上限，超了丢最旧 |
| `maxMaterialChars` | `12000` | 素材包预算 |
| `cooldownDays` | `3` | 学过的吧几天内不再选 |
| `junkCooldownDays` | `7` | 一帖没读成的吧晾几天 |
| `minGapMs` | `1200` | 请求间隔（串行队列） |
| `breakerMin` | `30` | 撞安全验证后静默多久 |
| `autoRun` | `false` | 定时自学 |
| `times` | `["12:00","22:00"]` | 定时点（本地时区） |
| `headlessProfile` | `headless` | 起子进程用的 profile |
| `dshBin` | `""` | `dsh` 路径，留空自动找 |

## 数据在哪

```
$DSH_HOME/tieba-scout/
├── config.json      配置
├── notes.json       卡片 + 每个吧的学习记录（byForum 决定谁被冷却）
├── cooldown.json    熔断状态
├── schedule.json    今天哪几个点已经跑过
├── round.lock       防重入
└── logs/            每一轮的完整输出
```

`notes.json` 是纯文本，可以直接改、可以直接删。删了不影响别的。

## 为什么能匿名读

贴吧 PC 端页面调的是 `/c/f/**` 这套 JSON 接口，参数里带一个 `sign`：

```js
salt = '36770b1f34c9bbf2e7d1a99d2b82fa9e'          // subapp_type=pc 的盐
sign = md5(按 key 排序拼 "k=v" + salt)
```

再带上 `_client_type=20`（PC）和 `/dc/common/tbs` 取的 `tbs`，就齐了。
实测（`test/gates.mjs` 里有这两条真值）：

| 参数 | sign |
|---|---|
| `subapp_type=pc&_client_type=20` | `e9b101df871c39eedcf9a232c2d26ec8` |
| 再带上 `forum_name=steam` | `ea51a9853f6ea10e78bf9bd2f679e6d5` |

几个踩过的坑，写下来省得下一个人再踩：

- **`110001 未知错误` = 签名没算或算错**，不是风控。带全套 cookie 也一样报这个。
- 手机版 `/mo/q/m?kw=` 才是真 403 安全验证——所以别走 HTML 那条路。
- `POST /c/f/pb/page_pc` 的 `r=2` 是「热门回复」模块，**没有楼层号**（`floor` 全是 0）；
  要真楼层用 `r=0`（正序）或 `r=1`（倒序）。
- 吧列表的 `post_num` 是**整个吧的帖子总数**（几千万），不是这帖的回复数；
  回复数在 `feed.components[].feed_social.comment_num` 里。
- `tbs` 是匿名的（`is_login: 0`），可以缓存 10 分钟。

## 礼貌

- 请求全部串行，默认间隔 1.2 秒；
- 撞到 403 / 安全验证 → 落盘熔断 30 分钟，期间一个请求都不发；
- 只读：代码里没有任何写接口，想写也没有；
- 提炼时明确要求不带脏话、地域黑、人身攻击——贴吧的说话方式不是要学的内容。

## 测试

```bash
npm test          # 45 项：fixture 解析 + 纯函数 + 挂载
node scripts/capture-fixtures.mjs [吧名]   # 重新抓真实响应（改版后跑这个）
```

- `test/fixtures/` 是真实响应（人气榜 / 推荐吧 / 吧列表 / 楼层），解析器改坏了会立刻红；
- `test/gates.mjs` 覆盖签名（含两枚真值）、配置归一化、挑吧冷却、卡片去重与检索；
- `test/apply.mjs` 用假 ctx 装一遍插件，确认工具注册和卸载都干净。

## 已知边界

- **楼中楼**没做：只读主楼，`sub_post_number` 只用来判断哪楼热闹。
- **只看首页 + 末页**（`deep`）：中间楼层不读。热帖几百楼时这是有意的取舍。
- **不做图片**：楼层里的图只记数量，不下载、不看。
- **不做搜索**：没有「搜关键词」的接口，只有吧内列表和按热度挑。
- 人气榜只返回**当前 tab** 的名单（切 tab 才现拉），所以榜单是「涨粉最多」那一维。

## 许可

MIT。参考项目的思路照抄不了代码，但思路本身值得写清楚来源，见上面的对比表。