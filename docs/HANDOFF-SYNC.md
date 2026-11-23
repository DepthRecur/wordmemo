# 交接文档：同步（Sync）板块

> 写给**新会话**：读这一份就能直接开工，不用重读旧对话。
> 生成时间：2026-11-23　分支：`feat/sync`（最新提交以 `git log -1` 为准）　仓库：`D:\ymh\Code\tools\wordmemo`（远端 `DepthRecur/wordmemo`，已公开）
> 前置阅读（按顺序）：本文 → [PLAN-SYNC.md](PLAN-SYNC.md) §1–§5 与 §10 → [HANDOFF.md](HANDOFF.md) §1（命令）/§8（坑）/§10（纪律）。
> 文案规则：[MESSAGES.md](MESSAGES.md)。同步里任何用户可见的字都按它定级。

---

## 0. 一句话现状

前三个功能（多供应商、多个库、便携版 + 自动更新）**全部完结并已发版**（当前 `0.5.1`，GitHub 上有真 Release）。
同步是最后一个功能，**S0 的第一步（重放）已经做完并验证通过**，接下来接着做 S0 的剩余部分：`uid` + `withSync` + `cardFlag`。

- `npm run typecheck` → 0 错误
- `npm test` → **18 文件 / 191 项全绿**
- `npm run build` → 通过
- 工作区干净；`feat/sync` 已推送。重放的改动（`c44d531` 实现 + golden test、`8ba70a8` 判据记录）**只在 `feat/sync`，`master` 还没有**（已发布的 0.5.1 不含它）

---

## 1. 五分钟上手

```powershell
cd D:\ymh\Code\tools\wordmemo
git checkout feat/sync          # 已经在上面
npm install                     # 只有删过 node_modules 才需要
npm run typecheck
npm test                        # 18 文件 191 项
npm run build
npm run dev                     # 开发模式（脚本自带 --noSandbox）
```

- **`npm test` 报 `spawn EPERM`**：说明你在受限沙箱里（esbuild 要 spawn 命名管道），换普通 PowerShell/CMD 跑。
- **手动启动主进程看界面**：先 `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`（DSH 这类工具会把它设成 1，Electron 会被当 node 跑，报 `Cannot read properties of undefined (reading 'isPackaged')`），再 `. \node_modules\electron\dist\electron.exe . --no-sandbox`。
- 应用是单实例的，改完代码要真退出（托盘右键 → 退出）再启动。

---

## 2. 已完成，不要再回头改

### 2.1 便携版 / 自动更新（完结）

- `0.4.0` 是「可更新基线」，`0.5.0`（文案修正）、`0.5.1`（下载超时修复）由 GitHub Actions 自动发 Release；仓库已公开，`latest.json` / zip / `.sha256` 三件套齐全。
- 应用侧：启动 60 秒检查一次（24h 间隔、失败退避 1→2→4→6h），下载 + 流式 sha256 + 解压校验，只提示「下次启动生效」；启动器下一次启动换目录、失败回滚。
- 0.5.1 把「30 分钟总时长上限」改成「连续 5 分钟没有新数据才算卡住 + 3 小时上限」——慢速线路（实测 15–45 KB/s）下确实能下完，别改回去。
- **B/C 两台机器不再测试**（已决定）；更新失败的兜底 = 用户自己去 GitHub Release 下 zip。
- 细节在 [PLAN-UPDATE.md](PLAN-UPDATE.md) §10「真机验收」「真实发布链路」。**便携版板块不要再动。**

### 2.2 同步 S0 第一步：重放（判据通过）

PLAN-SYNC §5 原本写着「重放做不到就打退路」。**结论：重放成立**，不用退。

代码：

| 位置 | 内容 |
|---|---|
| `src/main/fsrs.ts` | `replayCard(reviews, cardId?)`：从复习记录重放卡片状态；`initFsrs` 里 `enableFuzz: false` |
| `src/main/db/cards.ts` | `applyReview(input, now = new Date())`：可选时钟（测试用来钉时间，生产不传） |
| `tests/replay.test.ts`（新） | golden test：走真实写入口造轨迹 → 重放 → 与库里那张卡逐字段比 |

