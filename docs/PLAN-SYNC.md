# 计划 B：云端同步（GitHub 私有仓库当网盘）

> 目标版本：v0.5　预计 8~12 个工作日　风险：高（唯一会改数据模型的功能）
> 前置：多供应商 + 多个库 + 自动更新已完成（同步的修复必须能靠自动更新发出去）
> 相关：[总览](PLAN-NEXT.md) · [复用调研](RESEARCH-REUSE.md)
> **2026-11-18 定稿**：同步范围永久限定为结构化数据（不做图片/文件）；`.wmsync` 快照导出/导入从"退路"升级为正式功能。
> 调研结论已并入本文：**Obsidian Git 不是同类**（文件级 git 合并，见 §3.0）；加密改用 age（BSD-3）而不是自己设计信封；CRDT 路线已评估并否掉（§3.5）。
> **状态：已发布 v0.6.0（2026-11-24）**。S0–S4 全部完成，`feat/sync` 已合入 `master`，tag `v0.6.0` 由 CI 发布（三件套：zip / `.sha256` / `latest.json`）。同步代码冻结；格式变更规则见 §4（`formatVersion`）。

---

## 1. 目标与红线

**目标**：同一份词库在 2~3 台设备（家里台式、学校笔记本、以后的另一台）之间同步；不租服务器、不注册账号、不依赖你的任何基础设施；数据在离开本机**之前**就加密。

**红线**：
1. 不租服务器、不写后端、不做实时协作。
2. 不把 `.db` 文件直接丢进 Git。
3. 不把明文笔记传上去。用户 GitHub 仓库被看到、被误设为公开、PAT 泄露，都不应泄露学习内容。
4. 不把 AI Key、同步密码、PAT 放进远端任何文件。
5. **只同步结构化数据**，图片/原件/缓存**永久不同步**（不是 v1 限制，是产品边界）；用户级备份走 `.wmsync` 快照。

---

## 2. 现状盘点：为什么"直接传 db"一定不行

| 现状 | 为什么是障碍 |
|---|---|
| `src/main/db/schema.ts` 全表用 `INTEGER PRIMARY KEY AUTOINCREMENT` | 两台设备各自从 1 开始编号，`items.id=12` 在两台机器上是两个不同的词 |
| SQLite 跑在 WAL 模式（`connection.ts:9`） | `wordmemo.db` 单文件在拷贝瞬间可能不含最新事务；`-wal`/`-shm` 一起拷又不原子 |
| 二进制 + 整文件粒度 | Git 只能"整个文件替换"，两台设备同时改 → 只能二选一，丢一边的复习记录 |
| `cards` 表存 FSRS 状态（`stability/difficulty/reps/due_at/fsrs_json`） | 直接按字段合并没有物理意义：两边各复习 3 次，合出来的卡片不代表任何一条真实学习轨迹 |
| `reviews` 是追加型事实（`schema.ts:73`） | 这才是可以无损合并的东西——但现在是自增 id |
| `files/`（原图副本，`storage.ts`） | 单份几百 KB~几 MB，进 Git 会迅速把仓库撑大 |
| `settings.json` / `secrets.bin` | 前者可同步（需白名单），后者绝不能 |
| `ux_items_headword_norm` 唯一索引（`connection.ts:54`） | 同一单词在两台设备上都会被创建 → 合并时必须按 headword 归并，不能靠 id |

**结论**：同步的对象不是"数据库文件"，而是**变更事件 + 稳定标识**。库里的表只是本地视图。

---

## 3. 方案

### 3.0 先说清楚：Obsidian Git 为什么不是同类

