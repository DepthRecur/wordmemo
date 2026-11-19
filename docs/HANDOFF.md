# 交接文档（给下一个会话 / 未来的自己）

> 最后更新：2026-11-19　当前分支：`master`（`feat/decks` 已合并）　仓库：`DepthRecur/wordmemo`
> **推送状态**：`origin` 已配置为 `https://github.com/DepthRecur/wordmemo.git`，但本机访问 github.com 超时（无代理），**尚未 push**；网络可用后执行 `git push -u origin master feat/decks` 即可。
> 这份文档的目的：**新会话读完它就能直接干活**，不需要重新讨论已经定过的事，也不需要重新调研。

---

## 0. 一句话现状

背单词桌面应用（Electron 38 + React 19 + `node:sqlite` + `ts-fsrs`）已可用。四个功能的顺序是：**多供应商 → 多个库 → 便携版自更新 → 云端同步**。前两个已完成：
- **多供应商**（2026-11-18 ~ 19，已冻结）：四家可配 Key、角色路由、设置页、模型目录/价格、`npm run ai-smoke`；DeepSeek/GLM 真机验证，OpenAI/Gemini 等社区反馈。
- **多个库**（2026-11-19，已合并 master）：`decks` 表 + `notes.deck_id` + 默认库迁移（迁移前备份）、全部查询按库作用域、笔记库批量 UI、今日任务/导入/考试/统计/托盘全部接库；后续打磨：删批量撤销、切库性能（10~30ms）、今日任务标题右侧库下拉、原生 select 全换自定义圆角下拉。`npm test` 12 文件 118 项全绿。实现记录见 [PLAN-DECKS §15](PLAN-DECKS.md)。

下一个功能是**便携版 + 自更新**（[PLAN-UPDATE](PLAN-UPDATE.md) §3.11 是定稿方案）。

---

## 1. 五分钟上手

```powershell
cd D:\ymh\Code\tools\wordmemo
npm install          # 只有删过 node_modules 才需要
npm run typecheck    # tsc --noEmit，必须 0 错误
npm test             # vitest，12 个测试文件（118 项）必须全绿
npm run dev          # 开发模式启动（脚本已带 --noSandbox）
```

- **`npm test` 报 `spawn EPERM`**：说明你处在受限沙箱里（esbuild 要 spawn 命名管道）。**在普通 PowerShell / CMD 里跑**就没问题。
- 只跑一个测试：`npx vitest run tests/providers.test.ts`
- 打包（现在还用不到）：`npm run dist` → `release/`
- 应用是单实例的：改完代码要先真退出（托盘右键 → 退出），再重新启动，否则加载的还是旧代码。
- **手动启动主进程**（真机冒烟用）：`Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; .\node_modules\electron\dist\electron.exe . --no-sandbox`。环境里若留着 `ELECTRON_RUN_AS_NODE=1`（DSH 这类工具会设），Electron 会被当成 node 跑，报 `Cannot read properties of undefined (reading 'isPackaged')`。

---

## 2. 已定决策（**不要再讨论、不要改**）

| 项 | 结论 |
|---|---|
| 许可证 | **MIT**（`LICENSE` 已在根目录）。AGPL/GPL 代码**永远只读** |
| 供应商 | 只做 **DeepSeek / OpenAI / Gemini / GLM**；不做通义/豆包/Kimi/文心/混元；**不做自定义端点** |
| 多供应商实现 | **不装 pi-ai**；自写薄适配层。依赖必须为 0 新增运行时依赖 |
| 模型名/价格 | **不写死**：模型走 `/models`，价格走 models.dev（快照 + 刷新），未知显示「费用未知」 |
| 多个库 | 方案 A：库 = 笔记容器 + 学习范围；进度跟单词走；每库一份每日新词额度；复制笔记**不复制进度** |
| 分发 | **便携版 zip**；启动器换目录；**不做 NSIS、不做代码签名**、不用 electron-updater |
| 更新 | 应用只下载 + 校验；启动器只换目录；用户手动覆盖 `app/` 是同一份 zip（兜底） |
| 同步 | 只同步结构化数据；**图片/文件永久不同步**；`.wmsync` 快照导出/导入做 |
| 同步密钥 | **用户口令**（age passphrase）+ `kdfVerifier` 防错 + 强度条；**没有恢复密钥** |
| 托盘 | 只统计**当前库** |
| 其他 | DCO（不要 CLA）；数据目录 `%APPDATA%\WordMemo`；`--no-sandbox` 探测式降级 |

