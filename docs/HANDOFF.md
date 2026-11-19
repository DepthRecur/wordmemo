# 交接文档（给下一个会话 / 未来的自己）

> 最后更新：2026-11-19　当前分支：`master`　仓库：`DepthRecur/wordmemo`（本地已 init，尚未 push）
> 这份文档的目的：**新会话读完它就能直接干活**，不需要重新讨论已经定过的事，也不需要重新调研。

---

## 0. 一句话现状

背单词桌面应用（Electron 38 + React 19 + `node:sqlite` + `ts-fsrs`）已可用。现在要加 4 个功能，顺序是：**多供应商 → 多个库 → 便携版自更新 → 云端同步**。第一个功能（多供应商）**P0–P3 全部完成并验证**：四家都能配 Key、角色路由（默认/视觉）、设置页六分区、模型可搜索下拉（公开名 + id + 价格）、模型目录与价格自动化、按家统计与 `npm run ai-smoke`。**DeepSeek 与 GLM 都已在真机验证**（GLM 2026-11-19，`npm run ai-smoke` 4/4）；OpenAI / Gemini 等社区反馈。下一个功能是**多个库**。

---

## 1. 五分钟上手

```powershell
cd D:\ymh\Code\tools\wordmemo
npm install          # 只有删过 node_modules 才需要
npm run typecheck    # tsc --noEmit，必须 0 错误
npm test             # vitest，11 个测试文件（106 项）必须全绿
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
  schema.ts        ← 表结构（ai_cache 新唯一键；ai_catalog / ai_pricing；ai_usage 带 cost_source）
  connection.ts    ← migrate()：addColumnIfMissing() + migrateAiCacheUnique()（重建表）
  ai.ts            ← 缓存/用量/月度费用/按家用量/目录与价格的读写
  notes.ts / items.ts / cards.ts / stats.ts / importDrafts.ts  ← 库功能将来要改这里
src/main/index.ts  ← 启动、托盘、提醒、备份；30 秒后后台刷新目录/价格
src/renderer/src/pages/SettingsPage.tsx ← 左侧 6 分区（供应商/角色/复习/提醒/发音/高级与诊断）
src/renderer/src/components/ModelPicker.tsx ← 模型可搜索下拉（公开名 + id + 价格，允许手填）
src/renderer/src/pages/StatsPage.tsx    ← 本月 AI 花费按供应商拆分
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
  settings-secrets.test.ts ← 5 项：secrets.bin → v2 迁移 + 多 Key 并存
  settings-ai.test.ts   ← 4 项：ai 深合并 + apiKeySet 跟随默认角色
  core.test.ts / drafts.test.ts / phonetic.test.ts ← 既有（25 / 10 / 3 项）
docs/               ← 四份计划 + 调研 + 本文件
```

---

## 5. 多供应商已完成（冻结）；下一步：多个库

**多供应商 P0–P3 + UI 打磨全部完成并冻结**（2026-11-18 ~ 11-19）。`typecheck` 0 错误、`npm test` 11 文件 106 项全绿、真机通过。实现记录见 [PLAN-PROVIDERS §13](PLAN-PROVIDERS.md)（五条，最后两条是 UI 打磨与 GLM 验证）。

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

### 5.1 下一个功能：多个库（PLAN-DECKS）

对照 [PLAN-NEXT](PLAN-NEXT.md) §6 与 [PLAN-DECKS](PLAN-DECKS.md)（§1 有 6 条验收场景，先照着写死）：

1. **先收作用域**：把 `dailyPlan / learnQueue / dueQueue / countDue / learnedTodayCount` 的「当前库」收成一个 helper（**先改这里，别先改页面**）。
2. 建 `decks` 表 + `notes.deck_id` + 默认库迁移（迁移前先备份，见 §8 坑 1）。
3. 再改 6 个入口与设置页；复制笔记**不复制进度**；每库一份每日新词额度（方案 A）。
4. 建议开分支 `feat/decks`（前几个功能都在 master 上做的）。

### 5.2 多供应商残留欠账（不阻塞多个库）

- models.dev 的 `tiers`（按上下文长度分段计价）没接，长上下文会低估。
- 「厂商响应自报价格」（§4.2 第 1 级）只是枚举位，4 家都没给。
- 冒烟复制数据目录时必须连 **`Local State`** 一起复制（safeStorage 密钥在那）。
- `glm-5.x-flash` 判分约 22 秒（强制思考）；想快就让用户换 `glm-4.6` / `glm-4.7`。

---

## 6. 后面三个功能各自的"第一步"

