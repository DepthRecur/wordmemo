# 交接文档：同步（Sync）板块

> 写给**新会话**：读这一份就能直接开工，不用重读旧对话。
> 生成时间：2026-11-23　分支：`feat/sync`（最新提交以 `git log -1` 为准）　仓库：`D:\ymh\Code\tools\wordmemo`（远端 `DepthRecur/wordmemo`，已公开）
> 前置阅读（按顺序）：本文 → [PLAN-SYNC.md](PLAN-SYNC.md) §1–§5 与 §10 → [HANDOFF.md](HANDOFF.md) §1（命令）/§8（坑）/§10（纪律）。
> 文案规则：[MESSAGES.md](MESSAGES.md)。同步里任何用户可见的字都按它定级。

---

## 0. 一句话现状

前三个功能（多供应商、多个库、便携版 + 自动更新）**全部完结并已发版**（当前 `0.5.1`，GitHub 上有真 Release）。
同步的 **S0（数据模型 + 重放）已全部完成并验收**：重放、`uid` + v2→v3 迁移、`sync_ops` + `withSync`、
`cardFlag` 事件都在 `feat/sync` 上（**`master` 还没有**，已发布的 0.5.1 不含它们）。
下一步是 **S1（本地队列与快照）**，见 PLAN-SYNC §5；S1 只在本机用两个数据目录验证合并，**不写网络代码**。

- `npm run typecheck` → 0 错误
- `npm test` → **21 文件 / 207 项通过 + 1 份手动迁移测试跳过**
- `npm run build` → 通过
- 工作区干净；S0 的四步提交都在 `feat/sync`（最新提交以 `git log -1` 为准）

---

## 1. 五分钟上手