---

## 3. 文档地图（按这个顺序读）

| 文档 | 什么时候读 |
|---|---|
| **本文 HANDOFF.md** | 每次新会话第一份 |
| [PLAN-NEXT.md](PLAN-NEXT.md) | 排序、共同约束、**已定/待定清单**、**坑点清单（§7）**、验证条件（§9） |
| [PLAN-PROVIDERS.md](PLAN-PROVIDERS.md) | 做多供应商时；**§13 是当前实现记录与下一步** |
| [PLAN-DECKS.md](PLAN-DECKS.md) | 做多个库时 |
| [PLAN-UPDATE.md](PLAN-UPDATE.md) | 做便携版/自更新时（§3.11 是定稿方案） |
| [PLAN-SYNC.md](PLAN-SYNC.md) | 做同步时（§3.5 口令加密、S0 重放验证） |
| [RESEARCH-REUSE.md](RESEARCH-REUSE.md) | 想知道「为什么这么选」时；**不需要重新调研** |

---

## 4. 代码地图（当前状态）

```
src/main/ai/
  providers.ts     ← 四家的声明式描述（端点/compat/能力位/unverified/modelsConfig），无 if(provider)
  transport.ts     ← buildChatBody / parseChatResponse / normalizeHttpError / requestChat
  client.ts        ← 角色路由（default/vision）+ 按家取 Key + 400 降级重试 + 预算
  catalog.ts       ← /models + ai_catalog 缓存 + TTL 24h + 单飞 + 失败保留旧列表
  pricing.ts       ← 远程 models.dev → 随包快照 → 未知（priced:false）
  pricing-snapshot.json ← gen-pricing.mjs 生成，15.9 KB / 110 个模型
  info.ts          ← 设置页只读视图（避开 catalog ↔ client 循环）
  smoke.ts         ← npm run ai-smoke 的 4 调用点 × 4 家自检
  import.ts        ← 7 个调用点里的 OCR/结构化/校验/补搭配/音标（OCR 走 vision 角色）
  prompts.ts       ← 提示词，不动
src/main/settings.ts ← settings.ai 深合并 + secrets.v2.json（多 Key，safeStorage 整份加密）
src/main/db/
  schema.ts        ← 表结构（decks / notes.deck_id / import_drafts.deck_id；SCHEMA_VERSION）
  connection.ts    ← migrate()：补列 + migrateDecks（默认库/回填）+ backupBeforeMigrate()
  decks.ts         ← 库 CRUD、每库计数、deckNewPerDay、deckScope/deckInClause、currentDeckId
  notes.ts         ← 笔记增删改查 + moveNotes/copyNotes/deleteNotes（不做撤销）
  items.ts / cards.ts ← learnQueue/dueQueue/countDue/dailyPlan/learnedTodayCount 都接 deckId
  stats.ts         ← dashboardStats(deckId)：数量类按库，热力图/连续天数跨库
  ai.ts            ← 缓存/用量/月度费用/按家用量/目录与价格的读写
  importDrafts.ts  ← 草稿的 deck_id 与 commitDraft 的目标库
src/main/index.ts  ← 启动、托盘（只统计当前库）、提醒、备份；迁移前备份；30 秒后后台刷新目录/价格
src/main/tray-bridge.ts ← ipc.ts → index.ts 的托盘刷新回调（避免循环 import）
src/renderer/src/components/DeckPicker.tsx ← 库标签栏（DeckTabs）与下拉（DeckSelect）
src/renderer/src/components/Select.tsx ← 自定义下拉（原生 select 弹出层是系统方角，统一用它）
src/renderer/src/pages/SettingsPage.tsx ← 左侧 7 分区（供应商/角色/复习/笔记库/提醒/发音/高级与诊断）
src/renderer/src/components/ModelPicker.tsx ← 模型可搜索下拉（公开名 + id + 价格，允许手填）
src/renderer/src/pages/StatsPage.tsx    ← 本月 AI 花费按供应商拆分 + 顶部库过滤
scripts/Launcher.cs ← 便携版启动器的基础（将来扩展成换目录）
scripts/gen-pricing.mjs ← 重新生成价格快照（调价时跑一次）
scripts/ai-smoke.mjs    ← npm run ai-smoke（启动 Electron + --ai-smoke）
tests/
  providers.test.ts     ← 17 项：传输层/供应商表/错误归一化/中文 400/GLM 不发 thinking
  ai-client.test.ts     ← 16 项：client 接线 + 角色路由 + 400 降级 + 强制思考模型（stub fetch，不联网）
  ai-pricing.test.ts    ← 13 项：价格三级来源/目录解析/未定价用量/预算兜底
  ai-models.test.ts     ← 6 项：模型列表的公开名合并与目录边界
  ai-cache-key.test.ts  ← 2 项：ai_cache 唯一键重建
  ai-db.test.ts         ← 5 项：provider 列 + 老库迁移回填
  decks.test.ts         ← 12 项：库作用域/额度/批量/合并分裂/删库/老库迁移+迁移前备份
  settings-secrets.test.ts ← 5 项：secrets.bin → v2 迁移 + 多 Key 并存
  settings-ai.test.ts   ← 4 项：ai 深合并 + apiKeySet 跟随默认角色
  core.test.ts / drafts.test.ts / phonetic.test.ts ← 既有（25 / 10 / 3 项）
docs/               ← 四份计划 + 调研 + 本文件
```

