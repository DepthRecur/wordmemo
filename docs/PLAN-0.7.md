# 0.7.0 改进计划（2026-11-25 定稿，次日开工；**2026-11-26 已发布**）

> 来源：[BACKLOG.md](BACKLOG.md) 的勾选结果（2026-11-25）。
> 基线：`master` @ `0e54d70`（0.6.0）。目标版本 **0.7.0** → 已发布（tag `v0.7.0`，`8c36342`）。
> 原则：**一条一提交**，能独立回退；先做「会咬人」的，再做「锦上添花」的；文档改动集中在最后一批。

---

## 0.2 进度（每做完一条勾一笔）

分支：`feat/0.7-backlog`（2026-11-26 早上开工，上午一轮）

| 条目 | 状态 | 提交 |
|---|---|---|
| 计划与决策归档 | ✅ | `f9bc295 docs: record the 0.7 backlog decisions and execution plan` |
| A-01 同步静默假成功 | ✅ | `d0a93ca fix(sync): join an in-flight run instead of faking success` |
| A-04 skipped 上报 | ✅ | `cd6f45b fix(sync): surface skipped records instead of dropping them silently` |
| A-03 时钟夹取 | ✅ | `4bbb393 fix(sync): clamp remote timestamps so a fast clock cannot win forever` |
| A-02 旧库闸门 + C-04 迁移失败提示 | ✅ | `c2f3db3 fix(db): refuse a database newer than this build, and report the backup` |
| E-04 `--data-dir` | ✅ | `…feat(app): one --data-dir switch so smoke runs never touch real data` |
| D-02 额度降级 | ✅ | `…feat(sync): pause auto sync when the GitHub quota is nearly gone` |
| D-01 checkpoint 双份归档 | ✅ | `…feat(sync): keep two monthly checkpoint archives` |
| B-02 清空 AI 缓存 | ✅ | `…feat(ai): clear the answer cache from settings` |
| C-02 删库后刷新列表 | ✅ | `…fix(ui): refresh the library list after deck changes in settings` |
| F-04 日志轮转 + 导出诊断 | ✅ | `…feat(diag): rotate the log and export a diagnostics bundle` |
| F-06 粘贴图片 | ✅ | `…feat(import): paste an image straight into the import page` |
| A-06 考试范围按 uid 同步 | ✅（勾选后新增那条） | `…fix(sync): send exam note/item scope as uids, not local ids` |
| C-05② 考试页标签筛选 | ✅ | `…feat(exam): filter the exam scope by tags` |
| D-06 边界测试 | ✅ | A-01 的 5 项 + `tests/sync-cancel.test.ts`（2 项）+ manager 1 项；断开连接现在会让在飞的同步在阶段边界作废 |
| E-02 发布材料（文字） | ✅ | README「常见现象 / 被拦截怎么加白」+ `.github/ISSUE_TEMPLATE/bug_report.yml`；4 张截图留占位 |
| 「不做」的 23 条落档 | ✅ | 分别写进 PLAN.md §14.1 / PLAN-SYNC §9 / PLAN-PROVIDERS / PLAN-DECKS / PLAN-UPDATE / README 已知限制 |
| G-01 / G-02 全部、G-03 大部分 | ✅ | 两份 handoff 的进度、分支、测试数；README 启动章节、`--no-sandbox` 口径、日志路径、测试条数 |
| G-04 / G-05 / G-06 | ✅ | PLAN-UPDATE（CI 断言、首个可更新版本、备份 3 份作废、手动清单）；PLAN-SYNC（§7 对策表加 0.7 状态、§8 建议升已定、§4 记 A-06 格式变化、§10 末尾加「与 §3 不一致」表）；GITHUB-SELECTION 依赖表、BUGS-DECKS:28、PLAN-DECKS lastDeckId、test-package 设备名 |
| D-05 删除影子 30 天清理（方案 B） | ✅ | `e08bda2 feat(sync): purge deletion shadows after 30 days`；回收站 UI 留后续版本 |
| D-08 截图 | ⬜ | 你手动补图 |
| 0.7.0 发版 | ✅ | `8c36342 merge: 0.7.0（BACKLOG 勾选的 16 条改进）`；tag `v0.7.0`，CI run `45753172826` |

