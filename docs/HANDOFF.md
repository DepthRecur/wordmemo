# 交接文档（给下一个会话 / 未来的自己）

> 最后更新：2026-11-23（真实发布链路打通：仓库已 push + **公开**，`v0.5.0` / `v0.5.1` 已由 CI 发出 Release）　当前分支：`master`　仓库：`DepthRecur/wordmemo`（public）
> **推送状态**：`master` 与 tag `v0.5.0`、`v0.5.1` 都已推上 GitHub；默认分支已改成 `master`。这台机器到 `github.com:443` 时通时断（`Connection was reset`），push 失败就重试几次；`api.github.com` 一直可用。GitHub Actions 的 `release` 工作流已真跑过两次（各约 3 分钟），Release 三件套由 CI 生成。
> 这份文档的目的：**新会话读完它就能直接干活**，不需要重新讨论已经定过的事，也不需要重新调研。

---

## 0. 一句话现状

背单词桌面应用（Electron 38 + React 19 + `node:sqlite` + `ts-fsrs`）已可用。四个功能的顺序是：**多供应商 → 多个库 → 便携版自更新 → 云端同步**。前三个已完成并冻结（便携版 U0–U3 全部完成，0.4.0），**下一步是同步**：
- **多供应商**（2026-11-18 ~ 19，已冻结）：四家可配 Key、角色路由、设置页、模型目录/价格、`npm run ai-smoke`；DeepSeek/GLM 真机验证，OpenAI/Gemini 等社区反馈。bug 清单已处理完（P-07 决定不修，见 [BUGS-PROVIDERS.md](BUGS-PROVIDERS.md)）。
- **多个库**（2026-11-19 完成；2026-11-20 第二轮修 bug）：`decks` 表 + 全部查询按库作用域、每库新词额度、批量移动/复制/删除、今日任务/导入/考试/统计/托盘接库。第二轮修完 [BUGS-DECKS.md](BUGS-DECKS.md) 全部条目（考试范围悬空、统计口径、空范围、删当前库、导入目标库、下拉被弹窗裁剪），`tests/decks.test.ts` 扩到 21 项。实现记录见 [PLAN-DECKS §15](PLAN-DECKS.md)。
- **便携版 U0**（2026-11-19，已并入主线）：`npm run dist` 出 `release/WordMemo-0.4.0-portable.zip`（141.5 MB）+ sha256 + `latest.json`；启动器按 sandbox-state.json 决定是否降级；数据固定在 `%APPDATA%\WordMemo`。
- **便携版 U1**（2026-11-21，已并入主线）：`sandbox-state.json` 探针 + 连续 3 次启动失败自愈 + 设置页开关 + 启动器按 compatMode 传参；无沙箱机器连续失败 3 次后会自动切兼容模式，不会永久打不开。
- **便携版 U2**（2026-11-21，已并入 master）：应用启动 60 秒后检查 GitHub Releases 的 `latest.json`，有新版本自动下载 + 流式 sha256 + 解压到 `update/app-new`，只提示「下次启动生效」；启动器在下一次启动时按七步换目录（`app→app-old` / `app-new→app`），失败回滚 + `update/error.log`。**应用绝不替换自己、不静默重启**。实现记录与验收见 [PLAN-UPDATE §10 U2](PLAN-UPDATE.md)。
- **便携版 U3**（2026-11-21，`feat/portable-u3`）：`.github/workflows/release.yml`（tag `v*` → typecheck/test/build/dist → 三件套校验 → GitHub Release）+ `release-notes/v<version>.md` 约定 + README 两条更新路径与发版流程。**不改代码，版本仍是 0.4.0**。实现记录见 [PLAN-UPDATE §10 U3](PLAN-UPDATE.md)。
- **便携版真机验收**（2026-11-21 ~ 23，见 [PLAN-UPDATE §10 真机验收](PLAN-UPDATE.md)）：测试包 `D:\WordMemo-U3-Package` 三份独立指南发 A/B/C。**A 自测 T1–T10 全通过**（报告在包内 `报告-A-20261123.md`，截图 `D:\WordMemo-A-Evidence\`）；C（VM）T1–T4/T9 通过后卡住、B 同现象，根因是**测试指南 T5 第 4 步用错启动方式**（`启动（普通）` 不带 `WORDMEMO_UPDATE_URL` → 打到 private 仓库 404），已修指南并加「常见现象」对照表，**不是代码缺陷**。另修 T7（`app-old` 只在下一次更新时删）与 T6（stale 在第一次启动就清）。B/C 待按新指南复测 T5–T10。
- **便携版收尾（2026-11-23，完结）**：真机验收 A 自测 T1–T10 全过；**B/C 不再测试**（决定：三台机器行为一致，继续测的边际收益低于成本）；真实发布链路打通——仓库已公开，`v0.5.0` / `v0.5.1` 由 GitHub Actions 自动发 Release，应用真的从 GitHub 取到 `latest.json` 并流式下载 148 MB。0.5.1 修掉「30 分钟总时长上限把慢速但没断的下载掐断」这个真实缺陷（改成 5 分钟无新数据才算卡住 + 3 小时上限）。**自动更新板块到此完结**；更新失败的兜底就是用户自己去 GitHub Release 手动下载 zip（README 已写）。
- **无 Key 模式**（2026-11-20）：没 Key 是受支持状态；AI 功能不可用，但导入文本、学习、复习、考试、统计、多库全部可用（见 §5.6）。

**3500 压力测试（2026-11-20，只测不改）**：3500 份笔记的列表 **不需要虚拟化**（IPC 89ms / 首屏 274ms / 滚动 60fps）；3500 个词条的**笔记详情**是热点（首屏 802ms / 滚动 ~30fps / 10 万 DOM 节点），这次没改代码，方案记在 [PLAN-DECKS §15.7](PLAN-DECKS.md)。

下一个要做的：**同步 S0**（[PLAN-SYNC.md](PLAN-SYNC.md)）：`uid` + `replayCards()` + golden test。**S0 不通过就别往下做**，退路是「以卡为准 + 冲突副本」。

---

## 1. 五分钟上手

```powershell
cd D:\ymh\Code\tools\wordmemo
npm install          # 只有删过 node_modules 才需要
npm run typecheck    # tsc --noEmit，必须 0 错误
npm test             # vitest，17 个测试文件（185 项）必须全绿
npm run dev          # 开发模式启动（脚本已带 --noSandbox）
```

- **`npm test` 报 `spawn EPERM`**：说明你处在受限沙箱里（esbuild 要 spawn 命名管道）。**在普通 PowerShell / CMD 里跑**就没问题。
- 只跑一个测试：`npx vitest run tests/providers.test.ts`
- 打包（便携版）：`npm run dist` → `release/WordMemo-0.4.0-portable.zip`（+ `.sha256` + `latest.json`）；只想出 `win-unpacked` 用 `npm run dist:app`；只编译启动器用 `npm run launcher`。
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
| 更新 | 应用只下载 + 校验；启动器只换目录；用户手动覆盖 `app/` 是同一份 zip（兜底）；首个可更新版本 **0.4.0**（U2） |
| 同步 | 只同步结构化数据；**图片/文件永久不同步**；`.wmsync` 快照导出/导入做 |
| 同步密钥 | **用户口令**（age passphrase）+ `kdfVerifier` 防错 + 强度条；**没有恢复密钥** |
| 托盘 | 只统计**当前库** |
| 库数量 | **允许一个库都没有**（2026-11-20）：删最后一个库时笔记不删，`deck_id` 置 0 = 未归类，只在「全部」里出现；启动时**不许**再补默认库（只在老库迁移时建一次） |
| 消息分级 | **错误 = 某项功能结果出错/不可用；警告 = 异常但不影响功能**。判后果，不判"有没有抛异常"；`err` 与 `warn` 都常驻铃铛，区别只在颜色，细节见 [MESSAGES.md](MESSAGES.md) |
| 其他 | DCO（不要 CLA）；数据目录 `%APPDATA%\WordMemo`；`--no-sandbox` 探测式降级 |

---

## 3. 文档地图（按这个顺序读）

| 文档 | 什么时候读 |
|---|---|
| **本文 HANDOFF.md** | 每次新会话第一份 |
| [MESSAGES.md](MESSAGES.md) | **写/改任何用户可见消息之前**（错误 vs 警告 vs 提示的定义、判定顺序、通道对照） |
| [PLAN-NEXT.md](PLAN-NEXT.md) | 排序、共同约束、**已定/待定清单**、**坑点清单（§7）**、验证条件（§9） |
| [PLAN-PROVIDERS.md](PLAN-PROVIDERS.md) | 做多供应商时；**§13 是当前实现记录与下一步** |
| [PLAN-DECKS.md](PLAN-DECKS.md) | 做多个库时 |
| [PLAN-UPDATE.md](PLAN-UPDATE.md) | 做便携版/自更新时（§3.11 定稿方案、**§10 是 U0 实现记录、§11 是 U1–U3 交接**） |
| [BUGS-PROVIDERS.md](BUGS-PROVIDERS.md) | 修多供应商 bug 时（清单，交给对应会话） |
| [BUGS-DECKS.md](BUGS-DECKS.md) | 修多个库 bug 时（清单，交给对应会话） |
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
src/main/index.ts  ← 启动、托盘（只统计当前库）、提醒、备份；迁移前备份；30 秒后后台刷新目录/价格；U1 在 whenReady 前按 sandbox-state appendSwitch；U2 调 startUpdater（60s 后检查/24h/退避）
src/main/sandbox.ts ← U1 兼容模式：读/写 userData/sandbox-state.json、probe 判定、setCompat/markReady/ackNotice
src/main/updater.ts ← U2 自更新（不 import electron）：版本比较/latest.json 校验/节流退避/状态机/流式下载+sha256/tar 解压/app-new 校验/update/state.json 读写
src/preload/index.ts ← window.api（含 updates.*、events.onUpdateStatus）
src/main/ipc.ts    ← IPC + updates:status/check/skipVersion/setAutoCheck（没有 install）
src/main/tray-bridge.ts ← ipc.ts → index.ts 的托盘刷新回调（避免循环 import）
src/main/reviewSession.ts ← 复习现场（离开后回来接着上一张卡）→ userData/review-session.json
src/renderer/src/components/DeckPicker.tsx ← 库标签栏（DeckTabs）与下拉（DeckSelect）
src/renderer/src/components/Select.tsx ← 自定义下拉；列表 portal 到 body + fixed 定位（弹窗里也不会被 overflow 裁掉）
src/renderer/src/pages/SettingsPage.tsx ← 左侧 7 分区（供应商/角色/复习/笔记库/提醒/发音/高级与诊断）
src/renderer/src/components/ModelPicker.tsx ← 模型可搜索下拉（公开名 + id + 价格，允许手填）
src/renderer/src/pages/StatsPage.tsx    ← 本月 AI 花费按供应商拆分 + 顶部库过滤
scripts/Launcher.cs   ← 便携版启动器（U1：读写 sandbox-state.json、按 compatMode 传 --no-sandbox；失败计数/写 probe；U2：按 update/state.json 七步换目录 + 回滚 + error.log + 清 stale）
scripts/build-launcher.mjs ← 用 Windows 自带 csc.exe 编译启动器（不需要 SDK/新依赖；U1 起引用 System.Web.Extensions）
scripts/make-portable.mjs  ← npm run dist：build → electron-builder --dir → 组装 → zip + sha256 + latest.json
scripts/portable-README.txt ← zip 里的使用/数据/手动更新说明（{{VERSION}} 构建时替换）
scripts/gen-pricing.mjs ← 重新生成价格快照（调价时跑一次）
scripts/ai-smoke.mjs    ← npm run ai-smoke（启动 Electron + --ai-smoke）
.github/workflows/release.yml ← U3 CI 发版：tag v* → 版本校验 → typecheck/test/build/dist → 三件套断言 → gh release（workflow_dispatch = dry run）
release-notes/v<version>.md ← 每个版本的 Release Notes 三行（是否迁移数据 / 是否不可逆 / 修了什么）；CI 把前 3 行写进 latest.json 的 notes
tests/
  providers.test.ts     ← 17 项：传输层/供应商表/错误归一化/中文 400/GLM 不发 thinking
  ai-client.test.ts     ← 16 项：client 接线 + 角色路由 + 400 降级 + 强制思考模型（stub fetch，不联网）
  ai-pricing.test.ts    ← 13 项：价格三级来源/目录解析/未定价用量/预算兜底
  ai-models.test.ts     ← 6 项：模型列表的公开名合并与目录边界
  ai-cache-key.test.ts  ← 2 项：ai_cache 唯一键重建
  ai-db.test.ts         ← 5 项：provider 列 + 老库迁移回填
  decks.test.ts         ← 21 项：库作用域/额度/批量/合并分裂/删库引用（exam scope/草稿/当前库）/统计口径/空范围/导入目标库/老库迁移+迁移前备份
  settings-secrets.test.ts ← 5 项：secrets.bin → v2 迁移 + 多 Key 并存
  settings-ai.test.ts   ← 4 项：ai 深合并 + apiKeySet 跟随默认角色
  review-session.test.ts ← 5 项：复习现场存取/过期/坏文件/清理（见 §5.8）
  sandbox.test.ts       ← 13 项：probe 判定（30s/pid/lastReadyAt/连续 3 次/launcher 来源）、文件读写、setCompat/ack
  updater.test.ts       ← 22 项：版本比较/预发布号、latest.json 校验（缺字段/坏 sha/路径穿越）、节流退避/时钟回拨、跳过与手动穿透、状态机、state.json 往返、app-new 校验、更新源覆盖
  ai-budget.test.ts / settings-derived.test.ts ← 预算提醒静音 / 派生设置
  core.test.ts / drafts.test.ts / phonetic.test.ts ← 既有（25 / 11 / 3 项）
docs/               ← 四份计划 + 调研 + 本文件
```