---

## 5. 已完成：多供应商（冻结）+ 多个库；下一步：便携版

### 5.1 多供应商（2026-11-18 ~ 19，master，冻结）

`typecheck` 0 错误、真机通过。实现记录见 [PLAN-PROVIDERS §13](PLAN-PROVIDERS.md)（五条，最后两条是 UI 打磨与 GLM 验证）。

| 能力 | 状态 |
|---|---|
| 四家供应商（DeepSeek / OpenAI / Gemini / GLM） | ✅ 可配 Key；设置页四张卡片 + 角色路由 `default`/`vision` |
| Key 存储 | ✅ `secrets.v2.json`（safeStorage 整份加密；旧 `secrets.bin` 自动迁移，保留到「清除全部」） |
| 模型目录 | ✅ `/models` + TTL 24h + 单飞 + 失败保留旧列表；设置页**可搜索下拉**（公开名 + id + 价格），永远可手填；候选**只来自目录**，不拿快照冒充 |
| 价格 | ✅ models.dev → 随包快照 → 未知 `priced:false`（金额 0，只统计 token） |
| 用量与预算 | ✅ `cost_source`/`priced_at`、按家统计、未定价时按 token 上限兜底 |
| 自检 | ✅ `npm run ai-smoke`（4 调用点 × 4 家，没 Key 的 `SKIP`） |
| 真机 | ✅ DeepSeek（11-18）、GLM（11-19）；OpenAI / Gemini 没有 Key，标「未验证」等社区反馈 |

**GLM 的坑（已修，别踩回去）**：`glm-5.x-flash` **强制思考**，不能发 `thinking: {type:'disabled'}`（中文 400）；GLM 现在 `whenOff: 'omit'`（不需要思考时干脆不发这个字段）。另外「保存并测试」的 max_tokens 从 8 提到 256，否则思考模型会把 token 全花在推理上返回空内容。

### 5.2 多个库（2026-11-19，master，完成）

