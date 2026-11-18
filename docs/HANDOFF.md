# 交接文档（给下一个会话 / 未来的自己）

> 最后更新：2026-11-18　当前分支：`master`　仓库：`DepthRecur/wordmemo`（本地已 init，尚未 push）
> 这份文档的目的：**新会话读完它就能直接干活**，不需要重新讨论已经定过的事，也不需要重新调研。

---

## 0. 一句话现状

背单词桌面应用（Electron 38 + React 19 + `node:sqlite` + `ts-fsrs`）已可用。现在要加 4 个功能，顺序是：**多供应商 → 多个库 → 便携版自更新 → 云端同步**。第一个功能（多供应商）**P0–P3 全部完成并验证**：四家都能配 Key、角色路由（默认/视觉）、设置页四张卡片、模型目录与价格自动化、按家统计与 `npm run ai-smoke`。**功能已冻结**，只差 GLM 的真机验证（等 Key）和 OpenAI/Gemini 的社区反馈。下一个功能是**多个库**。

---

## 1. 五分钟上手

```powershell
cd D:\ymh\Code\tools\wordmemo
npm install          # 只有删过 node_modules 才需要
npm run typecheck    # tsc --noEmit，必须 0 错误
npm test             # vitest，10 个测试文件（95 项）必须全绿
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
src/renderer/src/pages/SettingsPage.tsx ← 四张供应商卡片 + AI 角色区 + 目录/价格行
src/renderer/src/pages/StatsPage.tsx    ← 本月 AI 花费按供应商拆分
scripts/Launcher.cs ← 便携版启动器的基础（将来扩展成换目录）
scripts/gen-pricing.mjs ← 重新生成价格快照（调价时跑一次）
scripts/ai-smoke.mjs    ← npm run ai-smoke（启动 Electron + --ai-smoke）
tests/
  providers.test.ts     ← 15 项：传输层/供应商表/错误归一化
  ai-client.test.ts     ← 13 项：client 接线 + 角色路由 + 400 降级（stub fetch，不联网）
  ai-pricing.test.ts    ← 12 项：价格三级来源/目录解析/未定价用量/预算兜底
  ai-cache-key.test.ts  ← 2 项：ai_cache 唯一键重建
  ai-db.test.ts         ← 5 项：provider 列 + 老库迁移回填
  settings-secrets.test.ts ← 5 项：secrets.bin → v2 迁移 + 多 Key 并存
  settings-ai.test.ts   ← 4 项：ai 深合并 + apiKeySet 跟随默认角色
  core.test.ts / drafts.test.ts / phonetic.test.ts ← 既有（25 / 10 / 3 项）
docs/               ← 四份计划 + 调研 + 本文件
```

---

## 5. 多供应商已收尾；下一步：GLM 验证 + 多个库

**多供应商 P0–P3 全部完成并冻结**：四家可配 Key、角色路由（default/vision）、设置页四张卡片、模型目录（`/models` + TTL）、价格（models.dev → 快照 → 未知不猜价）、按家统计、`npm run ai-smoke`。typecheck 0、`npm test` 10 文件 95 项全绿、真机通过。四条实现记录见 [PLAN-PROVIDERS §13](PLAN-PROVIDERS.md)。

### 5.1 还差的两件小事（不需要动架构）

1. **GLM 真机验证（等用户拿到 Key）**：`npm run ai-smoke` 跑一遍 → 全通过就把 `src/main/ai/providers.ts` 里 GLM 的 `unverified: true` 去掉，README 状态表改成「已验证」，并且**改一行**就够（不用动别的）。
2. **OpenAI / Gemini**：等真实用户反馈（作者没有该地区账号）。报错走「设置页 → 复制诊断信息」，按 §9.1 的表改文案/参数即可，不用发版。

### 5.2 下一个功能：多个库（PLAN-DECKS）

第一步按 [PLAN-NEXT](PLAN-NEXT.md) §6 与 [PLAN-DECKS](PLAN-DECKS.md)：

1. **先收作用域**：把 `dailyPlan / learnQueue / dueQueue / countDue / learnedTodayCount` 的「当前库」收成一个 helper（**先改这里，别先改页面**）。
2. 建 `decks` 表 + `notes.deck_id` + 默认库迁移（迁移前先备份，见 §8 坑 1）。
3. 再改 6 个入口与设置页；复制笔记**不复制进度**；每库一份每日新词额度（方案 A）。

### 5.3 多供应商留下的欠账（记着就行，不阻塞）

- models.dev 的 `tiers`（按上下文长度分段计价）没接，长上下文会低估。
- 「厂商响应自报价格」（§4.2 第 1 级）只是枚举位，4 家都没给。
- 冒烟时若复制数据目录，**必须连 `Local State` 一起复制**，否则 safeStorage 解不开 Key（见 PLAN-PROVIDERS §13 P3 的坑）。

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
- `npm run dev`：开发模式看界面。

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

- 用 `tests/fixtures/` 的录制样例跑单测（P1 会加）
- UI 上标「未验证」，失败时给「复制诊断信息」
- README 维护一张状态表：已验证 / 未验证 / 已知问题

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
需要动多供应商时读 docs/PLAN-PROVIDERS.md，特别是 §13 实现记录。

硬约束（已定，不要再讨论）：
- MIT 许可证；AGPL/GPL 只读不抄
- 只做 DeepSeek/OpenAI/Gemini/GLM；不装 pi-ai；不做自定义端点
- 便携版 zip + 启动器换目录；不做安装包、不做签名、不用 electron-updater
- 同步只做结构化数据，图片/文件永久不同步；同步密钥用用户口令
- 多个库用方案 A（进度跟单词走，每库一份新词额度）

当前状态：git 已 init（master），**多供应商 P0–P3 全部完成并冻结**：四家都能配 Key、
角色路由 default/vision、设置页四张卡片、secrets.v2 多 Key（旧 secrets.bin 自动迁移）、
模型目录（/models，TTL 24h）、价格（models.dev → 随包快照 → 未知不猜价）、按家统计、
npm run ai-smoke。typecheck 0 错误、npm test 10 文件 95 项全绿、真机通过。
DeepSeek 已验证；GLM 等用户 Key 后验证；OpenAI / Gemini 等社区反馈。

下一步（二选一，都在 HANDOFF §5）：
1) GLM 拿到 Key 后：npm run ai-smoke → 全过就把 providers.ts 里 GLM 的 unverified 去掉、
   README 状态表改成已验证（一行改动）。
2) 开始「多个库」：先按 PLAN-DECKS 把 dailyPlan/learnQueue/dueQueue/countDue/
   learnedTodayCount 的作用域收成一个 helper，再建 decks 表 + notes.deck_id + 默认库迁移。
做完在对应计划里记一笔并 commit（git commit -s）。
```

---

## 10. 维护纪律

- **一次只做一个功能**，做完在对应计划的「实现记录」里写一笔，然后 commit。
- 建议每个功能开一个分支：`feat/providers`、`feat/decks`、`feat/portable`、`feat/sync`。
- 提交信息用 `feat|fix|refactor|docs(scope): ...`。
- 贡献者用 DCO（`git commit -s`），不引入 CLA。
- **不要做的**：改许可证、把 AGPL 代码抄进来、装 pi-ai（除非供应商超过 4 家）、加安装包/签名、同步附件、把 `scripts/ocr-lab/runs/` 或 `gt/` 加回仓库。