---

## 5. 已完成：多供应商（冻结）+ 多个库 + 便携版 U0–U3；下一步：同步

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

### 5.2 多个库（2026-11-19 完成；2026-11-20 第二轮修 bug）

提交：`edf98bc`（主体）、`0aa933d`（真实老库迁移记录）、`46869f8`（删批量撤销）、`08e58da`（切库性能）、`e8fb3db`（库下拉 + 圆角下拉）、`6bb4380`（下拉 portal）、`dd304b6`（第二轮引用/统计/导入修复）、`48a2d0e`（测试）、`9f3262e`（文档）。

实现记录（改动清单、与计划的差异、验收对照、二次打磨）在 [PLAN-DECKS §15](PLAN-DECKS.md)，这里只写**接手时最容易忘的七件事**：

1. **作用域只有一个入口**：所有按库过滤都走 `deckScope(column, deckId)` / `deckInClause`（`src/main/db/decks.ts`）。`deckId = null` 表示全部库；新加查询时先想清楚该不该拼它。
2. **当前库是 `settings.currentDeckId`**：主进程托盘、提醒、导入默认目标都读它；渲染层切库走 `App.setDeck()`（写 settings + 刷新统计）。统计页顶部的「统计范围」是**独立过滤器**，不影响当前库。
3. **笔记库标签栏切库会同时改当前库**；今日任务页的库选择器在标题右侧（下拉），答题/学习过程中不提供切库。
4. **没有撤销**：批量移动/复制/删除都不做撤销（2026-11-19 决定：操作简单，不值得多一套状态）；删除前对话框会写清后果。
5. **迁移前备份已生效**：`openDb()` 之前 `backupBeforeMigrate()` 会写 `backups/wordmemo-pre-migrate-v<N>.db`（先 checkpoint WAL；同版本已有备份时保留旧的）。改 schema 记得升 `SCHEMA_VERSION`。
6. **笔记库切库不再等 400ms**：只有搜索输入防抖 300ms；切库/排序立即请求，并按「库 + 排序 + 搜索词」缓存一份结果（`version` 变化即清空）。3500 份笔记的极端库复测为 274ms 首屏 / 滚动 60fps，**列表不需要虚拟化**（§5.10）。
7. **不要再用原生 `<select>`**：它的弹出层是系统样式（方角、CSS 改不到），全部换成 `src/renderer/src/components/Select.tsx`。列表 **portal 到 body + fixed**（弹窗的 `.modal-body` 是 overflow:auto，留在里面会被裁掉）；只有视口下方放不下且上方更宽裕才向上翻。复选框保留方角是有意的。