提交：`edf98bc`（主体）、`0aa933d`（真实老库迁移记录）、`46869f8`（删批量撤销）、`08e58da`（切库性能）、`e8fb3db`（库下拉 + 圆角下拉）。

实现记录（改动清单、与计划的差异、验收对照、二次打磨）在 [PLAN-DECKS §15](PLAN-DECKS.md)，这里只写**接手时最容易忘的七件事**：

1. **作用域只有一个入口**：所有按库过滤都走 `deckScope(column, deckId)` / `deckInClause`（`src/main/db/decks.ts`）。`deckId = null` 表示全部库；新加查询时先想清楚该不该拼它。
2. **当前库是 `settings.currentDeckId`**：主进程托盘、提醒、导入默认目标都读它；渲染层切库走 `App.setDeck()`（写 settings + 刷新统计）。统计页顶部的「统计范围」是**独立过滤器**，不影响当前库。
3. **笔记库标签栏切库会同时改当前库**；今日任务页的库选择器在标题右侧（下拉），答题/学习过程中不提供切库。
4. **没有撤销**：批量移动/复制/删除都不做撤销（2026-11-19 决定：操作简单，不值得多一套状态）；删除前对话框会写清后果。
5. **迁移前备份已生效**：`openDb()` 之前 `backupBeforeMigrate()` 会写 `backups/wordmemo-pre-migrate-v<N>.db`（先 checkpoint WAL；同版本已有备份时保留旧的）。改 schema 记得升 `SCHEMA_VERSION`。
6. **笔记库切库不再等 400ms**：只有搜索输入防抖 300ms；切库/排序立即请求，并按「库 + 排序 + 搜索词」缓存一份结果（`version` 变化即清空）。3500 份笔记的极端库仍有 230ms 首屏，虚拟化还没做（P2 #13）。
7. **不要再用原生 `<select>`**：它的弹出层是系统样式（方角、CSS 改不到），全部换成 `src/renderer/src/components/Select.tsx`（圆角列表、键盘 ↑↓/Enter/Esc、空间不够向上弹）；复选框保留方角是有意的。

### 5.3 多个库的已知剩余与「已决定不做」

- **库颜色：不做（2026-11-19 决定）**。理由：库少时看名字更快；库多时预设色板不够用，颜色一多、相近色反而降低辨识效率。`decks.color` 列保留（同步/以后可能用），但本版不提供取色 UI，也不要在界面里渲染颜色。
- **按库汇总表：不做（2026-11-19 决定）**。没有看出对应需求；每库计数已经在笔记库标签和「设置 → 笔记库」的行里，统计页保留「统计范围」过滤即可。
- **3500 份笔记的列表未虚拟化**：实测首屏 230ms（`notes.list` 73ms），先记在 PLAN-NEXT P2 #13；正常使用（每库几十份笔记）是 10~30ms。
- **考试范围 UI 只有「整库 / 指定笔记」**：`cardsInScope` 支持 `tags` 且与库是 AND，但创建考试的表单没暴露标签条件（首版原本也没有）。
- **库数量 >10 的「建议合并」提示**没做（PLAN-DECKS §12 的可选项）。

### 5.4 多供应商残留欠账（不阻塞便携版）

- models.dev 的 `tiers`（按上下文长度分段计价）没接，长上下文会低估。
- 「厂商响应自报价格」（§4.2 第 1 级）只是枚举位，4 家都没给。
- 冒烟复制数据目录时必须连 **`Local State`** 一起复制（safeStorage 密钥在那）。
- `glm-5.x-flash` 判分约 22 秒（强制思考）；想快就让用户换 `glm-4.6` / `glm-4.7`。

---

## 6. 后面两个功能各自的"第一步"

| 功能 | 第一步 | 注意 |
|---|---|---|
| 便携版 | `electron-builder --dir` 出 `win-unpacked`，写 `app/version.json`，启动器 v0 | **先确认 `%APPDATA%\WordMemo` 有数据、程序目录没有数据** |
| 同步 | S0：`uid` + `replayCards()` + golden test | **S0 不通过就别往下做**；退路是「以卡为准 + 冲突副本」 |

