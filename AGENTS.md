# 给改这个仓库的人（以及 AI）

## 这个仓库是什么

DSH 插件，给一个机器人当「贴吧的眼睛」。核心只有一件事：
**把贴吧的帖子变成几十字、能检索、带出处的卡片。**

不写、不登录、不碰浏览器。这三条是设计约束，不是还没做。

## 目录

```
index.js              插件主机半端：8 个工具 + 定时器（约 250 行，看这一个就懂全貌）
lib/
  sign.mjs            签名（md5 排序拼串 + 盐）；三个盐 + PC 的 _client_type
  net.mjs             通道：串行队列、限速、tbs 缓存、熔断（落盘）
  parse.mjs           三种响应 → 结构；高赞挑选；渲染成文本
  discover.mjs        从人气榜候选里挑这一轮看谁（纯函数，好测）
  store.mjs           卡片库：写入 / 去重 / 检索（中文二元组）/ 裁剪
  config.mjs          config.json 的默认值与归一化
  scout.mjs           把上面几块拼成一个对象，供 index.js 和外部调用
  runner.mjs          定时一轮：起 headless 子进程 + 锁 + 超时 + 日志
  toolkit.mjs         defineTool 的取法（宿主给了就用，没给就兜底）
prompts/duty.md       定时那一轮的说明（会原样塞给子进程）
test/                 fixture 回归 / 纯函数 / 挂载
scripts/capture-fixtures.mjs   重新抓真实响应
```

## 改动时的硬规矩

1. **别加写操作。** 没有签到、没有回帖。想加的话先想清楚这是不是另一个项目。
2. **别把 `webServer` 写进 `inject`。** headless 里没有这个服务，写进去整个插件会 pending。
   要挂路由用 `ctx.inject(['webServer'], ...)` 或轮询 `ctx.get('webServer')`。
3. **`sign` 算错会返回 `110001`，那不是风控。** 熔断只认 403 / 安全验证，
   别把签名错误也当成被封，否则调一次参数就自我封禁 30 分钟。
4. **`r=2` 不要用。** 那是「热门回复」模块，楼层号全是 0。要楼层用 `r=0`。
5. **改解析就一定要跑 `npm test`。** fixture 是真实响应，红了说明接口形状变了。
   形状真变了：改 `parse.mjs`，再 `node scripts/capture-fixtures.mjs` 更新 fixture。
6. **注释用中文，提交信息用英文。**

## 加一个工具

```js
tool({
  name: 'tieba_xxx',
  description: '给模型看的：什么时候该调它、返回什么。写清楚场景，别写实现。',
  parameters: { kw: { type: 'string', description: '吧名', required: true } },
  execute: async (args) => ({ ... }),   // 返回对象，不是 JSON 字符串
});
```

`execute` 返回的必须是对象（宿主的 `output.schema` 是 object，字符串会校验失败）。
抛错就让它抛——包装层会记日志。

## 加一条测试

- 纯逻辑 → `test/gates.mjs`，`t('名字', () => { ... })`，一行断言一件事；
- 依赖真实响应 → 放 fixture 到 `test/fixtures/`，在 `test/smoke.mjs` 里断言；
- 插件装配 → `test/apply.mjs`。

`t()` 是同步的：要断言异步结果，先 `await` 出来再断言。

## 提交前

```bash
npm test
```

45 项全绿再提交。测试跑不动（网络/环境）说明改坏了什么，不是测试的问题。