### 5.3 多个库的已知剩余与「已决定不做」

- **库颜色：不做（2026-11-19 决定）**。理由：库少时看名字更快；库多时预设色板不够用，颜色一多、相近色反而降低辨识效率。`decks.color` 列保留（同步/以后可能用），但本版不提供取色 UI，也不要在界面里渲染颜色。
- **按库汇总表：不做（2026-11-19 决定）**。没有看出对应需求；每库计数已经在笔记库标签和「设置 → 笔记库」的行里，统计页保留「统计范围」过滤即可。
- ~~3500 份笔记的列表未虚拟化~~：2026-11-20 实测（§5.10）结论是**不需要**，P2 #13 的列表部分关闭。
- **考试范围 UI 只有「整库 / 指定笔记」**：`cardsInScope` 支持 `tags` 且与库是 AND，但创建考试的表单没暴露标签条件（首版原本也没有）。
- **库数量 >10 的「建议合并」提示**没做（PLAN-DECKS §12 的可选项）。

### 5.4 多供应商残留欠账（不阻塞便携版）

- models.dev 的 `tiers`（按上下文长度分段计价）没接，长上下文会低估。
- 「厂商响应自报价格」（§4.2 第 1 级）只是枚举位，4 家都没给。
- 冒烟复制数据目录时必须连 **`Local State`** 一起复制（safeStorage 密钥在那）。
- `glm-5.x-flash` 判分约 22 秒（强制思考）；想快就让用户换 `glm-4.6` / `glm-4.7`。