---

## 7. 测试与反馈（没有 Windows 虚拟机也能测）

### 7.1 本机（这台）

- `npm run typecheck` / `npm test`：每次改完都跑。
- `npm run dev`：开发模式看界面。`npm run ai-smoke`：真机自检（4 个调用点 × 4 家，没 Key 的家 `SKIP（无 Key）`，会花几次极短调用；跑之前先退出正在运行的应用）。
- **界面截图验收**：离屏窗口必须 `webPreferences.backgroundThrottling: false`，并且用 CDP `Page.captureScreenshot`（`capturePage()` 会返回上一帧，还会把 CSS transition 卡在中间态，看起来像两个分项同时高亮）。
- 多个库这次用的轻量办法（不装 Playwright）：`npm run build` 后 `electron.exe . --no-sandbox --remote-debugging-port=9333`，用一个临时 Node 脚本（Node 22 自带 `WebSocket`）连 CDP：`Page.navigate` 带 `?page=library` 直接进页面，`Runtime.evaluate` 调 `window.api.*` 造数据/断言，`Page.captureScreenshot` 存图。脚本放 `.data/` 下即可（已被 gitignore），不要提交。

### 7.2 另一台电脑（Windows 家庭版，有 Git/Node，用 VMware）

- **不需要虚拟机**：那台电脑直接把 portable zip 解压到 `D:\WordMemo-Portable` 运行就是真实用户场景。装没装 Node 不影响（应用自带 Electron）。
- 测试前先确认 `%APPDATA%\WordMemo` 不存在（或先改名），否则会读到旧数据。
- 只有在需要"反复重置"时才用 VMware：装微软官方 **Windows 11 Enterprise 评估版**（90 天、免费），VMware Workstation 现在个人免费；装完把 zip 拖进去即可。**不要用第三方精简版系统。**
- 验收动作：解压 → 双击 → 导入 `samples/demo.txt` → 复习一张 → 关闭 → 确认 `%APPDATA%\WordMemo\wordmemo.db` 在 → 删掉整个程序文件夹 → 重新解压 → 打开，词库还在。

### 7.3 反馈给我/给下一个会话时带什么

- 版本号（`app/version.json`）
- 便携版：`update/error.log`、`update/state.json`
- `%APPDATA%\WordMemo\`：`sandbox-state.json`、`diagnostics/` 日志
- 截图：报错弹窗、设置页、任务管理器进程
- **不要发** `secrets.bin`、API Key、完整 `settings.json`

### 7.4 没有 Key 的两家（OpenAI / Gemini）

- 请求构造与响应解析由 `tests/ai-client.test.ts` / `ai-models.test.ts` 的 stub fetch 覆盖（**没有**录制夹具，可后补；DeepSeek 与 GLM 已真机验证，所以传输层是可信的）
- UI 上标「未验证」，失败时给「复制诊断信息」
- README 维护状态表：DeepSeek / GLM 已验证，OpenAI / Gemini 未验证

---

## 8. 已知坑（做之前先看一眼）

完整清单在 [PLAN-NEXT §7](PLAN-NEXT.md)。最容易踩的六个：

1. ~~**迁移跑在备份之前**~~：**已修**。`index.ts` 在 `openDb()` 之前调 `backupBeforeMigrate()`，写 `backups/wordmemo-pre-migrate-v<N>.db`；改 schema 记得升 `SCHEMA_VERSION`（`schema.ts`），否则不会触发备份。
2. **同步的时间戳没有时区**：`localIso()` 是本地时间，跨设备比较会错 → 同步 op 要另加 `ts_utc`。
3. **批量删除连带删词条**：`deleteNotes` 会清理孤儿 items（卡片/复习记录一起没）；对话框已写明；删除**不可恢复**。
4. **便携版数据不能放程序目录**：`index.ts:22-26` 的 dev 逻辑要把数据塞进 `.data`，必须确认打包后不生效。
5. **库的作用域漏一处就串库**：新查询一律用 `deckScope()`/`deckInClause()`；审计 `grep "FROM cards\|FROM items\|FROM notes"`。`deckId = null` = 全部库，别把 null 当 0。
6. **`--no-sandbox` 是这台机器的硬需求**：三保险（代码开关 + 启动器 + 崩溃探针）。

---

## 9. 新会话开场提示词（直接复制粘贴）

```
继续 WordMemo（D:\ymh\Code\tools\wordmemo）。先读 docs/HANDOFF.md，
再读 docs/PLAN-NEXT.md 的 §5（已定决策）、§7（坑点）、§8（待定）；
要做「便携版」时读 docs/PLAN-UPDATE.md（§3.11 是定稿方案），要动多个库时读 docs/PLAN-DECKS.md §15；
多供应商已冻结（PLAN-PROVIDERS §13），多个库已完成（PLAN-DECKS §15），两者都只修 bug。