**当前基线**：`npm run typecheck` 0 错误；`npm test` **41 文件 / 324 项（313 通过 + 11 跳过）**（以 `npm test` 输出为准），开工前是 32 文件 / 285 项。

### 断点（2026-11-26 12:20，0.7.0 已发布）

- **0.7.0 已发布**：`master` = `8c36342`，tag `v0.7.0`，CI run `45753172826`；Release 三件套核对结果见 [PLAN-SYNC.md](PLAN-SYNC.md) §10「发布 v0.7.0」。
- 本地分支 `feat/0.7-backlog` 仍保留（可留作这次改动的整体回退点），没有删除。
- 剩下没做的只有两件，都不阻塞：① D-05 的回收站（要升 schema v5 + payload 快照，独立一轮做）；② D-08 的 4 张截图（你补，README 里留了占位）。
- 这次的「明确不做」清单已写进 [BACKLOG.md](BACKLOG.md) 与各 PLAN 文档，下一轮不要重新讨论。

---

## 0. 决策汇总

| 类别 | 条数 | 编号 |
|---|---|---|
| **做（改代码）** | 16 条（C-05 只做②） | A-01 A-02 A-03 A-04 · B-02 · C-02 C-04 C-05② · D-01 D-02 D-05 D-06 · E-02 E-04 · F-04 F-06 |
| **只改文档** | 10 条 | A-05 B-03 D-03 D-08 F-09 · G-01~G-06 |
| **不做（写进「明确不做」）** | 23 条 | B-01 C-01 C-03 D-04 D-07 E-01 E-03 E-05 F-01 F-02 F-03 F-05 F-07 F-08 F-10 F-11 F-12 F-13 F-14 F-15 F-16 F-17 · 其中 D-04/D-07/E-01/E-03 要顺带改文档 |

> 注：C-05 同时含「②做 / ①不做」，表中计入「做」一次；①（库数 > 10 提示）的「不做」写进 `PLAN-DECKS.md` §14。
> A-06 是勾选后新发现的一条，尚未定，见 §0.1。

你的理由已记在 `BACKLOG.md` 里（例：B-01「目前没碰到上传图片的问题」、F-13「学生学不到 10000 词以上」、C-01「除了导词书不会产生 1000 量级笔记」、B-03「不因预算强行终止，允许赊账」、D-03「目标用户多有 VPN」、E-01「连不上 GitHub 只能手动下载」）。写「明确不做」时我会把理由一起写进去，避免下一轮再讨论。

---

## 0.1 开工前需要你点头的三件事（今天新发现）

### ① 新发现一个同步 bug：考试范围里的「指定笔记」会串到别的设备
- **是什么**：`scopeForSync()` 只把 `scope.deckId` 换成了 `deck_uid`，**`noteIds` / `itemIds` 是本地整数 id，原样发到了仓库**；`scopeFromSync()` 又原样读回来。
- **后果**：A 机器建一场「只考这 3 份笔记」的听写冲刺 → B 机器同步到这场考试后，`scope.noteIds` 指向 B 机器自己的 3 个不相关笔记（或干脆不存在）。**考试计划在 B 上是错的**，而且看不出哪里错。
- **证据**：`src/main/db/exams.ts:49-52`、`src/main/db/checkpoint.ts:1276-1287`（`noteIds`/`itemIds` 从未参与映射）。
- **和你的勾选的关系**：C-05② 要做的「考试页 tag 筛选」正好改同一段 scope 代码，**顺手修的成本很低（S）**，分开做反而要改两次。
- **建议**：并入 C-05②，一起修 + 补一条双设备测试。
- **需要你确认**：`[ ] 一起修`　`[ ] 单独排期`　`[ ] 不修（写进已知限制）`

