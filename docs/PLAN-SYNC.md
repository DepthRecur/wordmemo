# 计划 B：云端同步（GitHub 私有仓库当网盘）

> 目标版本：v0.5　预计 8~12 个工作日　风险：高（唯一会改数据模型的功能）
> 前置：多供应商 + 多个库 + 自动更新已完成（同步的修复必须能靠自动更新发出去）
> 相关：[总览](PLAN-NEXT.md) · [复用调研](RESEARCH-REUSE.md)
> **2026-11-18 定稿**：同步范围永久限定为结构化数据（不做图片/文件）；`.wmsync` 快照导出/导入从"退路"升级为正式功能。
> 调研结论已并入本文：**Obsidian Git 不是同类**（文件级 git 合并，见 §3.0）；加密改用 age（BSD-3）而不是自己设计信封；CRDT 路线已评估并否掉（§3.5）。

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
| 删除 | tombstone op（`op: 'delete'` + `ts`），删除比同 uid 更早的 upsert 优先；**UI 不提示**，但保留"最近 30 天删除可恢复"的影子表 |
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

| 风险 | 影响 | 对策 |
|---|---|---|
| **「事件流 + 重放」没有开源先例** | 设计可能不成立，S0 才发现 | S0 先做 golden test；不等价就走"以卡为准 + 冲突副本"的保守路线（§5 S0 的退路） |
| **GitHub 在国内访问不稳定** | 同步时好时坏，用户以为软件坏了 | 做成"可失败、可重试、不打断学习"：本地永远优先，同步是后台增强；`apiBase` 可改（走代理）；白送快照导出/导入作为退路 |
| 口令忘记或太弱 | 数据永久不可解 / 等于没加密 | 强度条 + 生成短语按钮 + 连接页明确警告；不提供"找回"（零知识下提供不了） |
| 仓库体积增长 | 克隆变慢、被 GitHub 提醒 | 增量文件 + 月度 checkpoint 保留 2 份；体积面板；>200 MB 提示 |
| 时钟错乱导致"永远输" | 某台设备改动丢失 | `(ts, deviceId)` 断平 + 时钟夹取（±5 分钟） |
| 旧客户端读到新格式 | 静默丢数据 | `formatVersion` 严格校验，不匹配就拒绝并提示升级；这也是必须先把自动更新做掉的原因 |
| 自增 id 与 uid 双轨混乱 | 外键错乱 | 传输格式只用 uid；落地映射集中在一个 `mapRemoteToLocal()` 里；测试覆盖"远端 uid 已存在/本地 headword 已存在/两者都缺"三种情况 |
| PAT 权限过大 | 用户账号风险 | 文档强制 fine-grained + 单仓库 + contents only；界面上写清楚"不要用 classic token" |
| 用户误把仓库设成公开 | 内容泄露（虽然加密） | 连接时检查 `private === true`，公开仓库直接拒绝，并解释原因 |
| 同步把 AI 缓存/日志带出去 | 隐私 | 白名单制：只列允许同步的表/字段；新增表默认不同步 |

---

## 8. 已定 / 待定

| 项 | 状态 |
|---|---|
| 同步范围 | **已定**：只有结构化数据；**图片/文件永不同步**（不是 v1 限制，是产品边界） |
| 快照导出/导入 | **已定**：做，作为正式功能（备份 + 换机 + 离线同步） |
| 同步密钥形态 | **已定：用户口令**（age passphrase + `kdfVerifier` 校验 + 强度条）；不做恢复密钥 |
| 默认同步间隔 | 建议 10 分钟 |
| 远端布局 | 建议「每台设备一个目录」（这是本方案简单的根源） |

## 9. 明确不做

- 不做实时同步、不做协同编辑、不做多用户共享同一仓库。
- 不做自动冲突弹窗（v1 只自动合并 + 记录日志；只在真无法判定时提示"这一条以哪边为准"）。
- 不做 Gitee / 自建 Git 托管（结构上支持，但配置项先只暴露 GitHub；`apiBase` 已留口子）。
- **不做附件同步——永久不做**（图片/docx 原件、TTS 缓存、AI 缓存都不传；`import_drafts` 也不传）。
- 不做"云端备份托管"（那是服务器，违背前提）。

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

**还没做的 S0 部分**（下一步直接接着做）

- ~~`notes` / `items` / `reviews` / `exams` 加 `uid TEXT UNIQUE` + 回填 + `SCHEMA_VERSION` 2 → 3~~
  （2026-11-23 已完成，见下一条）
- 写入口统一 `withSync(entity, uid, fields, fn)` 与 `sync_ops` 表（§3.4）。
- `cards` 的手动状态（`suspended` / `learn_mark` / `buried_until` / `needs_check`）作为 `cardFlag` 事件，不参与重放。

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