硬约束（已定，不要再讨论）：
- MIT 许可证；AGPL/GPL 只读不抄
- 只做 DeepSeek/OpenAI/Gemini/GLM；不装 pi-ai；不做自定义端点
- 便携版 zip + 启动器换目录；不做安装包、不做签名、不用 electron-updater
- 同步只做结构化数据，图片/文件永久不同步；同步密钥用用户口令
- 多个库用方案 A（进度跟单词走，每库一份新词额度；复制笔记不复制进度）

当前状态：git 已 init，多个库已合并到 master（typecheck 0 错误、npm test 12 文件 118 项全绿）。
多供应商：四家可配 Key、角色路由 default/vision、设置页七分区、模型可搜索下拉、
模型目录与价格自动化、按家统计、npm run ai-smoke；DeepSeek/GLM 真机验证，OpenAI/Gemini 等社区反馈。
多个库：decks 表 + notes.deck_id + 默认库迁移（迁移前备份）、查询全部按库作用域、
笔记库批量移动/复制/删除、今日任务/导入/考试/统计/托盘接库；切库 10~30ms、
原生 select 已换成自定义圆角下拉（Select.tsx）。

下一步：做「便携版 + 自更新」——
1) 先确认 %APPDATA%\WordMemo 有数据、程序目录没有数据；
2) 读 PLAN-UPDATE §3.11，把 electron-builder 的 target 改 portable/zip 方向，
   出 win-unpacked 或 zip，写 app/version.json，启动器 v0（scripts/Launcher.cs 是基础）；
3) 验收照 PLAN-UPDATE §3.11 与 HANDOFF §7.2 的便携版动作。
多个库已合并，直接从 master 开 feat/portable；做完在 PLAN-UPDATE 里记一笔并 commit（git commit -s）。
```

---

## 10. 维护纪律

- **一次只做一个功能**，做完在对应计划的「实现记录」里写一笔，然后 commit。
- 建议每个功能开一个分支：`feat/providers`、`feat/decks`、`feat/portable`、`feat/sync`。
- 提交信息用 `feat|fix|refactor|docs(scope): ...`。
- 贡献者用 DCO（`git commit -s`），不引入 CLA。
- **界面灰字规则**（2026-11-18 定）：UI 上的小字只回答「我现在要做什么、会发生什么」。实现原因、发布流程、给维护者看的说明（例如「对应 Anki 的 learn ahead」「改完代码要重启」「不用等发版」）一律不进 UI——放这里、README 或设置页「高级与诊断 → 诊断信息」里。加灰字前先问：用户看完会多做/少做一个动作吗？不会就别加。
- **不要做的**：改许可证、把 AGPL 代码抄进来、装 pi-ai（除非供应商超过 4 家）、加安装包/签名、同步附件、把 `scripts/ocr-lab/runs/` 或 `gt/` 加回仓库。