### ② D-05「全做」必须升数据库版本（v5），请确认
- **问题**：现在 `sync_tombstones` 只有 `entity / uid / ts_utc`，**不存内容**（`schema.ts:154-159`）；删笔记时只记了 uid。所以「恢复」今天拿不出标题、正文、词条——**没有 payload 就没法恢复**。
- **要全做就得**：`sync_tombstones` 加 `payload TEXT`（删除时的整行快照）→ `SCHEMA_VERSION 4 → 5` → 触发一次真实迁移（已有 `backupBeforeMigrate` 保护）。
- **另外要接受的语义**：恢复的是**内容**，不是复习进度（删词条会级联删卡片与复习记录，那些没有单独留快照）。这条会写进 README 的「已知限制」。
- **两条路**：
  - **方案 A（你勾的「全做」）**：加 payload + 回收站 UI（设置→同步→最近删除，最多 50 条，可恢复）+ 启动时清理 30 天前。成本 **L（3 天左右）**，风险中（唯一动 schema 的条目）。
  - **方案 B（降级）**：只做「30 天清理」+ 文档写「不支持恢复」。成本 **S（2 小时）**，零风险。
- **需要你确认**：`[ ] 方案 A（升 v5，做回收站）`　`[ ] 方案 B（只清理，改文档）`
- **2026-11-26 12:00 的处理**：你没在线，按 §1 的既定规则走了**方案 B**（`purgeOldTombstones()` + README「删除不可恢复」+ PLAN-SYNC §0.7 记录），恢复 UI 与 schema v5 留到后续版本。要改回 A 的话随时说，那是一条独立可 revert 的改动，不影响 0.7.0 已发的内容。

### ③ D-08 的截图需要你提供（我留占位）
需要 4 张，我会在 README 里写好位置与图注：
1. Windows SmartScreen「Windows 已保护你的电脑」→ 点「更多信息」→「仍要运行」的过程；
2. 设置 → 同步 面板全貌（已有你可复用的：`.data/shots/portable-0.6.0-sync-panel.png`，但那是开发数据，建议用真机重拍）；
3. 「常见现象 / 被拦截怎么加白」那节需要一张杀软拦截提示；
4. （可选）GitHub Release 三件套截图。
- **需要你确认**：`[ ] 我按占位写文字，你后补图`　`[ ] 先不放图，纯文字`

---

## 1. 分支与发版策略

- 分支：`feat/0.7-backlog`（从 `master` 开），做完合回 `master`（`--no-ff`），再打 tag `v0.7.0`。
- **SCHEMA_VERSION**：只有 D-05 走方案 A 才升到 5；其余条目不碰 schema。
- 每条提交格式：`fix(sync): ...` / `feat(...): ...` / `docs(...): ...`，正文写「为什么」。
- 每完成一个阶段：`npm run typecheck && npm test`；阶段 6 之后跑 `build` + `dist` + 便携版冒烟（用新的 `--data-dir` 隔离）。
- 版本号在最后统一改（`package.json` + `package-lock.json` 顶部两处 + `release-notes/v0.7.0.md` 三行）。

---

## 2. 分阶段计划

### 阶段 1：同步正确性（A-01 / A-03 / A-04 / D-06）

**目标**：同步不再「假成功」，时钟不再让一台机器永久赢，静默跳过会上报。

| 条目 | 改动点 | 具体做法 |
|---|---|---|
| A-01 | `src/main/sync/manager.ts` | ① 把 `runSync()` 的返回值从 `boolean` 改成 `{ ran: boolean; ok: boolean }`（或抛 `AlreadyRunning`）；② 保存 `inFlight: Promise<boolean> \| null`，`running` 只作 UI 状态；③ `connect()` 若遇到「已有同步在跑」，返回「已连接，同步将在完成后自动继续」而不是「已完成第一次同步」；④ `flushBeforeQuit` 改为 `await Promise.race([inFlight, timeout(3000)])`，超时才算放弃并写日志 |
| A-03 | `src/main/db/checkpoint.ts` | ① 新增 `clampRemoteTs(ts) = Math.min(ts, Date.now() + 5*60_000)`，在 `applyRemoteOp` 与快照合并入口统一夹取；② 偏差 > 5 分钟时记一条 warning（每次同步最多一条，进 `sync_runs` + 日志），**不**打断同步 |
| A-04 | `checkpoint.ts` + `manager.ts` | `MergeStats.skipped` 不再混进 `lastSyncChanges`；写进 `sync_runs.skipped`；`> 0` 时状态里带一条**警告**级提示（按 MESSAGES 定级），文案：`有 N 条记录没能合并（已跳过），详见日志` |
| D-06 | `tests/sync-manager.test.ts`（新建） | 至少 4 个用例：①同步中再点一次 → 返回「正在同步」而非成功；②flush 在同步中 → 等它完成（假定时器/延迟 promise）；③断开连接时在飞同步的归宿（定义成「让它跑完，但不再更新状态」并测）；④并发两次 `syncNow` 只产生一次远端写入 |