你问的那个项目（[Vinzent03/obsidian-git](https://github.com/Vinzent03/obsidian-git)）解决的是「把一堆 Markdown 文件同步到 git 远端」，它的合并单位是**文本行**（isomorphic-git 依赖 diff3），冲突时**停下来让人逐块点选**，而且**没有加密**（安全边界只有"仓库是私有的"）。

对我们的数据形态，它在四层上都不适用：

| 维度 | Obsidian Git | 我们 |
|---|---|---|
| 对象 | 文件 | SQLite 表行 |
| 合并 | 文本 3-way merge | 记录/字段级 |
| 冲突 | 停下来喊人 | 自动合并、静默 |
| 二进制 | 做不到（强制合并出的 .db 会 `malformed`） | 必须支持 |
| 加密 | 无 | 端到端 |

**但它有两样值得借**（而且它恰好是 **MIT**，LICENSE 已实读，不是 GPL）：

1. **触发策略**：`interval`（可 0 关闭）、停止编辑后触发、commit 与 push 两个独立计时器、**跨会话续算**（关掉应用后，下次启动补跑没跑完的同步）。
2. **凭证不落盘**：用本地 askpass 式的临时凭证通道，token 不写进仓库。

**具体到代码（2026-11-18 产品级调研补充）**：
- `src/promiseQueue.ts`（53 行，零依赖）——**可以整段抄**：全局串行化队列，`onFinished` 在成功与失败时都调用，所以定时器无论成败都会重新装载。我们的推送队列直接用它。
- `src/automaticsManager.ts`（9.1 KB）——**抄模式不抄类**：它「跨会话续算」不是持久化断点，而是**持久化"上次自动动作时间戳"**（`saveLastAuto`），启动时算 `max(0, interval - 距上次的分钟数)` 再设定时器。20 行就能复刻。
- `src/gitManager/gitManager.ts` 的 `withGitOperation`——三行状态原语（`set(op)` → try/finally 复位），值得抄。
- 不要抄它的 `isomorphicGit.ts`/`simpleGit.ts`（40~60 KB，绑 vault 适配器）；我们要用就直接用 `isomorphic-git` + `node:fs`。

### 3.1 一张图

```
本地 SQLite ──写操作──> 同步层(包裹) ──> oplog(本地表) ──> 打包+加密 ──> GitHub 私有仓库
     ↑                                                                    │
     └──────────── 合并/重放(replay) ←── 拉取+解密 ←───────────────────────┘
```

- **写**：所有对 `notes/items/cards(仅标志位)/exams/reviews` 的写操作，统一经过一层 `withSync()` 包装，顺带写一条本地 `sync_ops` 记录。
- **发**：攒够一批（或到时间）→ 序列化成 JSONL → **age 加密** → `PUT` 到自己的目录。
- **收**：`GET` 别的设备的文件 → 解密 → 按记录规则合并 → 写本地库 → 更新游标。
- **卡片状态不传**：只传 `reviews`，本地用 `ts-fsrs` 重放出卡片。这是本方案最重要的一步。

### 3.2 稳定标识：给需要同步的表加 `uid`

- 新增 `uid TEXT`（ULID，26 字符，时间有序 + 随机），`UNIQUE`。
- 涉及表：`notes`、`items`、`reviews`、`exams`、`validation_issues`（可选）。`cards` 不参与同步。
- `note_items`、`card→item`、`review→card` 等外键在**传输格式里一律用 uid**，落地时再映射成本地整数 id。
- 迁移：给存量行回填 `uid = ULID(created_at)`；新建行由 `withSync` 生成。
- **跨设备重复词**：ULID 不会碰撞，但 `headword_norm` 会。合并时若远端 item 的 `headword_norm` 与本地已有不同 uid 冲突 → 按现有 `dedupeItems()`（`src/main/db/dedupe.ts`）的规则并成一条，保留"本地条目的 uid + 远端条目的 uid 映射表"，避免下次又从远端生成一条。

### 3.3 卡片为什么不传：replay

`reviews` 是事实（谁在什么时候、以什么模式、答了什么、评了几分）。FSRS 是确定函数：给定完整有序的评分序列，重放出唯一的状态。因此：

```
cards[i] = replay(reviews 按时间排序)
```

- 好处：两台设备各自复习，合并后**不会丢任何一次复习**，也不会出现"合出来的卡片没人认得"。
- 需要先做的验证（S0 的重点）：确认 `applyReview`（`src/main/db/cards.ts`）里没有不可重放的逻辑。已知需要小心的两处：考试模式对间隔的干预、learn ahead 的分钟级步骤、`buried_until` 与 `learn_mark` 这类"今天的状态"。做法：
  1. 抽出纯函数 `replayCards(reviews) → CardState[]`；
  2. 用真实库（`.data/wordmemo.db`）跑 golden test：重放结果必须与当前 `cards` 行逐字段相等（允许 `due_at` 之外的极小浮点误差）；
  3. 不等的位置逐条查清是"非确定逻辑"还是"历史数据被手工改过"，前者改成确定逻辑或记为"卡片人工干预标志"（单独同步）。
- **卡片上的手动状态**（`suspended`、`learn_mark`、`buried_until`、`needs_check`）不是重放得来的，作为 `cardFlag` 事件同步，字段级 LWW。

### 3.4 变更捕获：不靠触发器，靠写入口

SQLite 的 `session` 扩展在 `node:sqlite` 里没有暴露，触发器里也拿不到足够的上下文（谁改的、改了哪些字段）。所以：

- 在 `src/main/db/*.ts` 的写函数外再包一层：`commitNote(input)`, `upsertItem(...)`, `applyReview(...)` 等**唯一写入口**已经在 db 层，改动集中。
- `withSync(entity, uid, fields, fn)`：执行 `fn` → 在同一条事务里写 `sync_ops`。
- `sync_ops` 本地表：`seq INTEGER PK`、`uid`、`entity`、`op`（`upsert`/`delete`）、`fields`（JSON，仅变更字段）、`origin`（`local`/`remote:<device>`）、`ts`、`pushed`。
- **不重放远端来的 op 回推**（避免回声）：`origin != 'local'` 的 op 不参与推送，除非合并过程产生了新的本地变更（例如词条归并），那时它会以新的 `local` op 出现，这是正确行为。

### 3.5 加密：age + 口令（2026-11-18 定稿）

**决策：用 [age](https://github.com/FiloSottile/age) 格式（实现取 [typage](https://github.com/FiloSottile/typage)，npm 包名 `age-encryption`，BSD-3-Clause，纯 JS/WASM，只依赖已审计的 `@noble/*`），密钥用**用户口令**。**

理由：加密格式是最不该自己发明的东西；而「记得住的密码」对学生最友好——不用保存一串 `AGE-SECRET-KEY-…`，换设备只要输同一句话。

**口令方案的两个必须补的坑**（这是选口令后最容易出事的两个地方）：

1. **口令要能验证对错，否则会默默建出一个空库**
   如果把「输错口令」当成「新仓库」，用户会看到「同步成功但数据没了」，然后在两台设备间来回覆盖。
   做法：远端 `meta.json` 存一个 **`kdfVerifier`**（`scrypt(passphrase, salt)` 的前 16 字节，或对固定字符串做 HMAC）。连接/每次解锁时先比对：不匹配 → 明确报「口令不对」，**禁止**继续。
2. **口令要够强，且强度要当场告诉用户**
   age 的口令模式内部是 scrypt（默认 work factor 18，约 0.5~1.5 秒）。弱口令等于没加密。
   做法：最少 10 个字符 + 实时强度条；提供「帮我生成」按钮，生成 **4~5 个单词的短语**（如 `cobalt-tiger-lantern-vivid`），用户抄下来或改成自己记得住的句子。**不要**强制复杂符号（学生记不住，反而会写在便签上）。

**代价（如实接受）**：

| 项 | 影响 |
|---|---|
| 每次加解密跑一次 scrypt | 一次同步通常只读/写 **1~2 个分片**，约 1~3 秒，后台进行，可接受 |
| 每次同步都要持有口令 | 本机用 `safeStorage` 存一份（DPAPI），免去每次输入；**用户可勾选"不记住"** |
| 忘记口令 = 数据永久不可解 | **没有恢复密钥**（这是选口令的必然代价）。连接页必须写一句：「忘了这串密码，云上的数据谁也解不开。」 |
| 改口令 = 全量重新加密并重推 | 做，但放在「危险操作」里，提示会重新上传所有分片 |

> 快不快的问题：如果实测发现某台老机器上 scrypt 太慢（>5 秒），再考虑「用口令派生一个 X25519 身份、之后用身份加密」的优化（会话内只跑一次 KDF）。这是**性能优化**，不改变"用户只记口令"的产品形态，所以随时可加。

**age 的语义是「整文件加密、不支持追加」** —— 所以必须按天/按批分片（正好和增量上传吻合），也避免「一个日志越滚越大」。原 `str4d/age-encryption.js` 仓库已 404，npm 上的 `age-encryption` 现在指向 typage，别再按旧仓库找文档。

**防「张冠李戴」**：age 不提供 AAD，所以把 `{ path, device, seq }` 写进**分片内的明文头部**，解密后校验路径与预期一致，不一致直接拒绝。不要依赖文件名做信任判断（GitHub 上改名成本极低）。

**口令与派生密钥**只进 `safeStorage` 加密的本机文件，**绝不进远端、不进日志、不进同步快照**。

**会泄露什么**（写进 README）：文件数量、每个文件大小、提交时间、设备数量、同步间隔。**不会泄露**：单词、释义、笔记、复习记录、设备名（设备 id 用随机 ULID）。

**为什么不用 CRDT（cr-sqlite / Automerge / Yjs）**：
- cr-sqlite 需要加载 SQLite 扩展（我们跑在 `node:sqlite` 上，Electron 38 内置 Node 22 能否 `loadExtension` 第三方 dll 未实测），且合并语义是**逐列 LWW**——`reps/lapses` 各改一半会丢掉另一台设备的复习，对背单词不可接受。
- Automerge / Yjs 是文档 CRDT，要么双写、要么把整库塞进一个 blob；我们已经有确定性更强的方案（reviews 重放），不需要第二套一致性模型。
- 结论：**事件流 + 确定性重放**已经解决了冲突（§3.3）。这是最少的机制，不是最多的。

### 3.6 远端布局（仓库结构）

```
meta.json                                 明文：{ formatVersion, salt, kdfVerifier, createdAt }
devices/<deviceId>/checkpoint.json.age    该设备的全量状态（周期性重写，保留最近 2 份）
devices/<deviceId>/ops/20261117.jsonl.age 当天增量，每行一个 op
devices/<deviceId>/info.json.age          设备别名、最后活跃时间（给"设备管理"用）
```

**为什么按设备分文件**：每台设备只写自己的文件，**根本不存在"两个人同时改同一个文件"**，因此不需要分布式锁、不需要乐观并发重试、不需要 leader 选举。冲突只发生在**记录层**（同一个 uid 被两台设备改），而记录层是可以用规则合并的。这是整个方案能保持简单的关键。

**体积与保留**（按每天 10 条新词、几十次复习估）：
- 每天增量 JSONL 明文 ~2~10 KB，加密后同量级；一年约 1~3 MB。
- 每月 checkpoint ~1~5 MB（全量），保留最近 2 份。
- 目标：单仓库 **首年 < 20 MB**。超过 200 MB 要提醒用户（GitHub 对仓库有软限制，克隆会变慢）。

**压缩**：先不做（JSONL 已经很瘦），如果实测偏大再加 `zlib`（内置，不引依赖）。

**提交策略**：一次同步 = 一个 commit，一次 `PUT`（小文件走 Contents API；>1 MB 走 Git Data API 的 blob/tree/commit）。commit message 统一 `sync: <deviceId 前 6 位>`，不写单词内容（提交历史也是对外的）。

### 3.7 传输：GitHub API 的具体用法

| 操作 | 接口 | 备注 |
|---|---|---|
| 首次连接 | `GET /repos/{owner}/{repo}` | 校验仓库存在、私有、有 contents 权限 |
| 读远端文件 | `GET /repos/{owner}/{repo}/contents/{path}` | 返回 `sha` + base64 内容；用 `If-None-Match: <etag>` 做条件请求 |
| 列设备目录 | `GET /repos/{owner}/{repo}/contents/devices` | 一次列出子目录 |
| 写文件 | `PUT /repos/{owner}/{repo}/contents/{path}` | 带 `sha` 表示更新；不带表示新建 |
| 大文件 | `POST /git/blobs` → `/git/trees` → `/git/commits` → `PATCH /git/refs/heads/sync` | 单个 blob 上限 **100 MB**（[GitHub 文档](https://docs.github.com/en/rest/git/blobs)），我们控制在 5 MB 以内 |

- **速率**：认证用户 5000 次/小时；**304 条件请求不占额度**，所以空闲轮询几乎免费。
- **单文件 5 MB 上限**（自定）：超过就说明 checkpoint 该拆或该压缩了。
- **PAT**：fine-grained token，只授权**这一个仓库**、只勾 `Contents: Read and write`。存 `safeStorage`。过期后 UI 明确提示"PAT 已失效，请重新粘贴"，而不是笼统的"同步失败"。
- **不支持 GitHub OAuth 设备流**：OAuth 需要一个 client secret，天然需要服务器。所以只能让用户自己建 PAT——这正好符合"不搭服务器"的前提，代价是首次配置多两步（计划里要给**带截图的分步向导**，这是开源后最容易被问的问题）。

### 3.8 同步频率控制（你特别提的那点）

| 触发 | 行为 |
|---|---|
| 应用启动完成 | 拉一次（只拉不发，除非本地有积压） |
| 本地写操作后 | 标记 dirty，**debounce 30 秒**；只在窗口可见或有积压时才真发 |
| 定时 | 默认每 **10 分钟**检查一次（可设 0/5/10/30/60；0 = 只手动） |
| 退出前 | 尽力推一次（不阻塞退出超过 3 秒） |
| 手动 | 「立即同步」按钮，永远可用 |
| 失败 | 指数退避 1 → 5 → 15 → 60 分钟，封顶 60；UI 显示"上次成功时间"而不是弹窗 |
| 额度 | 读 `X-RateLimit-Remaining`；< 100 时降到"只在用户手动时同步" |

**加抖动**：所有定时触发加 ±20% 随机偏移，避免多台设备整点撞车。
**最小间隔**：两次推送之间至少 60 秒（防抖之后再兜一层，防止用户连点）。
**不做的**：后台常驻长连接、WebSocket、实时对等同步。

### 3.9 合并规则（冲突矩阵）

所有 op 带 `ts`（本地时间）+ 设备序号。LWW 用 `(ts, deviceId)` 排序，`deviceId` 只用于同一毫秒的确定性断平。**时钟偏差**：允许 ±5 分钟；超出就把 op 的 `ts` 夹到"本地收到时间 - 1 秒"，避免一台时钟错乱的机器永远赢。

| 数据 | 规则 |
|---|---|
| `notes` 标题/日期/标签 | 字段级 LWW |
| `notes.rawMarkdown` | 整字段 LWW（正文不做行级合并，代价太高、收益太低） |
| `items` 的 `meanings`/`collocations`/`examples`/`acceptedZh` | **并集**（顺序按先到；同等元素去重），比 LWW 更符合"两台设备各补了一个义项"的真实场景 |
| `items.headword` / `pos` / `phonetic` | 字段级 LWW |
| `items.learned_at` | 取最早的非空值（学过了就是学过了） |
| `reviews` | **并集**，按 `uid` 去重；不可变，永不冲突 |
| `cards` | 不传，本地 replay；`suspended/learn_mark/buried_until/needs_check` 作为 `cardFlag` 字段级 LWW |
| `exams` | 字段级 LWW |
| 删除 | tombstone op（`op: 'delete'` + `ts`），删除比同 uid 更早的 upsert 优先；**UI 不提示**。影子表只留 `entity/uid/ts` 作合并依据，**不提供恢复**；启动时清掉 30 天前的（D-05 方案 B，见 §0.7） |
| `settings` | **白名单**同步：学习参数、提醒、发音偏好等；**排除**所有 Key、PAT、密码、窗口位置、本机路径、设备 id |
| `import_drafts` | 不同步（含大块 OCR 原文与本地文件路径，属于"本机工作区"） |
| `ai_cache` / `ai_usage` / `pronunciations` / `tts` 缓存 | 不同步（可由各自设备重算；同步只会互相污染） |

### 3.10 合并的实现约束

- 一次合并 = **一个事务**（`tx()`，`connection.ts:71`）。中途失败整体回滚，游标不前进。
- 合并顺序：先 `checkpoint` 再 `ops`，按 `seq` 升序；遇到 `seq` 缺口 → 停止该设备，不猜、不跳过（缺文件就是缺数据）。
- 合并后写回 `sync_ops` 时标 `origin: 'remote:<device>'`，防止回推。
- **幂等**：同一批 op 应用两次，结果必须相同（用 uid + seq 游标保证）。
- **交换律**：先拉 A 后拉 B，与先 B 后 A，最终状态必须一致（属性测试会验证这一点）。

**产品级调研的结论（2026-11-18 补，见 RESEARCH-REUSE §0.5.3）**：

| 结论 | 依据 | 对我们的动作 |
|---|---|---|
| MIT/Apache 阵营**没有**「记录级合并 + 加密」的现成模块 | Obsidian Git / chezmoi / Syncthing 都是文件级；livesync 是块级 + CouchDB revision；Joplin（item 级，设计最接近）是 AGPL | 合并规则必须自己写；**S0 的 golden test 是唯一安全网** |
| 「reviews 当事件流、cards 重放」**没有直接先例** | 最接近的是 PouchDB `_rev` 版本树与 Joplin revisions，都是"快照"而非"全局 oplog" | 这属于自研设计，必须在 S0 用真实库验证重放等价；失败就退回"以卡为准 + 冲突副本" |
| 可整段抄的零件只有一个文件 | `obsidian-git/src/promiseQueue.ts`（53 行，MIT，零依赖） | 推送/拉取队列直接用它 |
| 可抄的两个模式 | obsidian-git 的「lastAuto 时间戳续算」；Syncthing 的冲突副本命名 `<名>.sync-conflict-<日期>-<时间>-<设备>` | 前者写进 §3.8；后者作为 `conflicts/` 目录的命名规则 |
| 冲突兜底照 Joplin | 冲突不硬合，落到「Conflicts」笔记本，**永不静默丢数据** | 我们落 `conflicts/` 目录 + UI 提示条 |
| 加密边界照 chezmoi | 「一文件一密文 + 加密器做成可替换接口」 | age 加密只发生在读/写边界，同步逻辑不感知加密 |

### 3.11 界面

新增「同步」设置页（或设置页里一块）：

1. **未连接**：三步向导——建私有仓库 → 建 PAT（给权限勾选的截图）→ 设同步密码 → 「测试并首次同步」
2. **已连接**：仓库名（可点开浏览器）、设备列表（本机高亮，可"移除其它设备"）、上次同步时间/结果、上下行条数、「立即同步」
3. **状态**：`已同步` / `有 N 条待上传` / `等待网络` / `PAT 失效` / `密码错误` / `远端格式需要升级版本`
4. **危险操作**（二次确认 + 输入仓库名确认）：断开连接、清空远端数据、更换密码（需重新加密并全量重推）
5. **日志**：最近 20 次同步的时间、耗时、条数、结果码。**不含任何内容明文**。

### 3.12 快照导出/导入（正式功能，不是退路）

**已定：同步范围只有结构化数据（笔记/词条/复习/考试/库），不包含任何图片与文件，且以后也不加。** 这让「快照」从兜底手段升级成一个正式功能——反正数据本来就只有几百 KB。

要区分两种「快照」，别混：

| 名字 | 谁用 | 存在哪 | 用途 |
|---|---|---|---|
| **checkpoint** | 同步引擎自己 | 远端 `devices/<id>/checkpoint.json.age` | 增量日志的基线，用户看不见 |
| **`.wmsync` 导出文件** | 用户 | 用户自己选的位置（网盘/U 盘） | 备份、换机、离线同步、GitHub 连不上时的替代通道 |

`.wmsync` 的做法（复用 checkpoint 的同一套代码）：

- 「导出加密快照」→ 一个 `.wmsync` 文件（明文头 + age 密文）。
- 「导入加密快照」→ 走同一套合并逻辑（不是覆盖，是合并）。
- 因为不含附件，一个学年下来通常只有**几百 KB 到几 MB**，放微信/网盘都没压力。

它顺带解决：GitHub 在国内访问不稳、仓库被封、用户不想给 PAT、以及**换机时"先导出再导回来"这种最原始也可靠的场景**。**成本几乎为零，价值很高**，放在 S2 而不是以后。

---

## 4. 数据与接口变更


| 变更 | 内容 |
|---|---|
| 新列 | `notes.uid`、`items.uid`、`reviews.uid`、`exams.uid`（`TEXT UNIQUE`） |
| 新表 | `sync_ops`（本地队列）、`sync_devices`（远端设备游标/ETag）、`sync_tombstones`、`sync_state`（单行：`format_version`、`last_push_at`、`last_pull_at`） |
| `user_version` | 提升一次，迁移前备份（见总览 §3 的坑） |
| 新类型 | `SyncStatus`、`SyncResult`、`SyncConfig`（不含密钥）、`SyncConflict`（v1 只记录，不弹窗） |
| 新 IPC | `sync:status`、`sync:connect({repo, pat, passphrase})`、`sync:now`、`sync:disconnect`、`sync:export`、`sync:import`、`sync:devices`、`sync:removeDevice` |
| `settings.json` | 新增 `sync: { enabled, owner, repo, apiBase, intervalMin, lastCursor... }`（**不含 pat/passphrase**） |
| 版本号 | 远端 `meta.json.formatVersion`；本地 `sync_state.format_version`。**旧客户端读到新版本 → 拒绝并提示升级**；绝不"尽力而为"地半懂半不懂地合并 |

> **0.7 的格式变化（2026-11-26，A-06）**：考试范围的传输形态从「`deck_uid` + 本机 `noteIds/itemIds`」改成「`deck_uid` + `note_uids/item_uids`」。老键（数字 id）不再写出，读到也一律丢弃。
> **混跑影响**：0.6.0 的设备读到 0.7 写的考试时，因为不认识 `note_uids`、又拿不到 `noteIds`，会把「指定笔记」退化成整库范围（不会写坏数据，只是范围变大）。这个窗口只在升级期出现；如果要长期混跑，需要把 `SYNC_FORMAT_VERSION` 升一版并按上面的规则**拒绝**旧端。

---

## 5. 分阶段实施（每阶段都能单独验收、单独回滚）

### S0 数据模型与重放（3 天，最硬的一段）

- 加 `uid` 与迁移（先备份！）；写入口统一走 `withSync`。
- 抽 `replayCards()`；**golden test：真实库重放结果 == 现有 cards**。
- 处理重放不等的位置（考试模式、buried、learn_mark）。
- **退路（重要）**：调研显示「事件流 + 重放」在开源产品里**没有先例**（见 §3.10 的表），所以这一步可能失败。若 3 天内无法让重放与真实库 0 差异，就不硬上——改成「以 `cards` 行为准 + 冲突副本」的保守合并（少一层优雅，但不会丢复习记录）。
- **验收**：`npm test` 全绿 + 新增重放测试；`replayCards()` 在真实库上 0 差异；不连网、不写远端。

### S1 本地队列与快照（2 天）

- `sync_ops` 写读、`checkpoint` 序列化/反序列化、tombstone、合并引擎（先只在本机验证）。
- 「导出快照 / 导入快照」——**两个本地目录之间手动搬数据就能验证合并**。
- **验收**：造两台"设备"（两个 `WORDMEMO_DATA_DIR`，见 §7 的测试技巧），A 导出 → B 导入 → 双向各改一条 → 再对齐 → 两边内容一致；重复导入 10 次结果不变（幂等）。

### S2 加密与传输（3 天）

- 口令强度校验 + `kdfVerifier` 写入/比对 + `safeStorage` 存储 + 分片头部路径校验。
- GitHub 客户端：条件请求、Contents/Git Data 两条路径、PAT 校验、错误归一化。
- 连接向导 + 状态面板 + 退避与抖动。
- **验收**：真实私有仓库，两台设备自动同步成功；把仓库里任一文件改坏 → 明确报"文件损坏"而不是崩溃；PAT 撤销 → 明确报"PAT 失效"；断网 10 分钟恢复后自动补上。

### S3 冲突与设备管理（2 天）

- 并集/LWW/tombstone 全规则落地；`sync_devices` 游标；移除其它设备；更换密码（全量重推）。
- **验收**：专门造冲突场景——同一词条两台各加一个释义 → 合并后两个都在；同一词条一台改释义一台改音标 → 两个改动都保留；一台删除、另一台修改 → 按 ts 判定且结果可解释。

### S4 打磨与文档（1~2 天）

- README 的"同步"章节（含"会泄露什么/不会泄露什么"）、密码丢失说明、常见错误对照表。
- 同步日志面板、体积提示（仓库 > 200 MB 时提醒）。
- **验收**：一个没看过代码的人照文档能在 10 分钟内连上。

---

## 6. 测试计划

- **重放确定性**：同一 review 序列重放 100 次结果一致；与真实库 golden 对照。
- **合并性质测试**（vitest + 随机 op 序列）：
  - 幂等：`merge(merge(S, ops), ops) === merge(S, ops)`
  - 交换：`merge(merge(S, A), B) === merge(merge(S, B), A)`
  - 结合：三台设备任意顺序收敛到同一状态
- **加密**：加解密往返；**错口令必失败**（`kdfVerifier` 先拦，不能"解出半个文件"）；分片头部路径与预期不符必拒绝；换口令后旧口令解不开。
- **假 GitHub**：本地 HTTP mock（不引第三方库，`http.createServer` 即可），覆盖 200/304/401/403/404/409/422/429/500 与网络超时。
- **真仓库 e2e**：`SYNC_E2E=1` + 环境变量提供的测试仓库；只在手动跑，不进常规 CI（避免写别人的仓库）。
- **两设备模拟**（这个项目天生支持）：开发模式下 `userData` 由 `WORDMEMO_DATA_DIR` 决定（`src/main/index.ts:22`），单实例锁按 `userData` 计算 → 用两个不同目录开两个实例，就是两台设备，不需要虚拟机。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 0.7 状态（2026-11-26） |
|---|---|---|---|
| **「事件流 + 重放」没有开源先例** | 设计可能不成立，S0 才发现 | S0 先做 golden test；不等价就走"以卡为准 + 冲突副本"的保守路线（§5 S0 的退路） | ✅ 重放成立（`tests/replay.test.ts`），退路未启用 |
| **GitHub 在国内访问不稳定** | 同步时好时坏，用户以为软件坏了 | 做成"可失败、可重试、不打断学习"：本地永远优先，同步是后台增强；`apiBase` 可改（走代理）；白送快照导出/导入作为退路 | 🟡 退避/抖动、快照退路都有；`apiBase` 决定不做界面（§9），改 settings.json |
| 口令忘记或太弱 | 数据永久不可解 / 等于没加密 | 强度条 + 生成短语按钮 + 连接页明确警告；不提供"找回"（零知识下提供不了） | ✅ |
| 仓库体积增长 | 克隆变慢、被 GitHub 提醒 | 增量文件 + 月度 checkpoint 保留 2 份；体积面板；>200 MB 提示 | ✅ 0.7 补上「保留 2 份」（D-01） |
| 时钟错乱导致"永远输" | 某台设备改动丢失 | `(ts, deviceId)` 断平 + 时钟夹取（±5 分钟） | ✅ 0.7 补上夹取（A-03），在 ts 推导点夹、并记 `sync-clock-skew`；**未做** `(ts, deviceId)` 断平（同秒冲突仍按先到先得） |
| 旧客户端读到新格式 | 静默丢数据 | `formatVersion` 严格校验，不匹配就拒绝并提示升级；这也是必须先把自动更新做掉的原因 | ✅ |
| 自增 id 与 uid 双轨混乱 | 外键错乱 | 传输格式只用 uid；落地映射集中在一个 `mapRemoteToLocal()` 里；测试覆盖"远端 uid 已存在/本地 headword 已存在/两者都缺"三种情况 | 🟡 没有集中的 `mapRemoteToLocal`（映射分散在 `resolveAlias` 等函数）；0.7 补了「考试范围按 uid」（A-06），「本地 headword 已存在」仍无专项测试 |
| PAT 权限过大 | 用户账号风险 | 文档强制 fine-grained + 单仓库 + contents only；界面上写清楚"不要用 classic token" | ✅ |
| 用户误把仓库设成公开 | 内容泄露（虽然加密） | 连接时检查 `private === true`，公开仓库直接拒绝，并解释原因 | ✅ 有测试 |
| 同步把 AI 缓存/日志带出去 | 隐私 | 白名单制：只列允许同步的表/字段；新增表默认不同步 | ✅ |

---

## 8. 已定 / 待定

| 项 | 状态 |
|---|---|
| 同步范围 | **已定**：只有结构化数据；**图片/文件永不同步**（不是 v1 限制，是产品边界） |
| 快照导出/导入 | **已定**：做，作为正式功能（备份 + 换机 + 离线同步） |
| 同步密钥形态 | **已定：用户口令**（age passphrase + `kdfVerifier` 校验 + 强度条）；不做恢复密钥 |
| 默认同步间隔 | **已定：10 分钟**（选项 0 / 5 / 10 / 30 / 60，0 = 只手动；`types.ts` 的默认值） |
| 远端布局 | **已定：`devices/<deviceId>/{checkpoint,ops,info}`**，另加月度归档 `checkpoint-<YYYYMM>.json.age`（D-01） |

## 9. 明确不做

- 不做实时同步、不做协同编辑、不做多用户共享同一仓库。
- 不做自动冲突弹窗（v1 只自动合并 + 记录日志；只在真无法判定时提示"这一条以哪边为准"）。
- 不做 Gitee / 自建 Git 托管（结构上支持，但配置项先只暴露 GitHub；`apiBase` 已留口子）。
- **不做附件同步——永久不做**（图片/docx 原件、TTS 缓存、AI 缓存都不传；`import_drafts` 也不传）。
- 不做"云端备份托管"（那是服务器，违背前提）。
- **不同步设置**（2026-11-25 决定）：笔记/词条/复习/考试/库之外的东西不传——学习参数、提醒、发音偏好、AI Key 都是每台机器各自配置。原计划的「settings 白名单同步」正式取消（原 §3.9）。
- **不做「清空远端数据」按钮**（2026-11-25 决定）：不想要云上的内容，去 GitHub 删 `meta.json` 与 `devices/` 更直观；软件里少一个不可逆的危险操作。
- **不做「一条笔记里移除单个词」的 noteItem 删除事件**（2026-11-25 决定）：没有这个 UI 流程；删词条会级联清掉关联，两端一致。哪天真的加了那个功能，再一起补 delete 分支（见 HANDOFF-SYNC §6 坑 21）。
- **不做冲突明细记录**（原计划有 `SyncConflict` 类型）：v1 的合并规则是确定的（字段级 LWW / 数组并集 / 删除优先），没有「无法判定」的情形；`sync_runs` 只记计数与错误码。
- **`apiBase` 不做界面入口**（2026-11-25 决定）：目标用户普遍有 VPN，代理退路留给「自己改 `settings.json` 的 `sync.apiBase`」；界面少一个容易被改错的字段。字段本身保留（`manager` 会读写它）。

---

## 10. 实现记录

> 交接专用文档：[HANDOFF-SYNC.md](HANDOFF-SYNC.md)（现状、下一步、代码地图、坑、开场提示词）。本节只记“做过什么、结论是什么”。

### S0 第一步：重放（2026-11-23，`feat/sync`，**判据通过**）

PLAN-SYNC §5 的 S0 退路写在前面：如果三天内做不到「重放 == 真实卡片」，就退回「以 cards 为准 + 冲突副本」。**这一步现在有结论了：重放成立。**

**做了什么**

| 改动 | 说明 |
|---|---|
| `src/main/fsrs.ts`：`replayCard(reviews, cardId?)` | 从复习记录重放卡片状态；只用长期调度器（因为 `applyReview` 今天不看 `mode`） |
| `src/main/fsrs.ts`：`enableFuzz: false` | **这条是前提**：开 fuzz 时间隔带 ±5% 随机抖动，两台设备重放同一串复习会得出不同 `due_at`，「cards 是 reviews 的函数」不成立 |
| `src/main/db/cards.ts`：`applyReview(input, now = new Date())` | 可选时钟，测试用来钉时间；生产不传，行为不变 |
| `tests/replay.test.ts`（新，3 项） | 走真实写入口（`createNote` → `upsertItem` → `applyReview`）造轨迹，再和库里那张卡逐字段比 |

**golden test 覆盖的轨迹**：学习步骤（3 → 3，间隔 10 分钟）→ 隔天忘了（2）→ 重来（3）→ 考试模式（4，这里验证「mode 不影响调度」）→ 两周后完全忘（1）→ 当天重学（3）。结果：`due_at` / `state` / `reps` / `lapses` / `stability` / `difficulty` / `fsrs_json` **全部相等**；连跑三次逐字节一致。

**两个必须记住的坑**

1. `newCard()` 每次生成随机 `cardId`（ts-fsrs 内部的 uuid），它会出现在 `fsrs_json` 里。重放时要么沿用原卡的 `cardId`（`replayCard(reviews, cardId)`），要么比较时忽略该字段——否则「只差一个 uuid」会被当成重放不成立。
2. `reviews.reviewed_at` 只存到秒（`localIso`），而生产时钟带毫秒。早复习（还没到期就点）时这点差别会放大到几秒，所以**合并后本地那张卡的 `due_at` 会挪动几秒**。收敛性不受影响（每台设备从同一批记录重放得出同一结果），`due_at` 也只用于排序/到期判断，接受。

### S0 第二步：uid + 迁移（2026-11-23，`feat/sync`）

`notes` / `items` / `reviews` / `exams` 各有 `uid TEXT`（唯一索引 `ux_<table>_uid`），`SCHEMA_VERSION` **2 → 3**。

**做了什么**

| 改动 | 说明 |
|---|---|
| `schema.ts` | 四张表的 `CREATE TABLE` 里加 `uid TEXT`；版本号 3 |
| `connection.ts`：`migrateUids()` | 在原有 `BEGIN IMMEDIATE` 事务里跑：`addColumnIfMissing` → 回填 → 建唯一索引 |
| `notes.ts` | `createNote` 生成 uid；`copyNotes` 的 `INSERT … SELECT` 也带 uid（**每份复制重新生成**，不沿用源行） |
| `items.ts` / `exams.ts` / `cards.ts` | `upsertItem` 新增分支、`createExam`、`applyReview` 的 reviews 插入各生成 uid |
| `tests/uid.test.ts`（新，4 项） | 用真实写入口造数据 → 退回 v2（DROP COLUMN + `user_version = 2`）→ 重开迁移 |

**三个实现要点**

1. **唯一索引不能写进 `SCHEMA`**：老库还没有 `uid` 列时 `CREATE UNIQUE INDEX … (uid)` 会直接
   `no such column`（和 `ix_notes_deck` 是同一个坑）。索引统一由 `migrateUids()` 在补列之后建。
2. **必须回填**：SQLite 唯一索引允许多个 NULL，老行全是 NULL 就等于没有 uid。回填用
   `newUid(Date.parse(<时间列>))`：`reviews` 取 `reviewed_at`，其余取 `created_at`。
3. **重复 uid 兜底**：若库里已有重复（手工改库 / 早期实验版本），保留 id 最小的那行、其余重新生成，
   否则建唯一索引会失败 → 应用起不来。这一条也写进了迁移，代价只有一次全表扫描。

**验证**：`npm run typecheck` 0 错误；`npm test` **19 文件 / 195 项全绿**。测试断言的是
「迁移后行数不变、每行 26 位 uid、集合内无重复、唯一索引真的拦重复」。

### S0 第三步：`sync_ops` + `withSync`（2026-11-23，`feat/sync`）

所有对 `notes` / `items` / `reviews` / `exams` 的写入口，现在都在**自己那条事务里**追加一条
`sync_ops`（§3.4）。`cards` 只同步标志位，留到下一步。

**新文件 `src/main/db/sync.ts`**

| 导出 | 作用 |
|---|---|
| `withSync(meta, fn)` | 开事务 → 执行 `fn` → 同事务写 op；`meta = null` 时只开事务 |
| `recordSyncOp(meta)` | 已在事务里追加一条 op（多实体写入用，如删笔记连带删孤儿词条） |
| `pendingSyncOps(limit)` | `origin = 'local' AND pushed = 0` 的待推送队列（S1 从这里读） |
| `noteUid/itemUid/examUid/deckUid` | 本机 id → 同步 uid |
| `cardFlagUid(itemUid, direction)` | cardFlag 的稳定 id：`<item uid>:<direction>`（卡片没有自己的 uid） |

**op 的形状（定了，S1 直接照这个合并）**

- `uid`：note/item/review/exam 用各自 uid；cardFlag 用 `<item uid>:<direction>`。
- `fields`：键用数据库列名，**不含任何本机整数 id**。跨设备引用一律换 uid：
  `notes.deck_id → deck_uid`、`reviews.card_id → card_uid`、`reviews.exam_id → exam_uid`、
  `exams.scope.deckId → scope.deck_uid`。
- **只记真正变了的字段**（`updateNote` / `updateItem` / `updateExam` / `upsertItem` 的已存在分支）。
  一个字段都没变的 upsert 不写 op（重复入库、原地保存不会刷出一堆噪声）。
- `ts_utc`：事件时间。复习 / 卡片标志用复习发生的时刻（`applyReview` 的可选时钟），其余取写入时刻。
- `origin` 默认 `local`；`remote:<device>` 的 op 照常落库但**不进推送队列**（防回声）。

**四处必须改的东西**

1. **`tx()` 改成可重入**（`connection.ts`）。同步要求「写 + op 同一条事务」，而写入口会互相调用
   （`applyReview` → `addAcceptedZh`、`copyNotes` → 每条 withSync、导入入库 → `createNote` + `upsertItem`）。
   内层直接搭外层事务，只有最外层 COMMIT/ROLLBACK；否则嵌套会报
   `cannot start a transaction within a transaction`。
2. **`removeDeck` 也发 op**：删库时笔记要改 `deck_id`、考试 scope 里的 `deckId` 要改，
   不发 op 别的设备会永远停在旧库。
3. **草稿入库不动**：`importDrafts` 的入库走 `createNote` + `upsertItem`，自动被覆盖；
   `note_items`（笔记↔词条关联）和 `validation_issues` 仍不同步，属于 S1 的传输格式。
4. **`dedupeItems` 不包**：它是启动时的本地修复（老库合并重复词条），跑在 uid 回填之前，
   真正的跨设备归并规则在 S3，届时它会产生新的 `local` op。

**明确没做的事（S1 已接手）**：`decks` 本身不在 S0 的同步范围里（S1 第一步已把它补上：建/改名/删
都发 `deck` op，见下）。`note_items` 也在 S1 补成了独立事件；S0 结束时它还没进传输格式。

**测试**：`tests/sync-ops.test.ts`（新，9 项）——四个写入口的 op 形状与「不含本机 id」、
只记变更字段、移动/复制/删除、删库连带、`origin` 过滤、嵌套写入口，
以及**写失败整体回滚（不留半条数据也不留 op）**。

**验证**：`npm run typecheck` 0 错误；`npm test` **20 文件 / 204 项全绿**。

### S0 第四步：cardFlag（2026-11-23，`feat/sync`）

`cards.suspended` / `learn_mark` / `buried_until` / `needs_check` 不属于重放（§3.3），
按 `cardFlag` 事件同步，字段级 LWW。**卡片本身仍然不传**。

**稳定 id**：`<item uid>:<direction>`（`cardFlagUid()`）。`cards` 没有自己的 uid，
但「词条 uid + 方向」在两台设备上是同一个字符串，落地时再映射成本地 card id。

**三个入口（都是唯一写入口）**

| 入口 | 字段 | 何时发 |
|---|---|---|
| `setDirection` | `suspended` | 打开/关闭听写方向；**首次建卡也发一条 `{suspended:0}`**，否则远端不知道这张卡存在 |
| `markItemLearned` | `needs_check`、`learn_mark` | 学过一个词条，给每张未挂起的卡各发一条（挂起的不发） |
| `applyReview` | `needs_check: 0`（复习的那张）、`buried_until`（同词条其它方向） | 复习时；只发**值真的变了**的 |

**只记变了的值**：`needs_check` 已经是 0、兄弟卡今天已经 bury 过、`learn_mark` 没变，
都不发 op。同一天连点两次复习只会多一条 review op。

**没包的地方**：`dedupeItems()` 合并词条时会把标志从旧卡搬到保留卡，但它是启动时的本地修复
（跑在 uid 回填之前），不产生 op；跨设备的词条归并规则在 S3，届时归并本身会产生新的 `local` op。

**测试**：`tests/card-flag.test.ts`（新，3 项）——suspended 的建卡/挂起、markItemLearned 的
每卡一条且跳过挂起卡、applyReview 的 needs_check 清零与兄弟卡 bury、重复复习不再发标志、
以及标志不会混进 review 的字段里。

**真实库副本迁移验收（§3.4）**

手动测试 `tests/real-db-migration.test.ts`（默认跳过，设 `WORDMEMO_REAL_DB_COPY` 指向副本才跑）：

```powershell
$env:WORDMEMO_REAL_DB_COPY='<副本路径>'
npx vitest run tests/real-db-migration.test.ts
```

跑了两份真实库的副本（都含 `-wal` / `-shm`）：

| 副本 | 迁移前 | 结果 |
|---|---|---|
| `%APPDATA%\WordMemo\wordmemo.db`（应用里正在用的） | 2 笔记 / 14 词条 / 42 卡 / 0 复习 / 0 考试，`user_version = 2` | 自动生成 `backups/wordmemo-pre-migrate-v2.db`；迁移到 3；五张表行数完全不变；四张表 uid 无 NULL、无重复；`integrity_check = ok`；`sync_ops` 为空 |
| `.data/wordmemo.db`（开发用的学习库，含 1205 条复习） | 18 笔记 / 300 词条 / 1205 复习 / 646 卡，`user_version = 2` | 同上；复习表回填被真实数据覆盖 |

**验收结论**：`npm run typecheck` 0 错误；`npm test` **22 文件 / 207 项全绿 + 1 份手动测试跳过**；
`npm run build` 通过；**没有新增任何网络代码**（S0 全程不连网、不写远端）。

**S0 完成**。下一步是 S1（本地队列与快照），见 §5；S1 没通过验收之前不要动 S2 的网络部分。

### S1 第一步：deck 与 noteItem 事件（2026-11-23，`feat/sync`）

S1 开工前确认了两个会定死传输格式的决定（2026-11-23）：

1. **decks 纳入同步**。笔记/考试的 op 早就用 `deck_uid` 指库，但库本身不产生 op，别的设备会拿到指不到的库。
2. **`note_items` 用独立关系事件**（不是塞进 note 字段），两台各加一个词条时并集而不是互相覆盖。

**做了什么**

| 改动 | 说明 |
|---|---|
| `decks.ts`：`createDeck` / `updateDeck` / `removeDeck` | 发 `deck` 的 upsert / upsert（只记变更字段）/ delete op |
| `items.ts`：`finishItemWrite` | 新增或 `raw_line` 变化时发 `noteItem` op（uid = `<note uid>:<item uid>`） |
| `notes.ts`：`copyNotes` | 复制出来的每条关联各发一条 op（用新笔记的 uid） |
| `sync.ts` | 实体加 `deck` / `noteItem`；`delete` op 同时写 `sync_tombstones`（同 uid 只留最新 ts）；`getSyncState` / `updateSyncState`（单行，设备 id 只在本机）；`SYNC_FORMAT_VERSION = 1` |
| `schema.ts` | `SCHEMA_VERSION` 3 → **4**；新表 `sync_tombstones`、`sync_state` |
| `connection.ts` | `uid` 补列/回填/唯一索引的清单加上 `decks`（老库补 `ux_decks_uid`） |

**两个实现细节**

1. **`withSync` 改成「先记 op、再执行 `fn`」**：仍是同一条事务（`fn` 失败连 op 一起回滚），
   但保证「主体」排在依赖它的 op 前面——否则 `noteItem` / `cardFlag` 会先于 note/item/review 落队列，
   S2 按 seq 应用时会先遇到指向不存在实体的关联。
2. **关联的删除不发 op**：删笔记/删词条时 `note_items` 走外键级联，远端应用 delete 时同样级联，
   多发的关联 delete 反而是噪声（S3 处理「一条笔记里移除一个词」时再补）。

**测试**：`tests/sync-relations.test.ts`（新，7 项）——deck 三件事、noteItem 的新建/原文变更/原样不发、
复制笔记的关联 uid、删除影子（含去重）、`sync_state` 稳定性、v3→v4 的 decks.uid 补列与索引。

**验证**：`npm run typecheck` 0 错误；`npm test` **22 文件 / 214 项通过 + 1 份手动测试跳过**。

### S1 第二步：快照与合并引擎（2026-11-23，`feat/sync`）

新文件 `src/main/db/checkpoint.ts`：导出全量快照、校验、合并（`.wmsync` 的读写边界就在这里；
S2 只在这条边界上加 age，合并逻辑不动）。

**快照格式（formatVersion = 1）**

```json
{
  "formatVersion": 1, "kind": "wmsync", "createdAt": "...", "createdAtMs": 1763...,
  "deviceId": "ULID", "deviceName": "…", "counts": {...},
  "tombstones": [...],
  "decks": [...], "notes": [...], "items": [...], "reviews": [...],
  "exams": [...], "noteItems": [...], "cardFlags": [...]
}
```

- 整份快照共用一个 `createdAtMs` 作为**合并时间**；跨设备的引用全是 uid（`deckUid` / `cardUid` / `noteUid+itemUid`）。
- `cardFlags` 导出所有卡片（包括四个字段都是默认值的）：全量快照里「没带」和「是 0」必须能区分，
  否则一台取消挂起、另一台导入时清不掉。
- `tombstones` 一起导出，删除才能随快照传播。

**合并规则**

| 数据 | 规则 |
|---|---|
| 标量字段（notes/items/exams/decks/cardFlags） | **字段级 LWW**。每个字段的最后修改时间从 `sync_ops` 推出来（`clockFor`），没有 op 的老行退回 `created_at` / `updated_at` |
| items 的 `meanings` / `collocations` / `examples` / `accepted_zh` | **并集**（§3.9），不按时间覆盖 |
| `items.learned_at` | 取最早的非空值 |
| `reviews` | 按 uid 并集（不可变）；合并后**重放**受影响卡片（`replayCard`） |
| `noteItems` | 按（note uid, item uid）并集，doc 位置/原文取更新的 |
| `cardFlags` | 字段级 LWW；本机缺这张卡时先建卡（听写方向不会被 `ensureCards` 建出来）。**没有字段时钟的本地非默认值优先**：S0 之前设置过、之后没改过的挂起/标志，不会被一次导入悄悄清掉 |
| 删除 | `tombstones`：删除比更早的 upsert 优先；快照里同 uid 的记录比删除更新 → 复活 |
| 同名库 / 同词不同 uid | 唯一键只允许一条 → 合并进本机那条，并在 `sync_aliases` 记「远端 uid → 本机 uid」（S3 再做真正的词条归并） |

**两条关键设计**

1. **合并回来的 op 标 `origin: 'remote:<deviceId>'`**：不进推送队列（防回声），但会成为
   **下一次合并的字段时钟**——所以同一份快照导入 10 次，第 2 次开始不再产生任何变化（幂等）。
2. **`sync_aliases` 不是 S3 才需要**：两台设备各自建过「默认库」，uid 必然不同；没有别名表，
   A 的笔记导进 B 会掉进「未归类」。表用 `CREATE TABLE IF NOT EXISTS`，老库打开时自动补上。

**测试**：`tests/snapshot.test.ts`（新，8 项）——两台「设备」（两个库文件）走完整验收：
A 造数据（库/笔记/词条/复习/听写方向/考试）→ 导出 → B 导入（含别名、关联、重放、建听写卡）→
B 改标题/补释义/标记已学/再复习 → 导出 → A 导入（字段 LWW、数组并集、复习并集、reps=2）→
**重复导入 10 次指纹与队列长度都不变** → A 删笔记导出 → B 导入后笔记/词条/复习/卡片全清 →
S0 之前的旧卡片标志不被快照默认值清掉 → 格式版本错误与坏文件明确拒绝且不动库。

**验证**：`npm run typecheck` 0 错误；`npm test` **24 文件 / 222 项通过 + 1 份手动测试跳过**；
两份真实库副本重新跑 v4 迁移仍然通过（`SCHEMA_VERSION` 已在 S1 第一步升到 4）。

**S1 明确没做**（都归 S2/S3，别误以为漏了）

- **逐条 op 的合并**：S1 的合并单位是「快照里的记录」；S2 拿到远端增量后，把 op 当单字段更新喂给同一套时钟即可，但入口还没写。
- **推送队列的确认**（`markPushed`）：没有推送就没有「推到哪」，等 S2 的传输层。
- **IPC / 界面**：`sync:export` / `sync:import` 的按钮和文案在 S2；S1 只有库函数与测试。

### S2 第一步：加密边界（2026-11-23，`feat/sync`）

新增依赖 **`age-encryption@0.3.1`**（typage，BSD-3，只依赖 `@noble/*`）——已确认可以加。

**文件格式**（`.wmsync` 与远端分片共用）：

```
WORDMEMO-SYNC 1\n          ← 明文魔数，只用来快速识别「是不是我们的文件」
<age 密文>                  ← 密文里是 { header, payload }
header = { formatVersion, kind, path, deviceId, createdAt }
```

- **路径/类型/版本都放在密文里**：age 没有 AAD，解密后必须校验 `path` 与 `kind` 与预期一致，
  所以「把 A 的文件改名成 B」会被拒绝（`sync/crypto.ts`）。
- 口令错与文件损坏在 age 层无法区分，统一报「同步密码不对，或者文件已经损坏」。
- **`kdfVerifier`**：`scrypt(passphrase, salt)` 的前 16 字节（N=2^15），常量时间比较；
  salt 16 字节随机 hex。`meta.json`（明文）只放 `{ formatVersion, salt, kdfVerifier, createdAt }`。
- **口令规则**：至少 10 字符、常见弱口令表直接拒绝、强度分 0–4；「帮我生成」= 5 个词（约 130 词表）。
- **work factor**：生产默认 18；测试传 12 加速。加密参数写在 age 文件头里，解密不需要知道 work factor。
- `checkpoint.ts` 增加 `exportEncryptedSnapshot` / `importEncryptedSnapshot`（S1 的合并逻辑原样复用）。

**测试**：`tests/crypto.test.ts`（11 项：加解密往返、口令错、密文被改、路径/类型/版本不符、
空口令、强度与生成、`kdfVerifier`）+ `tests/snapshot-crypto.test.ts`（1 项：加密导出 → 另一台设备导入、
**明文里不含标题/单词**、口令错拒绝且不动库、重复导入幂等）。

### S2 第二步：GitHub 客户端（2026-11-23，`feat/sync`）

`src/main/sync/github.ts`：只做「这个仓库里读写文件」，不碰同步语义。

| 能力 | 说明 |
|---|---|
| `getRepo` / `getUser` | 连接校验：仓库存在、`private === true`、有 push 权限、PAT 属于谁 |
| `getFile(path, etag)` | 条件请求（`If-None-Match`），304 不占配额、返回 `status: 304` |
| `putFile` / `deleteFile` | Contents API；带 `sha` 表示更新 |
| `putLargeFile` | >1 MB 走 Git Data：blob → tree（`base_tree`）→ commit → 移动 ref；空仓库自动建首个 ref |
| `listDir` | `devices/` 下列设备 |
| 错误归一 | 401→`pat_invalid`、403（配额 0）→`rate_limited`、403→`forbidden`、404→`not_found`、409/422→`conflict`、429→`rate_limited`、5xx→`server_error`、网络/超时单独分 |
| 配额 | 记录 `x-ratelimit-remaining` / `reset`（S3 的降级策略会用） |

**安全**：token 只在 `Authorization` 头里，不进错误信息、不进日志（测试专门断言错误文案里没有 token）。

**测试**：`tests/github-client.test.ts`（15 项，本地 `http.createServer` mock，不连真网）——
认证头、base64 解码、304、PUT/DELETE、Git Data 全链路、八种错误码、连接失败与超时。

**真仓库**：已按用户授权在 `DepthRecur` 账号下建好 **`DepthRecur/wordmemo-sync-test`**（private、空仓库）。
它**还没被任何测试碰过**——真仓库 e2e 要等 S2 的传输层接上、并且把 PAT 配进应用（或手动脚本）再跑，
且只在手动执行，不进常规 CI。

### S2 第三步：逐条 op 与传输引擎（2026-11-23，`feat/sync`）

**逐条 op 合并**（`checkpoint.ts` 的 `applyRemoteOp` / `applyRemoteOps`）：快照合并只能整份应用，
远端增量是一行一行的 op，所以把同一套规则下沉到单条 op：

- 标量字段按 `sync_ops` 推出来的字段时钟做 LWW；items 的数组并集；`learned_at` 取最早；
- `reviews` 按 uid 只插一次，插完重放卡片；`cardFlag` 沿用「没有时钟的本地非默认值优先」；
- 删除优先：比 tombstone 更早的 upsert 直接忽略，更晚的 upsert 可以复活；
- `deck_uid` / `card_uid` 都过 `sync_aliases`；应用后写 `origin: 'remote:<device>'` 的 op（不推送）。

**新本地表**（`CREATE IF NOT EXISTS`，v4 老库打开即补）：

| 表 | 用途 |
|---|---|
| `sync_files` | 远端路径 → `sha` / `etag` 缓存：PUT 要 sha，条件 GET 要 etag |
| `sync_devices` | 见过的其它设备（S3 的游标/移除设备挂在它上面） |

**传输引擎**（`src/main/sync/engine.ts`）：

1. `connect()`：`getUser` + `getRepo`（公开仓库直接拒绝、无 push 权限拒绝）→
   `meta.json` 不存在就写入 `{ formatVersion, salt, kdfVerifier }`，存在就校验版本与口令。
2. `syncNow()` 先推后拉：
   - 推：当天所有本地 op 写成一个 `devices/<id>/ops/YYYYMMDD.jsonl.age`（age 不能追加，所以每次重写当天文件）；
     **首次同步 / 攒够 200 条 op / checkpoint 超过 7 天**时改推整份 checkpoint，并把本地 op 全部标记已推。
   - 拉：列 `devices/`，逐个设备**先 checkpoint 再 ops**（op 是 checkpoint 之后的增量），
     两个路径都吃 `sync_files` 的 etag 缓存（没变就是 304）。
   - 每次同步更新 `info.json.age`（设备名）与 `sync_state.last_push_at/last_pull_at`。
3. 错误保持类型：网络/接口是 `SyncApiError`，口令/仓库/格式是 `SyncSetupError`，UI 直接按 code 说话。
4. 测试用 `workFactor` 把 age 的 scrypt 从 18 降到 12；生产不传。

**顺手修掉的一个真 bug**：客户端 `getFile/putFile/deleteFile/listDir` 的 URL 少了 `/contents`，
之前的客户端测试断言太松没抓到，引擎一写 `meta.json` 就 404；已改为 `contentsPath()` 并在测试里断言完整 URL。

**测试**：`tests/remote-ops.test.ts`（6 项：五类实体依次落地、旧 op 不改/新 op 改、数组并集、幂等、
删除优先与复活、批量计数）+ `tests/sync-engine.test.ts`（5 项：两台设备对着**内存里的假仓库**走完
「A 推 → B 拉 → B 改并推 op 分片 → A 拉并应用 → 再同步 0 变更」，以及口令错、公开仓库拒绝）。

**验证**：`npm run typecheck` 0 错误；`npm test` **29 文件 / 260 项通过 + 1 份手动测试跳过**；`npm run build` 通过。

**S2 还差**：`safeStorage` 记住口令、IPC + 界面（连接向导 / 状态面板 / 快照按钮）、
退避与抖动的调度器、真仓库 e2e。设备移除、checkpoint 压缩/保留、`sync_devices` 游标按计划属于 S3。

### S2 第四步：真仓库 e2e（2026-11-23，通过）

手动测试 `tests/real-sync.test.ts`（默认跳过；本机用 `.data/sync-e2e.ps1` 从 Windows 凭据管理器取
token 后跑，不会打印 token）。在 **`DepthRecur/wordmemo-sync-test`** 上跑完了完整链路：

- A（临时库）建笔记 + 词条 → `connect()`（仓库私有、PAT 有效）→ 首次同步推 `meta.json` / `info` / `checkpoint`；
- B（另一个临时库）连接、校验口令、拉 A 的 checkpoint → 数据齐全；
- B 改标题、推当天 op 分片 → A 再同步拉到并应用 → 标题变成 B 改的版本。

耗时约 41 秒（scrypt + 跨境网络；测试超时设为 180 秒）。仓库里落的是
`meta.json`（明文，只有 salt/kdfVerifier）与 `devices/<id>/{checkpoint,info,ops}` 的 age 密文。
这条测试只在手动跑，不进常规 CI。

### S2 第五步：safeStorage、调度与界面（2026-11-23，待手动验收）

**密钥存储**（`src/main/sync/secretStore.ts`）：PAT 与同步口令只写
`<userData>/sync-secrets.bin`（整份 `safeStorage` 加密；不可用时与 AI Key 一样退化为 base64）。
`settings.json` 的 `sync` 只有 `{ enabled, owner, repo, apiBase, intervalMin }`，**没有任何密钥**。

**调度**（`src/main/sync/scheduler.ts`，7 项假定时器测试）：

- 启动 60 秒后拉一次；写操作 debounce 30 秒；两次自动同步至少隔 60 秒；
- 成功后按 `intervalMin`（0/5/10/30/60，0 = 只手动）；失败退避 1→5→15→60 分钟封顶；
- 所有自动触发 ±20% 抖动；`dispose()` 停掉；手动「立即同步」不受限。

**管理器**（`src/main/sync/manager.ts`）：

- `connect`：校验 PAT/仓库/口令 → 保存密钥与设置 → 立即首次同步（首同步失败不回滚连接）；
- 状态：`disconnected / idle / syncing / error`，带上次成功、待上传条数、设备 id/名称、错误码；
- 退出前 `flushBeforeQuit(3000)` 尽力推一次（`before-quit` 只拦一次，防死循环）；
- `onSyncOpWritten`：本地写入触发 `markDirty()`；合并写回的 remote op 不触发。

**界面**（设置页新增「同步」一节，`src/renderer/src/components/SyncPanel.tsx`）：

- 未连接：仓库（owner/repo）、PAT、同步密码（强度条 + 「帮我生成」）、自动同步间隔、「测试并首次同步」；
- 已连接：仓库/状态/上次成功/待上传/设备、立即同步、导出加密快照、导入加密快照（合并）、断开连接；
- 文案级别按 MESSAGES：未连接与「已取消」是提示；PAT 失效、口令错、文件损坏、格式不符、连接失败是错误；
  「上次同步失败」用红色，不弹窗；密码页明确写「忘了这串密码，云上的数据谁也解不开」。

**IPC / preload**：`sync:status|connect|disconnect|now|export|import`，事件 `sync:event`；
导出/导入用系统文件对话框。

**冒烟**：用临时 `WORDMEMO_DATA_DIR` 启动构建后的应用 → 托盘正常、`diagnostics.log` 无错误；
CDP 打开「设置 → 同步」→ 表单渲染完整、控制台 0 错误（截图 `.data/shots/sync-panel.png`）。

**测试**：`tests/sync-scheduler.test.ts`（7 项）、`tests/sync-secrets.test.ts`（3 项）；
`npm test` **32 文件 / 270 项通过 + 2 份手动测试跳过**；`npm run build` 通过。

**手动验收准备**：`DepthRecur/wordmemo-sync-test` 已清空（原有 e2e 数据用的是固定测试口令），
你可以在设置页自选同步密码；两台设备用同一仓库、同一密码即可。

### S3：冲突与设备管理（2026-11-24，`feat/sync`）

并发规则在 S1/S2 的合并引擎里已经落地（字段级 LWW、数组并集、`learned_at` 取最早、
tombstone 删除优先、同词不同 uid 走 `sync_aliases`）；S3 补的是**设备级**能力：

| 能力 | 实现 |
|---|---|
| 设备列表 | `engine.listDevices()`：本机 + 远端 `devices/*`；名字从加密的 `info.json.age` 解出，解不开退回 `sync_devices` |
| 移除设备 | `removeDevice(id)`：写 `meta.revokedDevices` → 删远端设备目录（checkpoint/info/ops）→ 清本地缓存与 `sync_devices` |
| 被移除的设备 | 每次同步前重新读 `meta.json`；本机 id 在 `revokedDevices` 里 → `SyncSetupError('device_revoked')` |
| 换密码 | `changePassphrase(new)`：新口令重写本机 checkpoint → 更新 meta（新 salt/kdfVerifier）→ 删其它设备目录（旧密文）→ 本机密钥换新 |
| 压缩 | checkpoint 覆盖全部历史后，删掉本机所有 op 分片（`pruneOwnOps`） |
| 远端目录被删后的自愈 | 每次推送前探测自己的 checkpoint 是否还在；不在就整份重推（`remoteExists`） |
| 过期 sha | `putFileSafe`：PUT 冲突/404 时丢掉缓存 sha 重建一次 |
| 仓库体积 | `getRepo()` 返回 `size`（KB），状态里带给界面 |
| 同步日志 | 新表 `sync_runs`，每次同步记时间/耗时/上下行/结果码，保留最近 20 条 |

**换密码的顺序**（重要）：先推用新口令加密的 checkpoint → 再改 `meta.json` → 最后删其它设备。
这样即使中途失败，也不会出现「meta 已经是新密码、唯一的 checkpoint 却还是旧密码」的不可解状态。

**测试**：`tests/sync-engine.test.ts` 增到 9 项（新增：设备列表、换密码后压缩与删对端、
旧密码拒绝/新密码重新加入、移除设备后对端被拒）；`tests/github-client.test.ts` 覆盖 `size`。

**验证**：`npm run typecheck` 0 错误；`npm test` **32 文件 / 274 项通过 + 2 份手动测试跳过**。

### S4：文档与发布准备（2026-11-24，`feat/sync`）

- README 新增「同步」章节：需要什么、**会泄露什么/不会泄露什么**（表）、忘记密码、
  设备与换密码、`.wmsync` 快照、错误对照表、200 MB 体积提醒。
- 设置页同步面板补齐：设备列表与移除、更换同步密码（危险操作二次确认）、最近同步日志、
  仓库 >200 MB 的黄色提醒。
- 版本 `0.5.1 → 0.6.0`；`release-notes/v0.6.0.md` 三行（数据迁移 / 不可逆 / 改了什么）。
- 手动测试指南收敛成**一个文件**：[test-package/README.md](../test-package/README.md)
  （原来拆成 README / TEST-SYNC / checklist / report-template 四份，翻起来麻烦，已合并删除）。
- 自包含测试包 `test-package/`：单一说明、本机双实例/单实例启动器、一键自检脚本；
  `build-package.ps1` 把说明与便携版 zip 组装成 `release/WordMemo-sync-test-package-0.6.0.zip`。

### S4.1：本机验收自动化（2026-11-24）

本机那半不靠人点：两套 e2e 直接打真仓库（`DepthRecur/wordmemo-sync-test`），跑完自动清空。

- `tests/real-sync.test.ts` 扩到 10 项：首次上传与密文检查、双设备合并、字段级 LWW、
  同名库合并（alias）、删除不复活、设备列表、换密码（旧密码拒绝/新密码重连）、
  移除设备（被移除方被拒）、断网补推、重启（不重推 checkpoint）、加密快照导入幂等。
- `.data/sync-local-e2e.mjs`（`.ps1` 取凭据）：起两个真实实例（各自 `WORDMEMO_DATA_DIR`），
  用 CDP 点设置页真实表单——连接、双向推送、设备列表、点「移除」、换密码、重启后仍在。
- 跑出并修掉 3 个真 bug：
  1. **同名库合并崩溃**：`applyDeckOp` 直接 INSERT，撞 `decks.name` 唯一索引。
     现在和 `mergeDecks` 一样先按名字找本机同名库、记 alias 再合并。
  2. **空同步重传**：`push` 只要「今天有 op」就重写当天分片（新 nonce → 新 commit），
     `pushedOps` 也报成当天总条数。现在没有待推数据直接返回，计数用待推条数。
  3. **跨天漏推**：只推当天 op，断网跨过午夜后前一天的 op 永远推不上去。
     现在把待推（含跨天）和当天分片合并写。
- 顺带把 `info.json.age` 改成「有东西推上去/还没有 info」时才写，避免每次空同步一个 commit。
- 远端偶尔返回「不是 WordMemo 的同步文件」的内容（中转缓存/连接被重置时见过）：`readRemoteEnvelope` 绕过本地 ETag 重拿一次，两次都不对才失败；这轮 GUI e2e 里由此避免了两次误报。
- **同步后界面不刷新**（用户 VM 验收时发现）：数据已经进库，但库列表/笔记列表要重启才看得到，看起来像「应用了 1 条却没动静」。`SyncStatus` 增加 `lastSyncChanges`，渲染进程在「新的成功时间 + 有改动」时重读库/统计并 bump `libraryVersion`（`App.tsx`）。用 `.data/deck-refresh-e2e.mjs` 验证：A 停在笔记库不动，另一台建库+建笔记，A 同步一次后页面直接出现（6 项）。
- **没连接的设备不能导入快照**：导入/导出按钮原来只在已连接时渲染，等于「换机搬数据」走不通。现在按钮常显，未连接时先问一次同步密码（`sync.export/import` 支持可选 `passphrase`，`manager` 在无密钥时用它）。用 `.data/snapshot-ui-e2e.mjs` 走真界面 + 原生对话框验证（8 项：导出密文、无明文、未连接先问密码、导入出现、重复导入不重复）。

**验收完成（2026-11-24）**：用户 VM 手动验收 6/6 通过（双向同步、建库、设备列表、重启），
本机自动化 e2e 全部通过，进入发版。

### 发布 v0.6.0（2026-11-24）

已发布。记录这次发版的实际过程与结果：

- **发版前检查**：`typecheck` 0 错误；`npm test` 274 项通过（30 个文件通过，另 2 份手动测试跳过：真实库迁移、真仓库同步）；
  `build` / `dist` 通过，`release/WordMemo-0.6.0-portable.zip` 142.7 MB。
- **便携版冒烟**：解压真 zip、启动 `app\WordMemo.exe`，用 CDP 点开「设置 → 同步」——面板完整渲染
  （导出/导入加密快照、未连接三步表单、「测试并首次同步」），无控制台错误；版本号 `v0.6.0`。
  这次 APPDATA 重定向没生效，所以动的是真实数据目录（v2→v4 迁移）：已按事前备份逐字节恢复
  （`wordmemo.db` sha256 与迁移前一致、`user_version` 回到 2、`settings.json` 相同）。
- **合并**：`git merge --no-ff feat/sync` 无冲突（56 文件 / +10327 / −216）；merge 后 `npm test` 仍 274 项通过；
  `package.json` / `package-lock.json` 的 `version` 与 `packages[""]` 三处都是 `0.6.0`。
- **tag**：`v0.6.0`（annotated）→ `ad3a400`；`git push origin master` 在第 5 次尝试才通过
  （这台机器到 `github.com:443` 时通时断，用 `.data/push-retry.ps1`），tag 一次推成功。
- **CI**：run `45388841392` 成功。Release `v0.6.0` 三件套齐全：`latest.json` 611 B、
  `WordMemo-0.6.0-portable.zip` 149674909 B、`.sha256` 94 B；声明 sha256 `584de04c…`。
- **核对**：`latest.json` 的 `version` / `zip` / `sha256` 与 `.sha256` 一致（CI 另外断言了 zip 实际字节的 sha）；
  `notes` 171 字符（来自 `release-notes/v0.6.0.md` 三行，只提结构化数据同步，与 README「会泄露/不会泄露」表不冲突）。
  另按 `updater.parseLatestInfo` 的规则校验线上 `latest.json` 全部通过，0.5.1 的用户会看到更新、0.6.0 不会重复提示。






### 0.7 与 §3 描述不一致的地方（2026-11-26 复核）

实现时有几处设计被改了或没做，**以这里为准**（§3 的正文保留为当时的设想）：

| 原设想 | 现在的做法 | 原因 |
|---|---|---|
| 遇到 op 的 `seq` 缺口就停止该设备，不猜不跳过 | 改成 `etag` + 内容哈希 + 幂等重放，不维护 seq 游标 | 分片总是整体重写，没有稳定的 seq 序列；幂等比游标简单且不会漏 |
| 删除保留 30 天可恢复 | 只做「30 天清理」，**没有恢复入口**（D-05 定的是方案 B）：`sync_tombstones` 不存内容，恢复要升 schema v5 | 恢复需要删除时的整行快照；把 schema 变更和发版绑在一起风险高，留到后续版本 |
| 危险操作「清空远端数据」（二次确认 + 输入仓库名） | 不做（§9） | 去 GitHub 手动删更直观，软件里少一个不可逆操作 |
| 带截图的分步向导 | 单页表单 + README 截图（截图待补，E-02） | 表单只有三个字段，分步反而多一次点击 |
| 同步日志面板显示最近 20 次 | `sync_runs` 保留 20 条，面板显示 8 条 | 面板高度有限；20 条里更早的很少有用 |
| 属性测试验证幂等/交换/结合 | 只测了幂等；交换律在字段级 LWW 下本来不成立（后写覆盖），没有加随机序列测试 | 测试成本高，收益低（规则是确定的） |
| `SyncConflict` 类型记录冲突明细 | 不记录（§9） | 合并规则确定，没有「无法判定」的情形 |