| 功能 | 第一步 | 注意 |
|---|---|---|
| 多个库 | 建 `decks` 表 + `notes.deck_id` + 默认库迁移 | **先把 `dailyPlan/learnQueue/dueQueue/countDue/learnedTodayCount` 的作用域收成一个 helper**，再改页面 |
| 便携版 | `electron-builder --dir` 出 `win-unpacked`，写 `app/version.json`，启动器 v0 | **先确认 `%APPDATA%\WordMemo` 有数据、程序目录没有数据** |
| 同步 | S0：`uid` + `replayCards()` + golden test | **S0 不通过就别往下做**；退路是「以卡为准 + 冲突副本」 |

---

## 7. 测试与反馈（没有 Windows 虚拟机也能测）

### 7.1 本机（这台）

- `npm run typecheck` / `npm test`：每次改完都跑。
- `npm run dev`：开发模式看界面。`npm run ai-smoke`：真机自检（4 个调用点 × 4 家，没 Key 的家 `SKIP（无 Key）`，会花几次极短调用；跑之前先退出正在运行的应用）。
- **界面截图验收**：离屏窗口必须 `webPreferences.backgroundThrottling: false`，并且用 CDP `Page.captureScreenshot`（`capturePage()` 会返回上一帧，还会把 CSS transition 卡在中间态，看起来像两个分项同时高亮）。

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

1. **迁移跑在备份之前**：`openDb()` 内部迁移，`dailyBackup()` 在后 → 已在计划里要求改成「迁移前备份」。
2. **同步的时间戳没有时区**：`localIso()` 是本地时间，跨设备比较会错 → 同步 op 要另加 `ts_utc`。
3. **批量删除连带删词条**：`deleteNote` 会清理孤儿 items（卡片/复习记录一起没）。
4. **便携版数据不能放程序目录**：`index.ts:22-26` 的 dev 逻辑要把数据塞进 `.data`，必须确认打包后不生效。
5. **库的作用域漏一处就串库**：先收 helper，再改查询。
6. **`--no-sandbox` 是这台机器的硬需求**：三保险（代码开关 + 启动器 + 崩溃探针）。

---

## 9. 新会话开场提示词（直接复制粘贴）

```
继续 WordMemo（D:\ymh\Code\tools\wordmemo）。先读 docs/HANDOFF.md，
再读 docs/PLAN-NEXT.md 的 §5（已定决策）、§7（坑点）、§8（待定）；
要做「多个库」时读 docs/PLAN-DECKS.md（§1 是 6 条验收场景）；
多供应商已经冻结，实现记录在 docs/PLAN-PROVIDERS.md §13（只修 bug，不加功能）。

硬约束（已定，不要再讨论）：
- MIT 许可证；AGPL/GPL 只读不抄
- 只做 DeepSeek/OpenAI/Gemini/GLM；不装 pi-ai；不做自定义端点
- 便携版 zip + 启动器换目录；不做安装包、不做签名、不用 electron-updater
- 同步只做结构化数据，图片/文件永久不同步；同步密钥用用户口令
- 多个库用方案 A（进度跟单词走，每库一份新词额度；复制笔记不复制进度）

当前状态：git 已 init（master，最近提交见 git log）。多供应商已完成并冻结：
四家可配 Key、角色路由 default/vision、设置页六分区、模型可搜索下拉（公开名 + id）、
模型目录与价格自动化、按家统计、npm run ai-smoke。typecheck 0 错误、
npm test 11 文件 106 项全绿。真机：DeepSeek、GLM 已验证；OpenAI / Gemini 未验证
（没有 Key，等社区反馈）。

下一步：按 HANDOFF §5 做「多个库」——
1) 先把 dailyPlan/learnQueue/dueQueue/countDue/learnedTodayCount 的作用域收成一个 helper；
2) 建 decks 表 + notes.deck_id + 默认库迁移（迁移前先备份）；
3) 再改 6 个入口与设置页；验收照 PLAN-DECKS §1 的 6 条场景。
建议开分支 feat/decks；做完在 PLAN-DECKS 里记一笔并 commit（git commit -s）。
```

---

## 10. 维护纪律

- **一次只做一个功能**，做完在对应计划的「实现记录」里写一笔，然后 commit。
- 建议每个功能开一个分支：`feat/providers`、`feat/decks`、`feat/portable`、`feat/sync`。
- 提交信息用 `feat|fix|refactor|docs(scope): ...`。
- 贡献者用 DCO（`git commit -s`），不引入 CLA。
- **界面灰字规则**（2026-11-18 定）：UI 上的小字只回答「我现在要做什么、会发生什么」。实现原因、发布流程、给维护者看的说明（例如「对应 Anki 的 learn ahead」「改完代码要重启」「不用等发版」）一律不进 UI——放这里、README 或设置页「高级与诊断 → 诊断信息」里。加灰字前先问：用户看完会多做/少做一个动作吗？不会就别加。
- **不要做的**：改许可证、把 AGPL 代码抄进来、装 pi-ai（除非供应商超过 4 家）、加安装包/签名、同步附件、把 `scripts/ocr-lab/runs/` 或 `gt/` 加回仓库。