**验收**：`npm test` 中 `tests/sync-manager.test.ts` 全绿；手动：连点两次「立即同步」只看到一次「正在同步」提示。
**预估**：4~6 小时。

---

### 阶段 2：启动安全与测试隔离（A-02 / C-04 / E-04）

**目标**：旧版本不会静默打开新库；迁移失败用户能看见；冒烟不再污染真实数据。

| 条目 | 改动点 | 具体做法 |
|---|---|---|
| A-02 | `src/main/db/connection.ts`、`src/main/index.ts` | ① `migrate()` 读 `fromVersion` 后先判 `fromVersion > SCHEMA_VERSION` → 抛 `DbTooNewError`；② `index.ts` 捕获后 `dialog.showMessageBox`：标题「数据库版本比这个版本新」，正文写明「请升级 WordMemo 后再打开；或从『恢复备份』换回旧库」，按钮：打开数据目录 / 恢复备份 / 退出；**不创建窗口**；③ `release-notes/v0.6.0.md` 的「可回退旧版」改成「可回退，但需要先备份；0.7.0 起旧版会拒绝打开新库」 |
| C-04 | `index.ts`、`connection.ts` | `backupBeforeMigrate()` 已经返回路径 → 把路径带进 `dialog.showErrorBox`：「迁移失败，已备份到 <path>，请把这个文件和 diagnostics.log 发给我」 |
| E-04 | `index.ts` + `settings.ts`/`tts.ts`/`secretStore.ts`/`diagnostics.ts` | ① 在 `app.whenReady()` 之前解析 `--data-dir=<abs path>`（仅打包版生效），**统一写进 `process.env.WORDMEMO_DATA_DIR`**，让所有模块读同一个值（现在是 `index.ts` 只在开发模式读、其它模块无条件读 → 会分裂）；② 未传时打包版仍固定 `%APPDATA%\WordMemo`；③ 启动日志记一条「dataDir=<path>（source=cli|default）」；④ `.data/smoke-060.ps1` 改成用 `--data-dir` 隔离，不再备份/还原真库 |

**验收**：①手工把测试库 `user_version` 改成 99 → 启动弹框且不进主界面（新测试覆盖）；②`npm test` 全绿；③用 `--data-dir` 跑一次便携版冒烟，真实 `%APPDATA%\WordMemo` 的 db 哈希不变。
**预估**：3~4 小时。

---

### 阶段 3：同步运维（D-01 / D-02）

| 条目 | 改动点 | 具体做法 |
|---|---|---|
| D-01 | `src/main/sync/engine.ts` | ① 仍写规范路径 `devices/<id>/checkpoint.json.age`（**保证旧客户端能读**）；② 同时写一份归档 `devices/<id>/checkpoint-<YYYYMM>.json.age`；③ 只保留最近 2 份归档，更早的删除；④ 拉取逻辑不变（只读规范路径），避免多端读到不同快照 |
| D-02 | `engine.ts`/`scheduler.ts`/`manager.ts` | ① 每次同步后记录 `rateLimit.remaining`；② `remaining < 100` 时**自动同步**进入「只手动」状态，状态区显示「GitHub 额度快用完了，已暂停自动同步」；③ 手动同步成功后或 `remaining` 恢复到 ≥ 100 时解除；④ 状态进 `SyncStatus`，退出重启后按时间衰减（重置时间过了就解除） |

**验收**：`tests/sync-engine.test.ts` 加 2 个用例（配额低 → 调度器不发起；恢复后发起）。
**预估**：3~4 小时。

---

### 阶段 4：回收站（D-05，视你选 A 还是 B）

**方案 B（若选它，2 小时）**：启动时清理 30 天前的 tombstone + 日志；文档写「不提供恢复」。

**方案 A（你勾的全做，约 2~3 天）**，分三步，每步可停：