验证结果：`due_at / state / reps / lapses / stability / difficulty / fsrs_json` 全部相等；连跑三次逐字节一致。

**三个必须记住的结论**：

1. **`enableFuzz` 必须关**。开着时间隔有 ±5% 随机抖动，两台设备重放同一串复习会得到不同 `due_at`，「cards = f(reviews)」直接不成立。关掉只影响间隔抖动，不动记忆模型。
2. **`newCard()` 每次生成随机 `cardId`**（ts-fsrs 内部 uuid），它会写进 `fsrs_json`。重放要么传原卡的 `cardId`，要么比较时忽略它。
3. **`applyReview` 今天不看 `mode`**（考试模式只影响冲刺规划里的模拟，不改调度）。所以重放只需要 `(reviewed_at, rating)`；哪天考试模式真改了调度，`applyReview` 和 `replayCard` 必须一起改。
4. 附带影响：`reviews.reviewed_at` 只存到秒（`localIso`），生产时钟带毫秒，早复习时这点差别会被放大到几秒，**合并后本地那张卡的 `due_at` 会挪动几秒**。可接受（每台设备从同一批记录重放会得到同一结果；`due_at` 只用于排序/到期）。

记录在 [PLAN-SYNC.md](PLAN-SYNC.md) §10「S0 第一步」。

---

## 3. 下一步：S0 剩余（先做这个，别跳到 S1）

### 3.1 给同步用表加 `uid`

目标：`notes`、`items`、`reviews`、`exams` 各有 `uid TEXT`（**UNIQUE**）。`decks.uid` 已经有了，照它的样子做。

现成的东西：

- `src/main/db/uid.ts` 的 `newUid(time)`：26 位 ULID，`newUid(Date.parse(created_at))` 可以按创建时间回填；
- `src/main/db/decks.ts:184` 的插入语句就是现成范式（`INSERT INTO decks (uid, …) VALUES (?, …)` 配 `newUid()`）；
- `connection.ts` 的 `addColumnIfMissing(db, table, column, definition)` 与 `backupBeforeMigrate()`（`src/main/index.ts` 启动时会在 `openDb` 之前调用，迁移前自动备份）。

要动的位置：

1. `src/main/db/schema.ts`：四张表的 `CREATE TABLE` 里加 `uid TEXT`；`SCHEMA_VERSION` 2 → **3**；加四个 `CREATE UNIQUE INDEX IF NOT EXISTS ux_<table>_uid ON <table>(uid)`（新库走这里）。
2. `src/main/db/connection.ts` 的 `migrate()`：老库走 `addColumnIfMissing` + 回填 + 建唯一索引。
   - 回填 SQL 用「先查 id/created_at，再逐行 `newUid`」或者 SQL 里拼 ULID 都行，**但必须保证非空且唯一**；`ALTER TABLE ... ADD COLUMN uid TEXT` 之后所有老行都是 NULL，SQLite 的唯一索引允许多个 NULL，所以必须回填，不能只加列。
   - `reviews` 用 `reviewed_at`、其余用 `created_at` 做 ULID 的时间前缀。
   - 迁移只加不删；`user_version` 单调递增；迁移包在现有的事务里（`migrateDecks` 那种 `BEGIN IMMEDIATE`）。
3. 新行生成 uid（**每个 INSERT 都要**）：
   - `notes.ts`：`createNote`、`copyNotes`（`INSERT … SELECT` 那条要逐个生成，不能沿用源行的 uid）；
   - `items.ts`：`upsertItem` 的新增分支；
   - `exams.ts`：`createExam`；
   - `cards.ts`：`applyReview` 里的 `INSERT INTO reviews`；
   - 其它插入点用 `grep -n "INSERT INTO \(notes\|items\|reviews\|exams\)"` 自己扫一遍，**别漏**。