### 5.5 便携版 U0（2026-11-19，已并入主线，完成）

`npm run dist` → `release/WordMemo-0.3.0-portable.zip`（141.5 MB）+ `.sha256`（U0 当时的版本号；现在的产物是 **0.4.0**，见 §5.12）；启动器（U1 起按 sandbox-state 决定参数）、`app/version.json`、数据路径都已落定。实现记录与验收见 [PLAN-UPDATE §10](PLAN-UPDATE.md)。接手时最容易忘的五件事：

1. **electron-builder 必须 ≥ 26.18**：25.1.8 的依赖树 bug 会把 hoisted 的 `call-bind-apply-helpers` 只复制到 `node_modules/call-bind/node_modules/`，启动直接 `Cannot find module`。退回 25 = 打不开。
2. **出包不需要 GitHub**：`electronDist: node_modules/electron/dist` 复用已装 Electron；v26 不下载 winCodeSign；zip 用系统 `tar.exe`（v26 已无 `7zip-bin`）。
3. **打包版与开发版数据是分开的**：打包版 `%APPDATA%\WordMemo`，开发版 `.data/`，不自动迁移；切换前手动复制 `wordmemo.db`、`settings.json`、`secrets.v2.json`、`Local State`。
4. **启动器不再无条件带 `--no-sandbox`**（U1，2026-11-21）：它读写 `%APPDATA%\WordMemo\sandbox-state.json`，只在 `compatMode === true` 时传 `--no-sandbox --disable-gpu-sandbox`；主进程在 `app.whenReady()` 之前按同一文件 `appendSwitch`。改 `Launcher.cs` 后跑 `npm run launcher` 或 `npm run dist` 重编（用系统 `csc.exe`，不需要 SDK）。
5. **`update/` 与 `app/version.json` 现在是 U2 真正在用的**：**不要手工改 version.json**（构建时写入）；启动器按 `update/state.json` + `app/version.json` 判断要不要换目录（见 §5.12）。

### 5.6 无 Key 模式（2026-11-20，受支持状态）

**没有 API Key 不是错误，是用户可以选择的状态。** 能用的：启动/托盘/提醒、导入 txt/md/docx/xlsx、学习/复习/FSRS、听写冲刺、统计、笔记库、多库、备份、联网时的发音；**只有图片导入、AI 校验/搭配/例句、AI 音标补充、语义判分、中文语义搜索会不可用**（按钮禁用或明确报错，不阻塞其它功能）。

2026-11-20 修掉的三处噪音：
- 去掉了每次启动的红色「未配置 API Key」常驻通知（`App.tsx`）；
- 无 Key 导入时，提示从 `issues` 挪到「解析提示」`warnings`，不再计入「草稿待处理」；文案跟随默认模型那家，不再写死 DeepSeek（`extract.ts`）；
- 无 Key 启动时不再请求 models.dev 价格目录（`index.ts`）；模型目录本来就按家跳过。

### 5.7 消息分级 + 界面收敛（2026-11-20）

