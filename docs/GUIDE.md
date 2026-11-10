# 进阶指南

README 里只有部署三步，这里放其余内容：更新、排错、Fork 路线、自定义与原理。用到哪节看哪节。

## 页面功能

- **速查表**：先选组织层级（Free / Build / Launch / Grow），34 个模型按 5 个任务分组（通用主力 / 深度推理 / 编程专用 / 视觉与长文 / 轻量高速），每个一键复制、整组复制、支持搜索
- **额度随层级切换**：旗舰池 / 小型池每日免费量（Build 25 万 · 250 万；Launch / Grow 100 万 · 1,000 万；Free 不在计划内为 0），含 UTC 00:00 重置倒计时和「去哪查自己层级」的路径
- **状态标记**：新锐 / 落幕（关停日期、剩余天数、官方接班人）/ 已关停
- **使用指南**：资格自查、四层级对照表、开启步骤、规则与坑（同池共享、超额整单计费、工具调用不覆盖、免费与 Fast 加速二选一）、落幕迁移表、FAQ
- 深浅双主题（浅色 OpenAI 黑白灰 / 深色 Tokyo Night），手机端适配

## 如何更新到新版

部署按钮生成的是你账号下的**独立副本**（不是 GitHub fork），不会自动跟随上游。上游更新后任选一种方式更新一次：

- **别再点部署按钮**——会新建一整套 Worker 和 KV，不是更新
- 更新只换代码，**不会动你 KV 里已同步的数据**

**方式一：同步 Action（推荐，不用命令行）**

副本不包含 `.github/workflows/` 里的任何文件（平台限制：工作流文件只能由仓库主人亲自放，实测确认），所以先手动放一次模板：

1. 打开**你副本仓库** → **Add file → Create new file**
2. 文件名填 `.github/workflows/sync-upstream.yml`
3. 把副本里 `docs/sync-upstream.yml` 的内容整段粘贴进去，提交

之后每次更新：副本 **Actions** 页 → **Sync from upstream** → **Run workflow**（它也会每周一自动跑一次）。同步时保留你副本 `wrangler.jsonc` 里回填的 KV id；若你改过副本文件、与上游撞车，它会停下不乱推，改用方式二。

**方式二：命令行**

```bash
git remote add upstream https://github.com/piscon/openai-free-models.git
git pull upstream main   # 有冲突按提示解决，注意保留 wrangler.jsonc 里的 KV id
git push                 # 推送后自动重新部署，1–2 分钟生效
```

## 路线 B：先 Fork，再手动连接

适合想用 GitHub 的 Sync fork 更新的人：

1. **Fork** 本仓库到你的账号
2. 在 fork 里打开 `wrangler.jsonc`：先去 Cloudflare 控制台 *Storage & Databases → KV* 建一个命名空间，把 id 填进 `kv_namespaces`
3. 控制台 → *Workers → Create → Import a repository*，选你的 fork 导入部署；同样要去 *Settings → Domains & Routes* 开启 workers.dev 地址
4. 以后更新：fork 仓库页点 **Sync fork → Update branch**，自动重新部署

## 部署排错

**地址打不开**：部署成功 ≠ 地址已开启。Worker → *Settings → Domains & Routes* 里 workers.dev 必须是 **Enabled**（README 第 2 步）。

**构建在最后一步失败，报 `code: 10072` / "reached the Workers Free limit of 5 cron triggers"**：
免费版的账号级上限：整个账号所有 Worker 合计最多 5 个 Cron 触发器，本项目占 1 个。报错只卡在挂定时任务一步，页面本身通常已经部署成功。解决任选其一：

1. **腾名额（推荐）**：删掉不用的 Worker（或打开它 *Settings → Triggers* 删掉其 Cron），再回到本 Worker → *Settings → Triggers → Add Cron Trigger* 填 `17 3 * * *` 手动挂上，不用重新部署
2. **不要自动同步**：在副本 `wrangler.jsonc` 里删掉 `triggers` 整段再部署，页面退化为纯静态种子数据
3. 升级 Workers Paid 可提高上限，为这个项目没必要

注意：每多部署一个测试实例就多占 1 个名额，测完记得删。正常状态下 Triggers 里应能看到一条 `17 3 * * *`（每天 UTC 03:17）。

## 数据怎么保持新鲜（设计要点）

- **关停信息自动同步**：Worker 带 Cron 定时任务（默认每天 UTC 03:17），抓取 [OpenAI 官方下架页](https://developers.openai.com/api/docs/deprecations) 解析关停日期与接班人，写入 KV；带三道闸：距上次尝试不足 20 小时跳过、内容没变化（ETag + 哈希）不写库、解析异常放弃本次更新保留旧数据
- **前台没有任何触发抓取的入口**：没有刷新按钮、接口或参数。站点是公开的，访客可触发的抓取会把免费额度（KV 免费版 1,000 次写/天）刷光，这是刻意的设计
- **层级定义自动同步**：层级的到达门槛与月用量上限由官方 Rate limits 指南写明，Worker 在同一次定时任务里抓取该页的层级表解析更新（与关停信息同一套三道闸）；各层级的免费额度数字是计划参数、只写在帮助文章里，随种子走
- **名单与额度用种子数据**：官方帮助文章对程序抓取返回 403，无法可靠机读，所以名单放在 `data/models.json` 里人工核实更新（页面标注「核实于」日期）。真有变化时改种子并重新部署，改完运行 `npm run seed:sync` 同步前端副本
- 全部运行在 Cloudflare 免费额度内：页面是静态资源（免费不限量），每天只有 1 次定时抓取

## 自定义

- **改抓取频率/时间**：改 `wrangler.jsonc` 的 `triggers.crons`（cron 表达式，UTC）
- **改 Worker 名字**：改 `wrangler.jsonc` 的 `name`（部署前改；已部署后改名等于新建）
- **改名单数据**：编辑 `data/models.json`（`taskGroups` 五组、`tiers` 四层级、`pools` 两池、`verifiedAt` 核实日期），然后 `npm run seed:sync`
- **关掉自动同步**：删掉 `wrangler.jsonc` 的 `triggers` 段

## 本地开发

```bash
npm install
npm test          # 解析器自带夹具测试
node test/parse.test.mjs /path/to/deprecations.html   # 用真实下架页全文回归
npm run dev       # wrangler dev 本地预览
npm run deploy    # 手动部署（需要你自己的 Cloudflare 账号与 KV id）
```

手动部署先建 KV：`npx wrangler kv namespace create MODELS_KV`，把得到的 id 填回 `wrangler.jsonc`。

## 数据来源

- 免费名单与各层级额度：[OpenAI 帮助文章 · 数据共享计划](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai)（种子核实于 2026-11-10）
- 层级定义（Free / Build / Launch / Grow 的门槛与月用量上限）：[OpenAI 开发者文档 · Rate limits（Usage tiers）](https://developers.openai.com/api/docs/guides/rate-limits)
- 关停日期与接班人：[OpenAI 官方 Deprecations 页](https://developers.openai.com/api/docs/deprecations)