4. 测试（新文件 `tests/uid.test.ts`，仿 `tests/replay.test.ts` 的临时库写法）：
   - 老库迁移：建库后 `ALTER TABLE notes DROP COLUMN uid`（SQLite ≥3.35 支持）+ `PRAGMA user_version = 2`，关库重开 → 每行都有 uid、互不相同、格式是 26 位；
   - 新行：`createNote` / `upsertItem` / `applyReview` / `createExam` 各造一行，uid 非空且唯一；
   - `copyNotes` 复制出来的笔记 uid 与源不同。

### 3.2 写入口统一 `withSync`

按 [PLAN-SYNC.md](PLAN-SYNC.md) §3.4：

- 新表 `sync_ops(seq INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, entity TEXT NOT NULL, op TEXT NOT NULL, fields TEXT NOT NULL DEFAULT '{}', origin TEXT NOT NULL DEFAULT 'local', ts_utc INTEGER NOT NULL, pushed INTEGER NOT NULL DEFAULT 0)`；
- `withSync(entity, uid, op, fields, fn)`：在**同一条事务**里执行 `fn` 并写一条 op（用现成的 `tx()`；注意别嵌套 `tx`，要么内部复用，要么只在外层开）；
- `origin != 'local'` 的 op 不推送（防回声）；
- 改动集中在 §3.1 列出的写函数，别散到各处。

### 3.3 `cardFlag`

`cards` 的 `suspended` / `learn_mark` / `buried_until` / `needs_check` 不是重放得来的，作为 `cardFlag` 事件同步（字段级 LWW），S0 只需把「写这些字段的入口」找出来（`setDirection`、`markItemLearned`、`applyReview` 里的 bury、`updateItem` 相关）并包进 `withSync`。

### 3.4 S0 收尾验收

- `npm run typecheck` 0 错误、`npm test` 全绿（含新的 uid 测试与回归的重放测试）；
- 拿一台真实库（`%APPDATA%\WordMemo\wordmemo.db` 的副本）跑迁移：备份生成在 `backups/wordmemo-pre-migrate-v2.db`，迁移后每行 uid 齐全、卡片与复习记录数量不变；
- 不连网、不写远端；
- 在 [PLAN-SYNC.md](PLAN-SYNC.md) §10 记一笔，`git commit -s`。

---

## 4. 更后面（S1–S4 摘要，别提前做）

| 阶段 | 做什么 | 验收 |
|---|---|---|
| **S1** 本地队列与快照 | `sync_ops` 写读、checkpoint 序列化、tombstone、合并引擎；`.wmsync` 快照导出/导入 | 用两个 `WORDMEMO_DATA_DIR` 当两台设备：A 导出 → B 导入 → 双向各改一条 → 再对齐 → 内容一致；重复导入 10 次结果不变（幂等） |
| **S2** 加密与传输 | 口令强度 + `kdfVerifier` + `safeStorage`；GitHub 客户端（条件请求、Contents/Git Data、PAT 校验、错误归一）；连接向导 + 状态面板 + 退避 | 真私有仓库两台设备自动同步；改坏仓库文件 → 报「文件损坏」；PAT 撤销 → 报「PAT 失效」；断网 10 分钟恢复后自动补上 |
| **S3** 冲突与设备管理 | 并集/LWW/tombstone 全规则、`sync_devices` 游标、移除设备、换密码全量重推 | 同一词条两台各加一个释义 → 两个都在；一台改释义一台改音标 → 都保留；一台删一台改 → 按 ts 判定且可解释 |
| **S4** 打磨与文档 | README「同步」章节（会泄露什么/不会泄露什么）、丢密码说明、错误对照表、体积提示 | 没看过代码的人照文档 10 分钟连上 |

**S1 之前不要写任何网络代码**：先在本机用两个数据目录把合并跑通，成本最低。

---