- **新增 [MESSAGES.md](MESSAGES.md)**：用户可见消息的三级定义（错误 = 功能结果出错/不可用；警告 = 异常但不影响功能；提示 = 成功/进度/少做一个动作）、五问判定顺序、五条硬规则、通道对照表、**常驻策略**，以及 2026-11-20 的完整审计（12 条曾归错的，已逐条改掉）。**改任何用户可见消息前先读它。**
- **`warn` 级别落地**：`NoticeType` 从 `ok|info|err` 扩成 `ok|info|warn|err`。**`warn` 与 `err` 都常驻铃铛**（用户要求：允许稍后检查，不常驻容易忘），区别只在颜色（黄 / 红）；`syncSystemNotice` 多了一个 `level` 参数（草稿校验待处理、AI 预算用 `'warn'`）。
- **12 条归错的消息已改**：前置条件类（"至少选一个词条"）降为提示；音标查不到、剪贴板没复制成、刷新模型目录/价格失败、草稿校验待处理、预算用完 → 警告并换了人话文案；AI 校验的 `severity: 'error'` 不再用错误红（面板叫「很可能错」，行高亮只用警告底色，草稿卡 `N 待核对` 改黄字）；**解析出 0 条词条**从「解析提示」改成 `ImportResult.ok=false` 的真错误（草稿与原文仍保留）。
- **库管理去掉「保存」按钮**：设置 → 笔记库的库行改成改动 500ms 后自动落库（和本页「改动会自动保存」一致）；空名字不写（避免边打字边报「库名不能为空」），写失败保留草稿并报错，删库时丢掉该行草稿。`SettingsPage.tsx` 的 `saveDeckRow` 已换成 `flushDeckDrafts` + 防抖 effect。
- **允许一个库都没有**：`removeDeck(id, null)` 删最后一个库时把笔记 `deck_id` 置 0（未归类，不删笔记），并更新 `import_drafts` 与 `settings.currentDeckId`；`migrateDecks` 只在**老库迁移**时补默认库，之后启动不会自己长出来；`settings.currentDeckId` 允许 0。UI：删库对话框对最后一个库给"笔记变未归类"的说明，笔记库/导入页/今日任务都有"还没有库"的空状态。
- **笔记库列表瘦身**：删掉「到期」列和标题后的黄色「N 待核对」标签（`Notes.tsx`）；到期数仍在库标签栏、今日任务、统计页出现。
- `npm test` 现在是 **17 文件 185 项**（本文其它地方出现的 12/118/142/150/163 都是旧数字）。

### 5.8 复习现场恢复（2026-11-20）

**问题**：判分完成后（还没点「下一张」）切页面/退出，回来这个词要重新写一遍——因为判分只是渲染层状态，`review.submit` 还没写库。

**做法**：`src/main/reviewSession.ts` 把「现在这张卡 + 答案 + 判分结果 + 冻结用时 + 已交张数/总张数 + 范围」写到 `userData/review-session.json`；`Review.tsx` 挂载时先读它，有就**直接回到那张卡**（判分界面原样回来，点「下一张」继续）；一轮结束、点「重新排队」时清掉。超过 12 小时的现场作废。

- `scope` = `deck:<id>` / `exam:<id>`：换库/换考试不恢复。
- **整张卡一起存**，不要改成「存 cardId、回来去队列里找」：`dailyPlan` 的 `oneCardPerItem` 每次都会**重新随机抽方向**，同一个词下次可能换成另一张卡，按 id 找必然找不到，于是又重出一遍。
- 恢复时把存下的这张卡放最前面，其余用新队列接着来（跳过同一个词的其它方向）。
- 「还没提交只是打了字」也算现场：回来输入框里的内容还在。
- 复习页头部新增两个按钮：「稍后继续」（回到今日任务概览，现场保留）、「重新排队」（放弃现场，从头开始）。
- 已知没做：**学习阶段的进度不在现场里**（`rateLearn` 本来就即时写库，回来会从下一个没学的词继续，只是要先点一次「开始学习」）。
- 单元测试：`tests/review-session.test.ts`（存取往返、未提交状态、过期作废、坏文件、清理）。

### 5.9 多个库第二轮修 bug（2026-11-20）

[BUGS-DECKS.md](BUGS-DECKS.md) 的 D-01~D-07 全部关闭（D-02/D-05/D-07 与 D-03 界面部分此前已修，这次补测试/清死代码）。改动集中在四处：

1. **下拉框**：`Select` 列表改 portal + fixed，弹窗里不再向上弹、不再被 `.modal-body` 裁掉；只有视口下方放不下才上翻（`6bb4380`）。
2. **删库后的引用**：`removeDeck` 同一事务里改写 `exams.scope.deckId`（删最后一个库则删掉该字段 = 全部库）；`currentDeckId` 的写入挪出事务；`settings.json` 改 tmp+rename 原子写。
3. **统计与范围**：`dashboardStats` 的「今天已复习/总复习数」按库（join cards + `deckScope`）；`cardsInScope` 区分 `undefined`（不过滤）与 `[]`（空集合）；删掉没人用的 `NoteSummary.dueCount`。
4. **导入目标库**：`saveDraft` 可写 `import_drafts.deck_id`；导入页下拉显示「打开草稿的库」，改下拉同时改草稿与当前库，新文件按下拉显示值入库。

`tests/decks.test.ts` 12 → 21 项；`npm test` 16 文件 163 项（含 U1 的 sandbox 13 项）。细节与验收表见 [BUGS-DECKS 修复记录](BUGS-DECKS.md) 与 [PLAN-DECKS §15.6](PLAN-DECKS.md)。

### 5.10 3500 压力测试（2026-11-20，只测不改）

测试 profile 造数：一个库 3500 份笔记；另一个库 1 份笔记 3500 个词条。`npm run build` + Electron + CDP 计时。

| 场景 | 结果 |
|---|---|
| `notes.list`（3500 份，IPC 含 SQL） | 89ms |
| 笔记列表首屏 / 滚动 | 274ms / 中位 16.6ms（60fps） |
| 笔记详情首屏（3500 词条） | 802ms（10.2 万 DOM 节点） |
| 笔记详情滚动 | 中位 33.4ms（约 30fps） |