1. **4a 快照（schema v5）**
   - `sync_tombstones` 加 `payload TEXT`、`deleted_at_label TEXT`；`recordTombstone()` 增加可选 `payload`。
   - 各写入口的删除路径带上快照：笔记（title + deck_uid + 词条 uid 列表）、词条（headword + meanings + pos）、库（name/uid）、考试（title/date）。
   - `connection.ts` 升 `SCHEMA_VERSION = 5`（加列，不改旧列；`migrateUids` 同样的坑：唯一索引别写进 SCHEMA）。
   - 测试：删 → tombstone 有 payload；迁移后旧库能开。
2. **4b 恢复（IPC + 逻辑）**
   - `sync:tombstones`（列表，最多 50）、`sync:restore`（按 entity+uid 恢复）。
   - 恢复 = 用**原 uid** 重新插入 + 记一条 `origin: local:restore` 的 upsert op（ts = now，必然大于 tombstone 的 ts）+ 删掉该 tombstone。
   - 笔记恢复：重建笔记 + 只重建「词条仍然存在」的关联；词条恢复：重建词条 + `ensureCards()`；库/考试直接插回。
   - **不改**卡片与复习历史（已级联删掉，恢复不回来），这一点写进 UI 提示。
   - **只恢复「本机删除」的条目**：远端删除的 op 里没有内容（`delete` op 不带 fields），所以另一台删掉的东西在本机回收站里只有 uid，恢复不出来——UI 要把这类标成「来自其它设备，无法恢复」，不要给按钮。
   - 测试：双设备 —— A 删、B 删、A 恢复 → B 同步后复活；B 先恢复、A 再删 → 以较新 ts 为准。
3. **4c UI**
   - 设置 → 同步 →「最近删除」折叠区：名称 / 类型 / 删除时间 / 恢复按钮；顶部一句「恢复的是内容，复习进度不回来」。
   - 测试：渲染 + 按钮状态（无 CDP 驱动就不写 e2e，手工验收）。

**验收**：手工删一份笔记 → 回收站出现 → 恢复 → 列表回来；另一台同步后也回来；30 天前的记录启动时被清掉。
**预估**：2~3 天（最大的一块，时间不够就先停在 4a）。

---

### 阶段 5：界面与体验（B-02 / C-02 / C-05② + A-06 / F-04 / F-06）

| 条目 | 改动点 | 具体做法 |
|---|---|---|
| B-02 | `ipc.ts`、`preload`、`SettingsPage.tsx`、`db/ai.ts` | 新增 `ai:clearCache` → `DELETE FROM ai_cache`（返回条数）；AI 分区加按钮「清空 AI 回答缓存」+ 二次确认 + 提示「换个模型后答案不一样是正常的」 |
| C-02 | `App.tsx`、`SettingsPage.tsx` | `App` 给 `SettingsPage` 传 `onLibraryChanged`（bump `libraryVersion` + `refreshStats`）；删库/改名/移动后调用 |
| C-05② + A-06（若你同意） | `ExamPage.tsx`、`exams.ts`、`checkpoint.ts` | ① 考试范围加「按标签筛选」（从当前库的标签里多选，写进 `scope.tags`）；② **顺手修**：`scopeForSync` 把 `noteIds`/`itemIds` 映射成 `note_uids`/`item_uids`，`scopeFromSync` 反解；③ 兼容：旧仓库里的 `noteIds` 数字仍按「本机 id」解释（读时若发现是数字数组且没有 uids，就当作本机范围并在下次写回时升级） |
| F-04 | `diagnostics.ts`、`ipc.ts`、`SettingsPage.tsx` | ① 写日志前检查大小，超过 2 MB 就 `rename` 成 `diagnostics.1.log`（只留 1 份备份）；② 新增 `system:exportDiagnostics`：把 `diagnostics.log` + 沙箱状态 + 版本信息打包成一个 `.txt`，走保存对话框；③ 「高级与诊断」加「导出诊断」按钮 |
| F-06 | `ImportPage.tsx` | 监听 `paste`：从 `clipboardData.files` 取图片，走与 `handleDrop` 同一条路；输入框聚焦时不劫持（避免和粘贴文本冲突） |