## 5. 代码地图（要碰的地方）

| 路径 | 作用 / 这次要动什么 |
|---|---|
| `src/main/db/schema.ts` | 全表 DDL + `SCHEMA_VERSION`；S0 加 uid 列与唯一索引、版本 2→3 |
| `src/main/db/connection.ts` | `openDb` / `migrate` / `tx` / `localIso` / `addColumnIfMissing` / `backupBeforeMigrate`；S0 迁移与回填 |
| `src/main/db/uid.ts` | `newUid()`（ULID），已有，直接用 |
| `src/main/db/notes.ts` `items.ts` `exams.ts` `cards.ts` | 写入口；S0 加 uid、包 `withSync` |
| `src/main/db/decks.ts` | 已有 uid 的范式（照抄） |
| `src/main/db/dedupe.ts` | 按 `headword_norm` 合并重复词条；**S3 的冲突合并要复用它** |
| `src/main/fsrs.ts` | `initFsrs` / `reviewSnapshot` / `replayCard`；fuzz 已关，别打开 |
| `src/main/settings.ts` | 设置读写与 `mergeSettings`；S2 的 `sync` 配置进这里（**不含 PAT/口令**） |
| `src/shared/types.ts` | `Settings`、`UpdateSettings` 等类型；S2 加 `SyncStatus/Config/Result` |
| `src/main/ipc.ts` + `src/preload/index.ts` | IPC 注册与暴露（S2 的 `sync:*`） |
| `tests/replay.test.ts` | 临时库 + 固定时钟的测试写法，新测试照这个抄 |
| `docs/PLAN-SYNC.md` | 方案与实现记录（§3 方案、§5 阶段、§10 记录） |

---

## 6. 坑（做之前看一眼）

1. **迁移前必须备份**：`index.ts` 已经在 `openDb()` 之前调 `backupBeforeMigrate()`，别绕过；备份落在 `%APPDATA%\WordMemo\backups\wordmemo-pre-migrate-v<n>.db`。
2. **只加不删**：`ADD COLUMN` / `CREATE TABLE` / 建索引，不做删列改名；`PRAGMA user_version` 单调递增。
3. **唯一索引与 NULL**：SQLite 的唯一索引允许多个 NULL，所以「加了 uid 列」不等于「有 uid」，必须回填（这也是一条测试用例）。
4. **`ux_items_headword_norm`**：词条按 `headword_norm` 唯一。跨设备同词不同 uid 的归并在 S3，用 `dedupe.ts` 的规则，别自己再写一套。
5. **`localIso()` 是本地时间字符串**，不能跨设备比较；跨设备的顺序/时间戳要用 epoch ms（`ts_utc`），别混用。
6. **`reviews.reviewed_at` 只有秒级**：重放会因为毫秒丢失让 `due_at` 挪几秒（已接受）。
7. **`newCard()` 的随机 `cardId`**：重放要么传原卡 id，要么忽略该字段。
8. **asar / Electron 的坑**（如果改到便携版相关）：`fs.statSync('app.asar').size` 返回 0；删含 asar 的目录会 EBUSY 并漏句柄——只改名不直接删。同步不需要碰这些，但改启动器时记住。
9. **`ELECTRON_RUN_AS_NODE`**：本机 shell 里可能是 1，手动起 Electron 前清掉。
10. **应用单实例**：改完代码要真退出再启动；`npm run dev` 与便携版不要同时开。

---

## 7. 发版纪律（同步做完要发版时用）