结论：**列表不需要虚拟化**；**详情是真热点**。详情行高随释义/搭配变化，真虚拟化要么固定行高截断内容、要么变高测量易跳行，这次没动代码；优先考虑「详情加筛选/搜索」或「默认只渲染前 N 条」。完整记录见 [PLAN-DECKS §15.7](PLAN-DECKS.md)。

### 5.11 便携版 U1 兼容模式（2026-11-21，完成）

- **主进程**：`src/main/sandbox.ts` 读写 `%APPDATA%\WordMemo\sandbox-state.json`；`index.ts` 在 `app.whenReady()` 之前读状态，`compatMode=true` 时 `appendSwitch('no-sandbox')` + `appendSwitch('disable-gpu-sandbox')`；单实例锁之后 `beginProbe()`，窗口 `ready-to-show` → `markReady()`。
- **启动器**：只在 `compatMode=true` 时传 `--no-sandbox --disable-gpu-sandbox`；**它还负责失败计数和写 probe**（有些机器 Electron 在加载 JS 之前就退出，主进程没机会写）。启动器先 `AnotherInstanceRunning()`，有实例就不碰状态；两边都忽略 `probe.startedAt <= lastReadyAt` 的旧 probe。
- **设置页**：高级与诊断有兼容模式开关 + 自动开启提示 + 失败计数 + 「重新检测」（`sandbox:get/setCompat/ackNotice`）。
- **自动降级提示**：首次自动切兼容模式后，铃铛里一条黄色 `warn`；展示后 ack，之后不再提示。
- **判定**：30 秒窗口、pid 不存在、`startedAt > lastReadyAt`；连续 3 次失败才 `compatMode=true`；成功一次清零。
- **验收**：正常模式（本机 renderer 有 `--enable-sandbox`、无 `--no-sandbox`）、兼容模式（主进程带两个参数；直接双击 app 时 renderer 出现 `--no-sandbox`）、dummy app 连续 4 次启动触发兼容、直接启动模拟第 3 次失败触发 `justEnabled`、提示/ack/设置页均实测；`npm test` 16 文件 163 项。
- **注意**：本机当前 Electron 38 实际能带沙箱启动，所以「沙箱不可用」用 dummy exe + 状态文件模拟；真实失败场景留给有问题的 Windows 复测。前 3 次失败没有 UI 提示，便携版 README 已写「再双击，第 4 次自动兼容」。
- **细节**：见 [PLAN-UPDATE §10 U1 小节](PLAN-UPDATE.md)。

### 5.12 便携版 U2 自更新（2026-11-21，`feat/portable-u2`，完成）

- **应用侧**：启动 60 秒后检查 `https://github.com/DepthRecur/wordmemo/releases/latest/download/latest.json`（`net.fetch`，走系统代理），24h 一次、失败退避 1h→2h→4h→6h（时钟回拨时立刻可查）；有新版本自动下载到 `update/`、流式 sha256、`tar.exe` 异步解压到 `update/app-new`、校验 `WordMemo.exe` + `resources/app.asar` + `version.json`、写 `update/state.json = { ready:true, version }`；界面只提示「下次启动生效」。
- **启动器**：按 §3.11 七步换目录（读 state → 校验 → 删 app-old → `app→app-old` → `app-new→app` → 启动 → state ready=false）；失败回滚 + `update/error.log`；**新版本启动失败也会自动回滚**；启动时清 `app-new-stale-*` / `staging-stale-*`。
- **没有** `updates:install`、没有「立即重启安装」：`app.relaunch()` 不经过启动器，不会换目录。用户必须退出后重新双击 `WordMemo.exe`。
- **硬约束都守住了**：应用只下载、启动器只换目录；数据始终在 `%APPDATA%\WordMemo`；没有静默重启；更新源只有 GitHub。
- **验收**：0.4.0 → 0.4.1 真机走通（版本变、2 库/2 笔记/14 词条全在）；坏 sha → 警告且不产生 app-new；半截 app-new → 启动器拒绝并写 error.log、照常启动旧版；新 exe 损坏 → 换目录后启动失败自动回滚；断网 → 黄色警告、不崩；`lastCheckAt=null` 启动 **60 秒整**自动检查；设置页看到「检查更新 / 跳过版本 / 上次检查」。
- **最容易踩的坑（务必先看 PLAN-UPDATE §10 U2 的「坑」）**：Electron 主进程的 `fs` 对 `.asar` 打补丁——`statSync(asar).size` 返回 0，`rmSync` 含 asar 的目录会 EBUSY 并留下句柄（之后 rename 也被拒）。所以应用**不 stat/read asar**（只用 readdir 判断存在），清理一律「先改名让路，再尽力删」，asar 大小检查放在启动器里。
- **细节**：见 [PLAN-UPDATE §10 U2 小节](PLAN-UPDATE.md)。

### 5.13 便携版 U3 CI 发版 + 路线 B（2026-11-21，`feat/portable-u3`，完成）