**验收**：手工点一遍五个入口；`npm test` 补 `ai-cache-clear`、`exam-scope-sync`（含 noteIds 映射）两个测试文件。
**预估**：4~6 小时。

---

### 阶段 6：文档与发布材料（E-02 + G-01~G-06 + 全部「不做」落档）

| 事项 | 具体做法 |
|---|---|
| E-02 文字部分 | README 新增：①「常见现象 / 被拦截怎么加白」（杀软、SmartScreen 步骤、`repair-integrity.cmd`、手动更新路径）；② SmartScreen 那节留 4 个图片占位（`shots/smartscreen-1.png` 等，带图注）；③ 加 VirusTotal 段落（给链接模板，你上传后填）；④ 新增 `.github/ISSUE_TEMPLATE/bug_report.yml`（要求：版本、系统、`diagnostics.log`、复现步骤、是否装了杀软） |
| G-01 | `HANDOFF-SYNC.md`：分支/进度/下一步全部对齐 master 与 0.7.0；删掉「master 没有同步代码」；§3 改成「0.6.0 发布复现手册」；§10 自检清单去掉 feat/sync |
| G-02 | `HANDOFF.md`：分支、版本、测试数（改成动态写法「以 `npm test` 输出为准」）、设置页 8 分区 |
| G-03 | `README.md`：修启动章节（现在实际入口：便携版 zip / `npm run dev` / 调试 bat；删掉「双击根目录 WordMemo.exe」与「build-launcher.cmd 修启动」）、测试数、`--no-sandbox` 两处说法统一、日志路径改成 `%APPDATA%`、补手动更新步骤（对应 E-01 的决定） |
| G-04 | `PLAN-UPDATE.md`：§3.2 备份 3 份标「已废弃」；§6 测试计划改成 zip/三件套；§8 版本号改 0.4.0；§3.4-4 加「0.7.0 已实现」；「常见现象」改成「见 README」 |
| G-05 | `PLAN-SYNC.md`：§8 两条改「已定」；§3 各项按现状回调（seq 缺口→「改为 etag 全量+幂等」、保留 2 份→「D-01 已实现」、向导→「单页表单」、「30 天可恢复」→按 D-05 结果写、清空远端→不做）；§9 补「不记录冲突明细」 |
| G-06 | `GITHUB-SELECTION.md`（依赖表改成实际依赖）、`PLAN-PROVIDERS.md`（§4.3 改成「当前只报 404」）、`BUGS-DECKS.md:28`（due_count 已删）、`PLAN-DECKS.md`（lastDeckId→currentDeckId、撤销 → 明确不做）、`test-package/README.md`（设备显示名） |
| 不做的 23 条 | 分别写进：`PLAN.md` §14（F 组）、`PLAN-DECKS.md` §14（库数提示）、`PLAN-SYNC.md` §9（清空远端、设置同步）、`PLAN-UPDATE.md`（真机升级闭环、自启重设）、`PLAN-PROVIDERS.md`（tiers）、`HANDOFF.md`（e2e 脚本不入库）。每条带日期 + 一句理由 + 一句「重新考虑的触发条件」 |
| F-09 只统一文案 | 三处口径统一成「复习时不默认显示音标，可点开提示」：`Review.tsx` 注释、`Notes.tsx:1033`、`PLAN.md` §6.6 |

**验收**：`grep -rn "feat/sync" docs README.md` 只剩历史记录；`grep -rn "25 项\|185 项\|7 分区" docs README.md` 无命中。
**预估**：3~4 小时。

---

## 3. 时间预算（按你「明天动手」的节奏）

| 天 | 内容 | 预计 |
|---|---|---|
| **第 1 天** | 阶段 1 + 阶段 2（同步正确性 + 启动安全）| 7~10 小时（约一个整天） |
| **第 2 天** | 阶段 3 + 阶段 4a/4b（运维 + 回收站）| 6~9 小时 |
| **第 3 天** | 阶段 4c + 阶段 5 + 阶段 6 + 发版 | 7~9 小时 |

**如果时间不够，按这个顺序砍**：① 4c 回收站 UI（保留 4a/4b + IPC，先不给人用）→ ② E-02 的截图/VirusTotal（只留文字）→ ③ 阶段 6 的 G-04/G-06（次要文档）。**绝不砍**阶段 1。