- 版本：改 `package.json` + `package-lock.json` 顶部的两处；在 `release-notes/` 加 `v<version>.md`（**三行**：数据迁移 / 是否不可逆 / 改了什么），它会进 `latest.json` 的 `notes`。
- 本地先 `npm run typecheck && npm test && npm run build && npm run dist`；`release/` 与 `WordMemo-Portable/` 已被 gitignore，产物不进 git。
- 发版就是 `git tag -a v<version>` → `git push origin master` → `git push origin v<version>`；CI（`.github/workflows/release.yml`）会 typecheck/test/build/dist + 三件套断言 + 建 Release。
- **`latest.json` 只能由脚本/CI 生成**，不要手工上传覆盖。
- 这台机器到 `github.com:443` 时通时断（`Connection was reset` / 连不上），push 失败就重试几次；`.data/push-retry.ps1` 有这个重试脚本（`.data/` 已被 gitignore，只在本机）。
- 查 CI/Release 状态：`.data/gh-run.ps1`（用 Windows 凭据管理器里的 token，`-Action runs|release|assets`）。
- 同步的 schema 变更必须**先发版再让用户升级**（旧客户端读到新格式要拒绝，见 PLAN-SYNC §4 的 `formatVersion`）。

---

## 8. 红线（已定，不要再讨论）

- MIT；AGPL/GPL 只读不抄。
- 只做 DeepSeek / OpenAI / Gemini / 智谱 GLM；不装 pi-ai；不做自定义端点。
- 便携版只发 zip + 启动器换目录；不做安装包、不做签名、不用 electron-updater / latest.yml。
- 数据永远在 `%APPDATA%\WordMemo`；应用只下载，启动器换目录；不做静默重启。
- **同步只做结构化数据**，图片/文件/缓存永久不同步；密钥用用户口令（age passphrase + `kdfVerifier`），无恢复密钥；不租服务器、不做实时协作。
- 多个库用方案 A（进度跟单词走，每库一份新词额度；复制笔记不复制进度）。

---

## 9. 新会话开场提示词（直接复制）

```
继续 WordMemo（D:\ymh\Code\tools\wordmemo），做同步。先读 docs/HANDOFF-SYNC.md（这一份就够了），
再读 docs/PLAN-SYNC.md 的 §3（方案）、§4（数据与接口变更）、§5（S0–S4）、§10（实现记录）。

现状：分支 feat/sync（最新提交以 git log -1 为准），typecheck 0 错误、npm test 18 文件 191 项全绿。
注意：重放的改动只在 feat/sync，master 上还没有（已发布的 0.5.1 不含它）。
便携版/自动更新已完结（0.5.1 已发 Release，不要再改）；同步 S0 的「重放」已经通过：
replayCard() 在真实写入口造出的轨迹上逐字段等于库里那张卡（tests/replay.test.ts），
enableFuzz 已必须关（否则重放不收敛），细节见 PLAN-SYNC §10。

接着做 S0 剩余：
1) notes/items/reviews/exams 加 uid TEXT UNIQUE + 回填 + SCHEMA_VERSION 2→3（迁移前会自动备份）；
2) 所有写入口统一 withSync + sync_ops 表；
3) cards 的 suspended/learn_mark/buried_until/needs_check 走 cardFlag 事件。
验收：typecheck 0 错误、npm test 全绿、真实库副本迁移后 uid 齐全且行数不变、不连网。
每做完一步在 PLAN-SYNC §10 记一笔，git commit -s。

硬约束见 HANDOFF-SYNC §8；用户可见文案按 docs/MESSAGES.md 定级。
S0 没做完不要开始 S1，更不要写任何网络代码。
```

---

## 10. 交接自检（新会话花两分钟确认）

- [ ] `git branch --show-current` → `feat/sync`
- [ ] `npm test` → 18 文件 191 项全绿
- [ ] `npm run typecheck` → 0 错误
- [ ] `git log --oneline -4` → 能看到 `docs(sync): hand off the sync block`、`docs(sync): record the S0 replay verdict`、`feat(sync): replay cards from review records`
- [ ] `grep -n "enableFuzz" src/main/fsrs.ts` → 必须是 `false`
- [ ] `grep -n "replayCard" src/main/fsrs.ts tests/replay.test.ts` → 都在
- [ ] 知道 `.data/` 里有本机辅助脚本（CDP 驱动、发版重试、查 CI），已被 gitignore