- **不改代码**，版本仍是 `0.4.0`；typecheck / 17 文件 185 项 / build 全绿。
- **CI**：`.github/workflows/release.yml`。tag `v*` 触发 → tag 必须等于 `v<package.json version>` → `npm ci` → typecheck → test → build → `npm run dist` → 三件套（zip / `.sha256` / `latest.json`）版本·文件名·sha256 三方一致 → upload-artifact → `gh release create`（已存在则 `upload --clobber`）。`workflow_dispatch` 只构建 + 上传 artifact，**不发布**。
- **Release Notes 约定**：每个版本一个 `release-notes/v<version>.md`，三行（是否迁移数据 / 是否不可逆 / 修了什么）；CI 把前 3 行写进 `latest.json` 的 `notes`，完整内容作为 Release 正文。
- **README**：自动 / 手动两条更新路径、SmartScreen「更多信息 → 仍要运行」、sha256 校验、「发布（维护者）」五步。
- **路线 B 真机验收**：0.4.0 解压 → 造数据（2 库 / 2 笔记 / 14 词条）→ 用 `electron-builder --config.extraMetadata.version=0.4.1` 生成新版 app 并覆盖 `app/` → 重新双击启动器 → `system.appVersion()=0.4.1`，数据全在（详见 PLAN-UPDATE §10 U3）。
- **没验到的**：远端 private + 本地未 push，**GitHub Actions 首次真实运行没跑过**，`gh release` 真实调用也没执行（本机没有 `gh`）。「test 失败不发布」目前由步骤顺序保证（test 在 dist / release 之前）；推送后第一次发版要盯 Actions 日志。
- **发版纪律**：改 `package.json` + `package-lock.json` 两处版本 → 加 `release-notes/v<version>.md` → 提交 → `git tag v<version>` → `git push origin v<version>`。`latest.json` 只能由 `npm run dist` / CI 生成，不要手工覆盖。
- **细节**：见 [PLAN-UPDATE §10 U3 小节](PLAN-UPDATE.md)。

多供应商与多个库的 bug 清单都已关闭（[BUGS-PROVIDERS.md](BUGS-PROVIDERS.md)、[BUGS-DECKS.md](BUGS-DECKS.md)）；**便携版 U0–U3 全部完成**，下一步是**同步 S0**（[PLAN-SYNC.md](PLAN-SYNC.md)）。

---

## 6. 后面两个功能各自的"第一步"

| 功能 | 状态 | 注意 |
|---|---|---|
| 便携版 | **完结**（U0–U3 + 真机验收 + 真实 Release，当前 0.5.1） | 发版：改版本 + `release-notes/v<version>.md` → tag `v<version>` → CI 出三件套；数据必须留在 `%APPDATA%\WordMemo`。更新失败的用户自己下 zip |
| 同步 | **现在开始 S0**：`uid` + `withSync` + `replayCards()` + golden test | **S0 不通过就别往下做**；退路是「以卡为准 + 冲突副本」 |

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

完整清单在 [PLAN-NEXT §7](PLAN-NEXT.md)。最容易踩的十一个：

1. ~~**迁移跑在备份之前**~~：**已修**。`index.ts` 在 `openDb()` 之前调 `backupBeforeMigrate()`，写 `backups/wordmemo-pre-migrate-v<N>.db`；改 schema 记得升 `SCHEMA_VERSION`（`schema.ts`），否则不会触发备份。
2. **同步的时间戳没有时区**：`localIso()` 是本地时间，跨设备比较会错 → 同步 op 要另加 `ts_utc`。
3. **批量删除连带删词条**：`deleteNotes` 会清理孤儿 items（卡片/复习记录一起没）；对话框已写明；删除**不可恢复**。
4. **便携版数据不能放程序目录**：dev 分支仍写 `.data`；打包版由 `src/main/index.ts` 的 `else` 分支显式 `setPath('userData', %APPDATA%\WordMemo)`。改动这段前先看 PLAN-UPDATE §3.11。
5. **库的作用域漏一处就串库**：新查询一律用 `deckScope()`/`deckInClause()`；审计 `grep "FROM cards\|FROM items\|FROM notes"`。`deckId = null` = 全部库，别把 null 当 0。
6. **`--no-sandbox` 改为按需降级（U1 已完成）**：主进程在 `whenReady()` 之前按 `sandbox-state.json` 的 `compatMode` `appendSwitch`；启动器只在 compatMode 时传参，并负责失败计数/写 probe（有些机器 JS 根本起不来）。判定 30 秒窗口、连续 3 次失败才降级；成功一次清零。改这里之前先读 [PLAN-UPDATE §10 U1](PLAN-UPDATE.md)。
7. **electron-builder 25 打不出能跑的包**：依赖树漏 hoisted 包（`call-bind-apply-helpers`），exceljs 启动即崩；必须 26.18+，别退回。
8. **打包版的 `%APPDATA%\WordMemo` 与源码模式的 `.data` 不互通**：切换/迁移要手动复制（含 `Local State`）；删程序目录不影响 `%APPDATA%`。
9. **今日任务的队列每次都会重新抽方向**：`dailyPlan` 里 `oneCardPerItem` 用 `Math.random` 从同一个词的多个方向里挑一张，所以两次 `daily()` 的「第 3 张」可能不是同一张卡。任何「按 cardId 回队列里找回来」的写法都会失效（复习现场恢复就是这么踩的，见 §5.8）；要恢复某张具体卡就把它连同词条一起存下来。
10. **Electron 主进程不能 stat/read/rm `.asar`**：`fs.statSync('...app.asar').size` 返回 **0**（被当成虚拟目录）；`fs.rmSync` 一个含 `resources/app.asar` 的目录会 **EBUSY**，并在本进程留下句柄，之后连 `fs.renameSync` 父目录都被拒。U2「下载 → 解压 → 备好 app-new」这条链就是被它咬了三次。规则：应用里只 `readdirSync(resources)` 判断 `app.asar` 存在；清理一律「先改名让路（`app-new-stale-*` / `staging-stale-*`），再尽力删」，删不掉留给启动器；asar 大小检查放启动器（C# 没有这层补丁）。见 [PLAN-UPDATE §10 U2 坑 1](PLAN-UPDATE.md)。
11. **发版三件套必须互相一致**：tag 必须等于 `v<package.json version>`；`latest.json` 只能由 `npm run dist` 生成（`version` / `zip` / `sha256` 与 zip、`.sha256` 一致）。CI 里已经断言，本地手工发版也别绕过。`workflow_dispatch` 只构建不发布；runner 用 Node 24（`node:sqlite` 在 Node 22 早期版本要 `--experimental-sqlite`）。