```powershell
cd D:\ymh\Code\tools\wordmemo
git checkout feat/sync          # 已经在上面
npm install                     # 只有删过 node_modules 才需要
npm run typecheck
npm test                        # 21 文件 207 项通过（+1 份手动迁移测试跳过）
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

**四条必须记住的结论**：

1. **`enableFuzz` 必须关**。开着时间隔有 ±5% 随机抖动，两台设备重放同一串复习会得到不同 `due_at`，「cards = f(reviews)」直接不成立。关掉只影响间隔抖动，不动记忆模型。
2. **`newCard()` 每次生成随机 `cardId`**（ts-fsrs 内部 uuid），它会写进 `fsrs_json`。重放要么传原卡的 `cardId`，要么比较时忽略它。
3. **`applyReview` 今天不看 `mode`**（考试模式只影响冲刺规划里的模拟，不改调度）。所以重放只需要 `(reviewed_at, rating)`；哪天考试模式真改了调度，`applyReview` 和 `replayCard` 必须一起改。
4. 附带影响：`reviews.reviewed_at` 只存到秒（`localIso`），生产时钟带毫秒，早复习时这点差别会被放大到几秒，**合并后本地那张卡的 `due_at` 会挪动几秒**。可接受（每台设备从同一批记录重放会得到同一结果；`due_at` 只用于排序/到期）。

记录在 [PLAN-SYNC.md](PLAN-SYNC.md) §10「S0 第一步」。

---

## 3. S0 已完成，下一步 S1

S0（数据模型与重放）**全部做完并验收**，每一步的记录在 [PLAN-SYNC.md](PLAN-SYNC.md) §10：
重放 → uid/v2→v3 迁移 → `sync_ops` + `withSync` → `cardFlag`。三条硬结论：

1. **`enableFuzz: false`** 是重放成立的前提，别再打开。
2. **`uid` 已就位**：`notes` / `items` / `reviews` / `exams`，`SCHEMA_VERSION = 3`，迁移前自动备份；
   新行由各自写入口生成 uid。迁移会回填老行（只加列不回填 = 没有 uid）。
3. **写这四张表只走写入口**：`sync_ops` 由 `sync.ts` 的 `withSync` / `recordSyncOp` 在写事务里追加；
   在别处直接 `INSERT`/`UPDATE` 会漏队列。`cards` 的四个标志走 `cardFlag` 事件（`<item uid>:<direction>`）。

### 下一步：S1（本地队列与快照）

按 PLAN-SYNC §5：

- `sync_ops` 的读与确认（`pendingSyncOps()` 已有；缺的是「推到哪就标到哪」）；
- checkpoint 序列化 / tombstone / 合并引擎（规则见 §3.9：并集、字段级 LWW、删除优先）；
- `.wmsync` 快照导出/导入（复用 checkpoint 的同一套合并代码）。
- **先定 `decks` 怎么同步**：库本身还没有 op（见 PLAN-SYNC §10「明确没做的事」），
  但笔记/考试的 op 已经用 `deck_uid` 指库；不定的话另一台设备会拿到指不到的库。

验收：造两台「设备」（两个 `WORDMEMO_DATA_DIR`），A 导出 → B 导入 → 双向各改一条 → 再对齐 →
内容一致；同一批导入 10 次结果不变（幂等）。

**S1 不碰网络**：GitHub / age 加密 / PAT 都是 S2，S1 之前不要写任何请求代码。

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
| `src/main/db/schema.ts` | 全表 DDL + `SCHEMA_VERSION = 3`；四张表的 `uid`、`sync_ops` 队列 |
| `src/main/db/connection.ts` | `openDb` / `migrate` / 可重入的 `tx` / `localIso` / `addColumnIfMissing` / `backupBeforeMigrate`；`migrateUids()`（补列 + 回填 + 唯一索引） |
| `src/main/db/sync.ts` | **同步层入口**：`withSync` / `recordSyncOp` / `pendingSyncOps` / `noteUid|itemUid|examUid|deckUid` / `cardFlagUid`；S1 从这里读队列 |
| `src/main/db/uid.ts` | `newUid()`（ULID），已有，直接用 |
| `src/main/db/notes.ts` `items.ts` `exams.ts` `cards.ts` | 写入口；S0 已加 uid、包 `withSync`、卡片标志发 `cardFlag` |
| `src/main/db/decks.ts` | 已有 uid；`removeDeck` 会连带改笔记归属与考试 scope，也发 op |
| `src/main/db/dedupe.ts` | 按 `headword_norm` 合并重复词条；**S3 的冲突合并要复用它**（它现在不发 op，是启动修复） |
| `src/main/fsrs.ts` | `initFsrs` / `reviewSnapshot` / `replayCard`；fuzz 已关，别打开 |
| `src/main/settings.ts` | 设置读写与 `mergeSettings`；S2 的 `sync` 配置进这里（**不含 PAT/口令**） |
| `src/shared/types.ts` | `Settings`、`UpdateSettings` 等类型；S2 加 `SyncStatus/Config/Result` |
| `src/main/ipc.ts` + `src/preload/index.ts` | IPC 注册与暴露（S2 的 `sync:*`） |
| `tests/replay.test.ts` | 临时库 + 固定时钟的测试写法，新测试照这个抄 |
| `tests/uid.test.ts` `tests/sync-ops.test.ts` `tests/card-flag.test.ts` | S0 的三组契约测试：迁移回填、写入口队列、卡片标志 |
| `tests/real-db-migration.test.ts` | 手动迁移验收（默认跳过；设 `WORDMEMO_REAL_DB_COPY` 跑） |
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
11. **`tx()` 是可重入的**（`connection.ts`）：写入口互相调用（`applyReview` → `addAcceptedZh`）时内层会搭外层事务。
    在 `withSync` 里不要再手写 `BEGIN`；要加多实体写入用 `recordSyncOp`。
12. **唯一索引不能写进 `SCHEMA`**：老库还没补 `uid` 列时 `CREATE UNIQUE INDEX` 会直接报错，
    四个 `ux_<table>_uid` 都由 `migrateUids()` 在补列之后建（和 `ix_notes_deck` 同一个坑）。
13. **op 里不能有本机整数 id**：`deck_id` / `card_id` / `exam_id` 一律换成 `deck_uid` / `card_uid` / `exam_uid`；
    `exams.scope.deckId` 换 `scope.deck_uid`。写入口的字段构造就是范例。
14. **`cardFlag` 的 uid 是 `<item uid>:<direction>`**，不是 card id；卡片没有自己的 uid。
15. **真实库可能是空表**：本机 `exams`、`reviews` 就可能 0 行，验收脚本别假设每张表都有数据。

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
继续 WordMemo（D:\ymh\Code\tools\wordmemo），做同步。
先确认分支：git checkout feat/sync（同步的全部代码都在这个分支上，master 没有）。
然后读 docs/HANDOFF-SYNC.md（这一份就够了），
再读 docs/PLAN-SYNC.md 的 §3（方案）、§4（数据与接口变更）、§5（S0–S4）、§10（实现记录）。

现状：分支 feat/sync（最新提交以 git log -1 为准），typecheck 0 错误、
npm test 21 文件 207 项通过（+1 份手动迁移测试默认跳过）。
便携版/自动更新已完结（0.5.1 已发 Release，不要再改）；同步 S0（数据模型 + 重放）已完成并验收：
uid + v2→v3 迁移、sync_ops + withSync、cardFlag 事件都已落地；重放成立
（enableFuzz 必须关），细节见 PLAN-SYNC §10。

接着做 S1（本地队列与快照）：
1) sync_ops 的读与确认（推送到哪就标到哪）；
2) checkpoint 序列化 / tombstone / 合并引擎（并集、字段级 LWW、删除优先，见 §3.9）；
3) .wmsync 快照导出/导入（复用同一套合并代码）。
验收：用两个 WORDMEMO_DATA_DIR 当两台设备，A 导出 → B 导入 → 双向各改一条 → 再对齐内容一致；
重复导入 10 次结果不变（幂等）。
S1 不要写任何网络代码（GitHub / age / PAT 都是 S2）。

硬约束见 HANDOFF-SYNC §8；用户可见文案按 docs/MESSAGES.md 定级。
每做完一步在 PLAN-SYNC §10 记一笔，git commit -s。
```

---

## 10. 交接自检（新会话花两分钟确认）

- [ ] `git branch --show-current` → `feat/sync`
- [ ] `npm test` → 21 文件 207 项通过（另 1 份手动迁移测试跳过）
- [ ] `npm run typecheck` → 0 错误
- [ ] `git log --oneline -6` → 能看到 `feat(sync): give synced tables a uid`、`feat(sync): record writes in sync_ops`、
      `feat(sync): sync card flags as events`、`feat(sync): replay cards from review records`
- [ ] `grep -n "enableFuzz" src/main/fsrs.ts` → 必须是 `false`
- [ ] `grep -n "withSync" src/main/db/sync.ts src/main/db/notes.ts` → 都在
- [ ] `sqlite3`（或 `node -e` 开库）里 `SELECT COUNT(*) FROM sync_ops` 能查（表存在）
- [ ] 知道 `.data/` 里有本机辅助脚本（CDP 驱动、发版重试、查 CI），已被 gitignore