---

## 4. 测试与验收清单

**自动化**（每阶段结束都跑）
```powershell
npm run typecheck
npm test            # 现在 285 项；完成后预期 ≥ 305 项
```
新增测试文件：
- `tests/sync-manager.test.ts`（阶段 1）
- `tests/db-version-gate.test.ts`（阶段 2）
- `tests/sync-tombstone-restore.test.ts`（阶段 4，方案 A 才有）
- `tests/exam-scope-sync.test.ts`（阶段 5）
- `tests/diagnostics-rotate.test.ts`（阶段 5）

**手动验收**（发版前）
1. `--data-dir` 启动便携版 → 真实 `%APPDATA%\WordMemo` 哈希不变；
2. 把测试库 `user_version` 改 99 → 弹框拒绝；
3. 连点两次「立即同步」→ 只提示一次「正在同步」；
4. 考试范围用「指定笔记」+「标签」→ 第二台设备同步后范围正确；
5. 删笔记 → 回收站 → 恢复 → 两台都在（方案 A）；
6. 粘一张图到导入页 → 出现草稿；
7. 诊断日志超过 2 MB → 生成 `diagnostics.1.log`，「导出诊断」能出文件；
8. 清空 AI 缓存 → 再次请求会真的走网络。

---

## 5. 风险与回退

| 风险 | 影响 | 对策 |
|---|---|---|
| D-05 方案 A 升 schema v5 | 迁移失败 = 打不开 | 已有 `backupBeforeMigrate`；4a 单独提交，可 revert；迁移只加列 |
| A-02 版本闸门写错 | 正常用户也打不开 | 闸门只在 `fromVersion > 4` 触发；测试覆盖「等于/小于/大于」三种 |
| E-04 `--data-dir` | 用户误传导致「数据不见了」 | 只在命令行显式传参时生效，默认行为不变；启动日志记录来源 |
| A-03 夹取过头 | 真·未来时间被削平 | 只夹「超过 now+5min」的部分；偏差写日志便于复查 |
| 回收站恢复语义 | 用户以为复习进度也回来 | UI 明说 + README 已知限制 |
| 时间不够 | 半成品 | 每条独立提交；发版只带已完成的阶段，剩下的留到 0.7.1 |

---

## 6. 提交顺序（明天照这个做）

```
1  fix(sync): report when a sync is already running instead of faking success   ← A-01
2  fix(sync): clamp remote timestamps and warn on clock skew                    ← A-03
3  fix(sync): surface skipped records instead of dropping them silently         ← A-04
4  test(sync): cover concurrency, quit-flush and disconnect                     ← D-06
5  fix(db): refuse to open a database newer than this build                     ← A-02
6  fix(db): tell the user where the pre-migrate backup is when migration fails  ← C-04
7  feat(app): honor --data-dir so tests never touch real data                   ← E-04
8  feat(sync): keep two monthly checkpoint archives                            ← D-01
9  feat(sync): pause auto sync when the GitHub quota is nearly gone            ← D-02
10 feat(sync): snapshot deletions and let the user restore them  (4a+4b+4c)     ← D-05
11 feat(ai): clear the AI answer cache from settings                            ← B-02
12 fix(ui): refresh the library list after deck changes in settings             ← C-02
13 feat(exam): filter scope by tags and sync note ids by uid                    ← C-05② + A-06
14 feat(diag): rotate the log and export a diagnostics bundle                    ← F-04
15 feat(import): paste an image straight into the import page                   ← F-06
16 docs(release): README/issue template for blocked installs                    ← E-02
17 docs: align handoffs, plans and "won't do" lists                             ← G-01~G-06 + 19 条不做 + F-09
18 chore(release): 0.7.0                                                        ← 版本号 + release notes + tag
```

---

## 7. 明天开工前，你只需要回三件事

1. **考试范围 `noteIds` 串设备**：一起修 / 单独排期 / 不修？
2. **D-05**：方案 A（升 v5 做回收站，2~3 天）还是方案 B（只清理，2 小时）？
3. **D-08 截图**：按占位写文字（你后补图）/ 先纯文字？

其余按本计划默认执行。