---

## 9. 新会话开场提示词（直接复制粘贴）

```
继续 WordMemo（D:\ymh\Code\tools\wordmemo）。先读 docs/HANDOFF.md，
再读 docs/PLAN-SYNC.md：§3 是方案（§3.2 uid、§3.3 replay、§3.5 口令加密、§3.9 冲突矩阵），§5 是 S0–S4；
需要背景时读 docs/PLAN-NEXT.md 的 §5（已定决策）、§7（坑点）、§8（待定）。
改任何用户可见文案前先读 docs/MESSAGES.md。

当前状态（2026-11-23）：多供应商（冻结）、多个库、便携版 U0–U3 + 真机验收 + 真实发布（0.5.1）全部完结。
typecheck 0 错误、npm test 17 文件 188 项全绿、npm run build 通过；GitHub 仓库已公开，`v0.5.0`/`v0.5.1` 已发 Release。
**便携版板块不再改**（B/C 不再测试；更新失败靠用户自己下 zip 兜底）。
下一步：从 master 开 feat/sync，做同步 S0：加 uid（先备份）、写入口统一 withSync、抽 replayCards()、golden test。
S0 不通过就别往下做：3 天内做不到「真实库重放 0 差异」就退回「以 cards 为准 + 冲突副本」。

硬约束（已定，不要再讨论）：
- MIT 许可证；AGPL/GPL 只读不抄
- 只做 DeepSeek/OpenAI/Gemini/GLM；不装 pi-ai；不做自定义端点
- 便携版 zip + 启动器换目录；不做安装包、不做签名、不用 electron-updater / latest.yml
- 数据永远在 %APPDATA%\WordMemo；应用只下载，启动器换目录；不做静默重启
- 同步只做结构化数据，图片/文件永久不同步；同步密钥用用户口令（age passphrase + kdfVerifier），没有恢复密钥
- 多个库用方案 A（进度跟单词走，每库一份新词额度；复制笔记不复制进度）

S0 的关键点（详见 PLAN-SYNC §3.2/§3.3/§5）：
- 加 uid 是 schema 变更：先 backupBeforeMigrate、升 SCHEMA_VERSION；迁移只加不删。
- 变更捕获不靠触发器，靠写入口统一走 withSync；replayCards() 必须能复现现有 cards。
- 同步 op 用 ts_utc（epoch ms），due_at 保持本地时间；本地 localIso() 不能跨设备比较。
- 先只在本机验证（两个 WORDMEMO_DATA_DIR 造两台设备），不连网、不写远端。
- 考试模式、buried、learn_mark 是重放最难对齐的位置，先列出来逐个处理。

每做完一阶段：npm run typecheck + npm test + npm run build，在 PLAN-SYNC 的实现记录里记一笔，git commit -s。
```

---

## 10. 维护纪律

- **一次只做一个功能**，做完在对应计划的「实现记录」里写一笔，然后 commit。
- 建议每个功能开一个分支：`feat/providers`、`feat/decks`、`feat/portable-u1`、`feat/portable-u2`、`feat/portable-u3`、`feat/sync`。
- 提交信息用 `feat|fix|refactor|docs(scope): ...`。
- 贡献者用 DCO（`git commit -s`），不引入 CLA。
- **便携版产物不进 git**：`release/` 与 `WordMemo-Portable/` 都已 gitignore；发版时只上传 `WordMemo-x.y.z-portable.zip` + `.sha256` + `latest.json`（`npm run dist` 已生成三件套）。
- **发版流程**（U3 起）：改 `package.json` 与 `package-lock.json` 顶部的两处版本 → 在 `release-notes/` 加 `v<version>.md`（三行）→ 提交 → `git tag v<version>` → `git push origin v<version>`；CI 会 typecheck/test/build/dist + 三件套断言 + 建 Release。`latest.json` 只能由脚本/CI 生成，不要手工上传覆盖。
- **界面灰字规则**（2026-11-18 定）：UI 上的小字只回答「我现在要做什么、会发生什么」。实现原因、发布流程、给维护者看的说明（例如「对应 Anki 的 learn ahead」「改完代码要重启」「不用等发版」）一律不进 UI——放这里、README 或设置页「高级与诊断 → 诊断信息」里。加灰字前先问：用户看完会多做/少做一个动作吗？不会就别加。
- **用户可见消息的级别**（2026-11-20 定）：错误 = 功能结果出错/不可用（红色、常驻铃铛）；警告 = 异常但不影响功能（黄色/内嵌提示、不常驻）；提示 = 成功、进度、少做一个前置动作。细节与判定顺序见 [MESSAGES.md](MESSAGES.md)，**改文案前先按它定级**，不要为了让提示显眼就升成 `err`。
- **不要做的**：改许可证、把 AGPL 代码抄进来、装 pi-ai（除非供应商超过 4 家）、加安装包/签名、同步附件、把 `scripts/ocr-lab/runs/` 或 `gt/` 加回仓库。






