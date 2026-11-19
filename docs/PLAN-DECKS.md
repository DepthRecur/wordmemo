# 计划 D：多个库（多笔记库 / Deck）

> 目标版本：v0.3　预计 3~4 个工作日　风险：中（改 schema + 一批查询的作用域）
> 前置：无硬依赖，可与「多供应商」调换顺序；**必须在「云端同步」之前完成**
> 相关：[总览](PLAN-NEXT.md) · [复用调研](RESEARCH-REUSE.md)
> **2026-11-18 定稿**：采用方案 A——库是「笔记容器 + 学习范围」，进度仍跟单词走，每库一份每日新词额度。
> **2026-11-19 已完成**（分支 `feat/decks`），实现记录与验收对照见本文 **§15**。

---

## 0. 一页结论

**要解决的**：一次导入 3500 个课标词后，学习队列被它长期占满，上课笔记永远轮不到。

**做法**：加一张 `decks` 表，`notes` 上加 `deck_id`；复习与「每日新词」按库取范围；每库可单独设每日新词上限；笔记列表支持勾选后**批量移动/复制/删除**。合并 = 把 B 库的笔记全部移到 A 库再删空 B；分裂 = 挑一部分移到新库。

**为什么这么小**：卡片和词条**不按库复制**。词条仍是全局去重的一份，卡片仍是全局一份，库只决定「今天从哪个范围里抽卡」。所以不需要改 FSRS、不需要改去重、不需要给每张卡加库维度。

**工作量分布**：schema + 迁移 0.5 天，查询作用域 1 天（最容易漏，必须逐条过），笔记库批量 UI 1.5 天，今日任务/导入/考试/统计/托盘 1 天。

---

## 1. 验收场景（先写死，做完照着走）

1. 建两个库：「上课笔记」「课标词汇」。导入 3500 词到后者，导入 1 份 12 词的笔记到前者。
2. 打开「上课笔记」的今日任务：新词只来自那 12 个词，**看不到** 3500 词里的任何一个。
3. 打开「课标词汇」的今日任务：新词来自 3500 词，每天仍按额度出 20 个。
4. 把「课标词汇」的每日上限改成 5：第二天它只出 5 个新词，「上课笔记」不受影响。
5. 在笔记库页全选「上课笔记」里的 3 份笔记 → 移动到「课标词汇」：目标库的待学数 +N，源库少 3 份。
6. 反选、全不选、Shift 区间选都能用；筛选/搜索状态下「全选」只选当前结果。
7. 合并：把 B 库全部笔记移到 A，删除空 B。分裂：从 A 选一半笔记复制到新库 C。
8. 同一个单词同时出现在两个库：复习任意一边都只扣一次进度，另一边当天不再出这张卡（见 §2.3）。

---

## 2. 关键设计决策

### 2.1 库是什么：**笔记的容器 + 学习范围**，不是「另一套进度」

| 维度 | 我们的模型 |
|---|---|
| 库归属 | `notes.deck_id`，一份笔记只属于一个库 |
| 词条 | 仍全局唯一（`ux_items_headword_norm`，`connection.ts:54`），不按库复制 |
| 卡片/进度 | 仍全局一份（`cards` 唯一键 `(item_id, direction)`，`schema.ts:68`） |
| 库决定什么 | ① 今日任务从哪个范围抽卡 ② 每个库的每日新词额度 ③ 笔记列表/统计/考试的过滤维度 |

### 2.2 为什么不照 Anki 做（调研结论，见 [RESEARCH-REUSE.md](RESEARCH-REUSE.md) §4）

Anki 是「卡属于牌组」：同一个词进两个牌组 = 两张卡、两份进度、复习两遍。**这适合 Anki，因为 Anki 不做全局去重。**

我们做了全局去重（`PLAN.md` 16.15，同一个 `resemble` 被识别成 word 和 phrase 也要并成一条）。如果照 Anki 复制进度：

- 同一个词在两个库各复习一遍 → 对高中生是**净负担**；
- 合并两个库时两份进度必须选一个（丢一边）或做冲突合并（复杂且没有正确解）。

所以：**进度跟着单词走，库只负责范围和额度**。副作用见 §2.3，是刻意的。

### 2.3 同一个词出现在两个库会怎样（写进文档，别让用户猜）

| 场景 | 行为 | 为什么 |
|---|---|---|
| 新词 | 在 A 库学过后（`learned_at` 有值），B 库不再把它当新词 | 一个词只需要"第一次认识"，不该消耗两次额度 |
| 到期复习 | 卡片只有一张；在 A 库复习后 `due_at` 前移，B 库当天不再出现 | 一次复习就是一次复习 |
| 释义/音标/搭配 | 两个库看到的是**同一条词条**（同一份释义） | 这正是全局去重的目的 |
| 例句差异 | 各库的**笔记**各自保留自己的原文行（`note_items.raw_line`），词条层面共享 | 笔记是上下文，词条是知识 |

> 如果哪天真的需要「两个库各背一遍」，那是另一个功能（每库独立进度），代价见 §11 的备选方案 B，本版不做。

### 2.4 每日额度：全局一份 + 每库可覆盖

- `decks.new_per_day` 为 `NULL` → 用 `settings.newPerDay`（默认 20）。
- 有值 → 用库自己的值。
- 「已学多少」也按库算：`learnedTodayCount(deckId)`。
- 不再提供「全部库合计上限」——那是 Anki 的父牌组语义，本版不需要（真需要时加，代价是接口多一个参数）。

---

## 3. 现状盘点（要改的具体位置）

| 位置 | 现状 | 要改成 |
|---|---|---|
| `src/main/db/schema.ts:12` `notes` | 无库概念 | 加 `deck_id`；新增 `decks` 表 |
| `src/main/db/schema.ts:144` `import_drafts` | 无目标库 | 加 `deck_id`，入库时用 |
| `src/main/db/connection.ts:17` `migrate` | 只处理 items/cards/drafts 的列 | 建 `decks`、补 `notes.deck_id`、建默认库、迁移前备份 |
| `src/main/db/notes.ts:25` `SUMMARY_SELECT` / `listNotes` | 全库列表 | 支持 `deckId` 过滤，返回 `deckId`/`deckName` |
| `src/main/db/notes.ts:127` `createNote` | 不写库 | 写 `deck_id` |
| `src/main/db/notes.ts:150` `updateNote` | 只改标题/日期/标签/正文 | 支持改 `deckId`（单选移动） |
| `src/main/db/notes.ts:170` `deleteNote` | 删一条 + 清孤儿词条 | 保留，另加批量版（一次事务） |
| `src/main/db/items.ts:317` `learnedTodayCount` | 全局计数 | 加 `deckId` 作用域 |
| `src/main/db/items.ts:325` `learnQueue` | 全局取新词 | 加 `deckId` 作用域 |
| `src/main/db/items.ts:306` `countUnlearned` | 全局 | 加 `deckId`（统计页用） |
| `src/main/db/cards.ts:53` `dueQueue` | 全局到期 | 加 `deckId` 作用域 |
| `src/main/db/cards.ts:116` `dailyPlan` | 全局计划 | `dailyPlan(deckId)`；额度取库覆盖 |
| `src/main/db/cards.ts:238` `countDue` | 全局（托盘用） | `countDue(deckId?)` |
| `src/main/db/cards.ts:150` `cardsInScope` | 支持 noteIds/tags/itemIds | 加 `deckId`（考试范围） |
| `src/main/db/stats.ts:34` `dashboardStats` | 全局统计 | 加可选 `deckId`，另出「按库汇总」 |
| `src/main/db/importDrafts.ts:237` `commitDraft` | 入库不选库 | 用草稿上的 `deck_id`（缺省=当前库） |
| `src/main/index.ts:155/198` 托盘计数 | 全局 | 当前库 + tooltip 显示总数 |
| `src/main/ipc.ts:76-101` notes/items 处理器 | 单条操作 | 加 `decks:*`、`notes:moveMany/copyMany/removeMany` |
| `src/shared/types.ts:29/56/243` | `NoteSummary`/`NoteQuery`/`ExamScope` | 加 `deckId`/`deckName` |
| `src/renderer/src/pages/Notes.tsx` | 列表无勾选 | 库标签栏 + 复选框 + 批量操作栏 |
| `src/renderer/src/pages/Review.tsx:59` | `review.daily()` 无参 | 传当前库 |
| `src/renderer/src/pages/ImportPage.tsx` | 无目标库 | 导入前选库（记住上次选择） |

**最容易翻车的地方**：`dueQueue`/`learnQueue`/`learnedTodayCount` 三个函数一旦漏掉作用域，就会出现「在 A 库复习到 B 库的词」。所以把作用域收成一个函数，所有查询都调它：

```ts
// src/main/db/decks.ts
/** 某个库范围内的 item id 子查询（供各查询拼接） */
export function deckScopeItemIds(deckId: number): string {
  return `SELECT ni.item_id FROM note_items ni JOIN notes n ON n.id = ni.note_id WHERE n.deck_id = ${deckId}`
}
```
（`deckId` 来自主进程内部、已校验为整数；仍建议用参数绑定而不是拼字符串，写成 `deckScopeItemIds(deckId, params)` 更好。）

---

## 4. 数据模型与迁移

```sql
CREATE TABLE IF NOT EXISTS decks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT,                          -- 为将来的同步预留，ULID
  name TEXT NOT NULL,
  color TEXT,                        -- 可选，前端取色板
  position INTEGER NOT NULL DEFAULT 0,
  new_per_day INTEGER,               -- NULL = 用全局 settings.newPerDay
  created_at TEXT NOT NULL
);

-- notes 增加归属（新库直接建列；老库由 migrate 补）
ALTER TABLE notes ADD COLUMN deck_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS ix_notes_deck ON notes(deck_id, note_date);

-- 导入草稿记住目标库
ALTER TABLE import_drafts ADD COLUMN deck_id INTEGER;
```

迁移步骤（写在 `connection.ts:17` 的 `migrate()` 里）：

1. 建 `decks` 表；
2. 若 `decks` 为空 → `INSERT INTO decks (id, uid, name, position, created_at) VALUES (1, <ulid>, '默认库', 0, <now>)`；
3. 若 `notes` 没有 `deck_id` → `ALTER TABLE ... DEFAULT 1`（老笔记全进默认库）；
4. 建索引；
5. **迁移前先备份**（见总览 §3 的坑），迁移包在 `tx()` 里。

约定：
- 不允许多于一个「默认库」，也不允许删掉最后一个库。
- 库名唯一（`UNIQUE` 可后加；首版用代码校验即可，避免老数据卡住迁移）。
- `position` 用于排序，简单 `↑/↓` 调整即可，不做拖拽。

---

## 5. 查询与额度的作用域（逐条改）

```ts
// 今日计划
dailyPlan(deckId: number): DailyPlan {
  const quota = deckNewPerDay(deckId) - learnedTodayCount(deckId)
  return { learnItems: learnQueue(quota, deckId), reviewCards: oneCardPerItem(dueQueue(deckId)), ... }
}
```

| 查询 | 加什么条件 |
|---|---|
| `learnQueue` | `AND i.id IN (<deckScope>)` |
| `learnedTodayCount` | `AND i.id IN (<deckScope>)` |
| `countUnlearned` | 同上 |
| `dueQueue` | `AND c.item_id IN (<deckScope>)` |
| `countDue` | 同上 |
| `cardsInScope`（考试） | `scope.deckId` 存在时加 `c.item_id IN (<deckScope>)` |
| `listNotes` | `n.deck_id = ?`（`null` = 全部，用于「全部」视图） |

**索引检查**：`ix_notes_deck(deck_id, note_date)`；`note_items` 的 `PRIMARY KEY(note_id,item_id)` 与 `ix_note_items_item(item_id)` 已有。3500 个 item 的子查询在 SQLite 上是毫秒级，不需要物化列。

---

## 6. 批量操作：API 与语义

```ts
// src/main/ipc.ts
ipcMain.handle('decks:list', () => listDecks())                       // 含每库 due/new 计数
ipcMain.handle('decks:create', (_e, name: string) => createDeck(name))
ipcMain.handle('decks:update', (_e, id: number, patch) => updateDeck(id, patch)) // 改名/颜色/额度/位置
ipcMain.handle('decks:remove', (_e, id: number, moveTo: number) => removeDeck(id, moveTo))
ipcMain.handle('notes:moveMany', (_e, ids: number[], deckId: number) => moveNotes(ids, deckId))
ipcMain.handle('notes:copyMany', (_e, ids: number[], deckId: number) => copyNotes(ids, deckId))
ipcMain.handle('notes:removeMany', (_e, ids: number[]) => deleteNotes(ids))
```

### 6.1 移动

```sql
UPDATE notes SET deck_id = ?, updated_at = ? WHERE id IN (...)
```
- 只改归属，**词条/卡片/复习记录一个字节都不动**。
- 目标库的待学数会立刻变化（未学的词进入目标库的新词队列），对话框里要预告：`目标库待学新词 +N`。
- 移动到当前库 = 无操作，按钮直接禁用。

### 6.2 复制

```sql
-- 1) 复制笔记行（标题、日期、标签、正文、来源）
INSERT INTO notes (source_id, deck_id, title, note_date, tags, raw_markdown, status, created_at, updated_at)
SELECT source_id, ?, title, note_date, tags, raw_markdown, status, ?, ? FROM notes WHERE id = ?;

-- 2) 复制笔记→词条的关联（不复制词条本身）
INSERT INTO note_items (note_id, item_id, raw_line, position)
SELECT ?, item_id, raw_line, position FROM note_items WHERE note_id = ?;
```
- **不复制学习进度**（技术上也没有第二份进度）。对话框必须写清：「复制的是笔记内容；这些词的学习进度是共享的，不会重新开始。」
- 同一份笔记可以被复制进同一个库（等于做一份副本），但要在对话框里提示，避免误操作。
- 复制后两份笔记都指向同一批词条：改其中一份的释义会同时影响两份（这是全局去重的必然结果，写在工具提示里）。

### 6.3 删除

```sql
DELETE FROM notes WHERE id IN (...);
DELETE FROM items WHERE id NOT IN (SELECT item_id FROM note_items);  -- 与 deleteNote 现有逻辑一致
```
- 现有 `deleteNote`（`notes.ts:170`）就是这个语义，批量版只是包一层事务。
- 危险提示要说清：「若某个词只存在于这些笔记里，它的卡片与复习记录会一起删除。」

### 6.4 合并与分裂（不写专用功能，用组合实现）

| 操作 | 用户动作 | 系统行为 |
|---|---|---|
| **合并 B → A** | 在 B 里全选 → 移动到 A → 删空 B | 移动 + 删库；不需要「合并」按钮 |
| **分裂 A → B** | 在 A 里挑一部分 → 复制（或移动）到新库 B | 复制/移动；不需要「分裂」按钮 |
| 库改名为「合并后的名字」 | 设置里改名 | 纯文本 |

> 这是你原话里的判断，我同意：**两个批量动作的组合已经覆盖合并/分裂，且比专用按钮更精细**。代价是多点两下，收益是少两套代码和两套边界情况。

---

## 7. 界面

### 7.1 笔记库页（`Notes.tsx`）

```
[上课笔记 12] [课标词汇 3500] [全部]              [+ 新建库]  [库管理]
搜索框… 排序…  [3 个筛选]
┌─ ☑ 标题 ─────────────── 日期 ── 词数 ── 到期 ── 库 ──┐
│  ☑  Unit 3 笔记          11-17    12      3   上课笔记 │
│  ☐  Unit 4 笔记          11-18    14      0   上课笔记 │
└──────────────────────────────────────────────────────┘
已选 1 项   [全选] [全不选] [反选]        [移动到…] [复制到…] [删除]
```

要点（借 Anki Browse 的成熟做法，见调研 §0.5.4 / §4.3）：
- **三个按钮一个都不能少**：全选 / 全不选 / **反选**（最常被漏）。
- 「全选」只作用于**当前筛选结果**，不是整库；筛选条件变化时选择集清空。
- `Ctrl+A`=全选，`Esc`=清空，`Shift`+点击=区间选，`Ctrl`+点击=切换单项。
- 表头复选框支持三态（全选/部分/未选）。
- 批量栏常驻「已选 N 项」，0 选中时按钮禁用，不要靠右键菜单。
- 每个动作都是「选动作 → 选目标库 → 点确认」三段式，这本身就是二次确认。
- 删除按钮用危险色，确认对话框显示条数与「会连带删掉什么」。

**从 Anki 抄来的 4 条硬约束（2026-11-18 产品级调研）**：
1. **动作只吃 id 列表**：`moveNotes(ids, deckId)`，UI 状态与后端零耦合。Anki 的 `get_selected_card_ids()` → `set_card_deck(ids, did)` 就是这个形状。
2. **选区上限 + 按 id 恢复**：Anki 是 `SELECTION_LIMIT = 500`，搜索/排序后按 id 恢复选区、失效 id 丢弃。我们照做，避免 3500 词全选把界面卡死。
3. **「移到新库」内联在目标选择对话框里**（Anki 的 `Ctrl+N`）：输入新库名 → 建库 → 直接带着选中笔记移进去。这样「分裂」只要一次交互，不用「先建空库再回来移动」。
4. **单步撤销**：Anki 的 `Change Deck` 走一个事务（`transact(Op::SetDeck)`）。我们的批量移动/复制各包在一个 `tx()` 里，并提供「撤销上一次批量操作」。

> 注意：**Anki 没有「批量复制到另一个 deck」**（只有单条 Create Copy）。所以「批量复制」是我们自己的语义，必须写清楚（见 §6.2：复制笔记、词条与进度共享），不能指望有先例可参照。

### 7.2 今日任务页（`Review.tsx`）

顶部加库选择器（下拉或标签），每项带 `待学 N · 到期 M` 徽标：

```
[上课笔记 ▾]   今日：待学 20 · 待复习 37
```
- 切换库 → 重新拉 `review:DailyPlan(deckId)`；正在答题时切换要二次确认（避免进度丢失）。
- **默认不提供「全部库」**：那正是 3500 词淹没一切的老问题。全部库只在笔记库页与统计页出现。

### 7.3 导入页（`ImportPage.tsx`）

- 顶部「导入到：[库 ▾]」，默认记住上次选择（`settings.lastDeckId`）。
- 草稿落盘时写入 `deck_id`；`commitDraft` / `commitAll` 按草稿的库入库，不再需要用户二次选。
- 若用户在导入过程中切换库，只影响之后新解析的文件，已落盘草稿不变（横幅提示）。

### 7.4 设置页

新增「库管理」：列表（名称、笔记数、待学数、每日新词上限、颜色）+ 改名 / 调额度 / 上下移 / 删除。删除时弹「把 N 份笔记移到 [库 ▾] 再删除」，**不允许直接删掉带笔记的库**。

---

## 8. 边界情况清单（实现时逐条打勾）

- [ ] 同一个词在两个库：在 A 学 → B 不再当新词；在 A 复习 → B 当天不再出该卡。
- [ ] 移动笔记到「同一个库」：按钮禁用 / 后端直接返回 0。
- [ ] 复制到「同一个库」：允许，但提示会产生同名副本。
- [ ] 删除库：必须先迁移笔记；不能删最后一个库。
- [ ] 删除笔记：只在该词不再被任何笔记引用时才删词条与卡片（沿用现有逻辑）。
- [ ] 3500 词的库：列表分页/懒渲染（笔记详情一次展示 3500 条词条会卡，先测再决定是否虚拟化）。
- [ ] 考试范围（`ExamScope`）指定库 + 标签时，两个条件是与关系。
- [ ] 托盘计数：默认只统计「当前库」，tooltip 里给「全部库共 N 张到期」。
- [ ] 搜索：全局搜索时结果带库徽标；可按库过滤。
- [ ] 统计页：顶部加库过滤，保留全局热力图/连续天数（跨库更真实）。
- [ ] 迁移：老库所有笔记进「默认库」，`decks` 恰好一条，`notes.deck_id` 不为空。

---

## 9. 分阶段实施

### D0 数据层（1 天）

- `decks` 表、`notes.deck_id`、`import_drafts.deck_id`、默认库、迁移（含迁移前备份）。
- `decks.ts`：CRUD + 每库计数（due/new/note 数）+ `deckNewPerDay()` + `deckScope`。
- **验收**：老库打开后所有笔记在「默认库」，计数正确；新建库、改名、调额度生效；迁移前后数据条数一致。

### D1 作用域（1 天，最需要仔细）

- 改 §5 的 7 个查询 + `dailyPlan` 签名；IPC 与 preload 传递 `deckId`。
- **验收**：两个库各导入一份笔记，`dailyPlan(A)` 与 `dailyPlan(B)` 的 item 集合**完全不相交**；同一个词进两库后只在一边算新词；到期卡只出现一次。

### D2 笔记库批量 UI（1.5 天）

- 库标签栏、复选框、三态表头、三个选择按钮、快捷键、区间选、批量栏、三个对话框（移动/复制/删除）。
- **验收**：§1 的第 5~7 条全部手动走通；在筛选/搜索状态下全选只选可见项；反选结果正确。

### D3 周边接入（0.5~1 天）

- 今日任务库选择器、导入目标库、考试范围选库、统计按库过滤、托盘、搜索徽标。
- **验收**：`npm run typecheck` + `npm test` 全绿；六个页面逐一走查；`docs/PLAN.md:757` 的 6 条 DoD 不回归。

---

## 10. 测试计划

**单元测试**（`tests/decks.test.ts`，新增）：
- 迁移：造一个「无 decks 列」的老库 → 迁移后默认库存在、笔记全归 1、`deck_id` 非空。
- 作用域：A/B 两库、交集词；`learnQueue`/`dueQueue`/`learnedTodayCount`/`countDue` 各断言一次。
- 额度：库覆盖 5 vs 全局 20；`learnedTodayCount` 只算本库。
- 批量：`moveNotes` 幂等；`copyNotes` 复制后 `note_items` 条数相等且 `item_id` 不变；`deleteNotes` 只在无引用时删词条。
- 合并/分裂：模拟 200 词 B → 全量移入 A → A 计数 = 两者之和（同名词只算一次）→ 再分裂 100 词到 C，三库互不重叠。
- 库删除：`removeDeck(id, moveTo)` 后笔记全部在 `moveTo`，`decks` 少一条；删最后一个库抛错。

**手动验收**：§1 的 8 条，外加「导入 3500 词的库之后，另一个库的今日任务新词数量不变」。

---

## 11. 备选方案 B：每库独立进度（本版不做，留档）

如果将来真的需要「同一个词在两个库各背一遍」：

- `cards` 加 `deck_id`，唯一键 `(item_id, direction, deck_id)`；`learned_at` 从 `items` 移到 `deck_items(deck_id,item_id)`。
- 复制笔记 = 同时创建一套新卡（全新进度）；移动笔记 = 改卡的 `deck_id`，但目标库若已有同词同向卡，需要冲突规则（保留完成度高的 / 合并复习历史）。
- 代价：复习负担翻倍、数据量翻倍、合并逻辑变复杂、`reviews` 需要额外记 `deck_id` 才能重放。
- 结论：**先做 A。** 真有人提「我要在两个库各背一遍」，再单独评估——这属于新需求，不是本计划的遗漏。

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 漏改某个查询的作用域 | 在 A 库刷到 B 库的词，用户会觉得"库没生效" | 作用域收成一个 helper；`grep` 审计所有 `FROM cards` / `FROM items` / `FROM notes`；单测覆盖七个入口 |
| 批量删除误伤 | 词条与复习记录一起没 | 危险色 + 条数 + 说明「会连带删掉什么」；批量操作进日志（可查不可撤销） |
| 复制后进度共享引发误解 | 用户以为复制=重新开始 | 对话框与工具提示明确写「进度共享」；文档同一句 |
| 移动大量未学词 | 目标库新词队列突然爆炸 | 对话框预告 `待学 +N`；用户自己决定 |
| 3500 词笔记详情卡顿 | 打开要几秒 | 先实测；必要时列表虚拟化（只渲染可视行），不改数据层 |
| 迁移失败 | 老用户打不开 | 迁移前自动备份；事务包裹；失败时提示「已备份到 …，请反馈」 |
| 库数量膨胀 | 管理混乱 | 不设硬上限，但 >10 个时提示「建议合并」，并在设置页按笔记数排序 |

---

## 13. 需要你拍板

1. **复制时是否允许「连学习进度一起复制」**：技术上需要备选方案 B（每库独立卡），本版建议**不复制**（只复制内容）。
2. **今日任务是否保留「全部库」入口**：建议不保留（那正是 3500 词淹没队列的原因），全部库只在笔记库/统计页出现。
3. **托盘计数范围**：建议默认「当前库」，tooltip 里给总数。
4. **删除库的规则**：建议只允许「把笔记迁到某库后再删」，不提供「连笔记一起删」。

---

## 14. 明确不做

- 不做库的层级/子库（Anki 的 deck 树）——本版不需要，且会显著增加查询与 UI 复杂度。
- 不做「一份笔记同时属于多个库」（复制会生成独立笔记行）。
- 不做库之间的拖拽排序（用 ↑/↓ 足够）。
- 不做每库独立的 FSRS 参数/保留率（额度可以每库设，调度参数全局）。
- 不做库级别的标签体系、权限、共享（同步做完后再说）。
- 不做批量编辑词条字段（批量只作用于「笔记」这一层）。

---

## 15. 实现记录（2026-11-19，`feat/decks`）

**状态：D0–D3 完成并验收。** `typecheck` 0 错误；`npm test` **12 个文件 118 项全绿**（新增 `tests/decks.test.ts` 12 项）；真机（本机 Electron 38）用 CDP 跑过导入 → 两库今日任务 → 批量移动/复制/删除。

### 15.1 落地内容

| 层 | 文件 | 做了什么 |
|---|---|---|
| schema | `src/main/db/schema.ts` | `decks` 表（uid/name/color/position/new_per_day/created_at，name 唯一 + NOCASE）、`notes.deck_id`、`import_drafts.deck_id`；`SCHEMA_VERSION = 2` |
| 迁移 | `src/main/db/connection.ts` | `migrateDecks()`：补列、`ix_notes_deck`、建默认库、把老笔记回填到默认库；`backupBeforeMigrate()` 在 `openDb()` **之前**复制 `backups/wordmemo-pre-migrate-v<N>.db`（WAL 先 checkpoint；已有同版本备份则保留旧的） |
| 库 CRUD | `src/main/db/decks.ts` | `listDecks`（含 note/item/unlearned/learnedToday/todayNew/due 计数）、`createDeck`/`updateDeck`/`removeDeck(moveTo)`、`deckNewPerDay`、`currentDeckId`，以及统一作用域 helper `deckInClause`/`deckScope` |
| 作用域 | `items.ts` / `cards.ts` / `notes.ts` / `stats.ts` | `countUnlearned/learnedTodayCount/learnQueue/dueQueue/dailyPlan/countDue/cardsInScope/listNotes/dashboardStats` 全部加 `deckId`；`dailyPlan(deckId)` 的额度 = `deckNewPerDay(deckId) - learnedTodayCount(deckId)` |
| 批量 | `src/main/db/notes.ts` | `moveNotes`/`copyNotes`/`deleteNotes`（一次事务、单次最多 500 份）；复制只复制笔记行 + `note_items` 关联 |
| 导入 | `importDrafts.ts` / `ingest.ts` | 草稿落盘时记 `deck_id`；`commitDraft` 用草稿的库，老草稿（NULL）用当前库 |
| IPC / preload | `ipc.ts` / `preload/index.ts` | `decks:*`、`notes:moveMany/copyMany/removeMany`、`review:daily(deckId)`、`stats:dashboard(deckId)`、`search:query(…, deckId)`、`importer:parse(paths, deckId)`；`settings:update`/批量动作/复习后立即刷新托盘 |
| UI | `DeckPicker.tsx`（新）、`Select.tsx`（新）、`Notes.tsx`、`Review.tsx`、`ImportPage.tsx`、`ExamPage.tsx`、`StatsPage.tsx`、`SettingsPage.tsx` | 库标签栏 + 三态表头 + 全选/全不选/反选 + Shift 区间选 + `Ctrl+A`/`Esc` + 批量栏 + 移动/复制/删除对话框（移动对话框内可「新建并移动」）；**今日任务标题右侧库下拉**；导入目标库；考试范围库；统计顶部库过滤；设置页新增「笔记库」分区（改名/额度/上下移/删库前迁笔记）；**原生 `<select>` 全部换成自定义 `Select`**（弹出层也是圆角） |
| 托盘 | `index.ts` + `tray-bridge.ts`（新） | 托盘计数只算当前库，tooltip 另给全部库总数；菜单里显示「当前库」 |

**当前库**存在 `settings.currentDeckId`（主进程托盘也读同一个值）；笔记库/导入页切库会同时改它，统计页的「统计范围」是独立过滤器。

### 15.2 与计划的差异（有意为之）

- **今日任务页在答题/学习过程中不提供切库**：只在「今日任务」总览页给库标签，避免答到一半切库丢进度（计划里说「切换要二次确认」，这里用「不允许切」替代，更简单也更安全）。
- **批量移动的「目标库待学 +N」预告没做**：`NoteSummary` 没有「这份笔记里还没学的词数」，加字段要再改一条查询；对话框改成写清语义（「目标库里还没学的词会立刻进入它的今日任务」）。真要做时在 `SUMMARY_SELECT` 加一个 `unlearned_count` 即可。
- **不做撤销**（2026-11-19 决定）：批量移动/复制/删除都不留撤销栈。操作本身可重复（挪错了再挪回去），删除前对话框写清「会连带删掉什么」。
- **教材 3500 词的笔记详情未做虚拟化**：本机用 14 词样例与空库验收，未实测 3500 行；`PLAN-NEXT §7` 的 P2 #13 继续留着。
- **搜索的「全部库」视图**：结果表的「库」列就是徽标，没有再加额外的库筛选控件。
- **切库不再防抖（2026-11-19 性能修复）**：只有搜索输入防抖 300ms；切库/排序/刷新立即请求，并按「库 + 排序 + 搜索词」缓存上一份结果，切回时先画缓存、后台刷新。实测 `notes.list` IPC 1~2ms、两库来回切 10~30ms（原来每次都要等 400ms 防抖）。3500 份笔记的极端库：IPC 73ms、首次切过去 230ms——`PLAN-NEXT §7` P2 #13 的虚拟化仍未做，但已不是"切库慢"的原因。

### 15.3 验收对照

| §1 场景 | 结果 |
|---|---|
| 1 建两库、分别导入 | ✅ 真机：14 词样例导入「课标词汇」，2 份笔记在「上课笔记」 |
| 2 上课笔记的今日任务看不到 3500 词 | ✅ `dailyPlan(上课笔记)` 新词为空，`dailyPlan(课标词汇)` 只出本库 5 个 |
| 3 课标词汇按额度出 20 个 | ✅ 默认额度 5（测试库设了 5）；全局库 `dailyPlan(null)` 出 14 个 |
| 4 改上限只影响这个库 | ✅ 改成 2：本库 2 个、另一个库仍 20 个额度 |
| 5 全选 3 份移动到目标库 | ✅ CDP：全选 2 份 → 移动到 → 目标库 +2、源库清空 |
| 6 反选/全不选/Shift 区间选；筛选下全选只选当前结果 | ✅ 逻辑与单测；选区在筛选/搜索/排序变化时清空，单次上限 500 |
| 7 合并/分裂 | ✅ 单测：移动 + 删空库 = 合并（同名词只算一次）；复制一半到新库 = 分裂 |
| 8 同一个词进两库只扣一次进度 | ✅ 单测：学一次两边都不再算新词；dueQueue 两边看到同一张卡 |

**真实老库迁移验证**：拿本机旧的开发库副本（17 份笔记 / 289 词条 / 624 张卡 / 1015 条复习记录，`user_version = 0`）启动：先写出 `backups/wordmemo-pre-migrate-v0.db`，迁移后 `user_version = 2`、`decks` 1 条（默认库）、17 份笔记全部 `deck_id = 1`，四张表的条数一条不少；`decks.list()` 给出 `noteCount 17 / itemCount 289 / unlearned 150 / due 17 / todayNew 20`。

### 15.4 以后再说

- 每库独立进度（备选方案 B）仍未做，`cards.deck_id` 不在本版。
- 移到目标库的「待学 +N」预告、库数量 >10 的合并提示、搜索结果的库徽标样式，都可以后续补。
- **库颜色、按库汇总表：2026-11-19 决定不做**（理由见 HANDOFF §5.3）：颜色在库少时不如看名字、库多时相近色反而降低辨识；汇总表没有对应需求，每库计数已在库标签与设置页可见。
- 迁移备份目前只留同名一份（`pre-migrate-v0.db`）；如果以后 SCHEMA_VERSION 继续升级，旧备份文件名会区分版本，正好各留一份。

### 15.5 二次打磨（2026-11-19）

- **删除批量撤销**：见 §15.2，`undoLastBatch` 及相关 IPC/类型/按钮/测试全部移除。
- **切库性能**：去掉「每次加载都等 400ms」的防抖，只保留搜索输入防抖 300ms；按「库 + 排序 + 搜索词」缓存一份结果，切回先画缓存再后台刷新。实测两库来回切 10~30ms（原 ~500ms），`notes.list` IPC 1~2ms。
- **今日任务库选择器**：两个并排标签换成标题右侧的库下拉，选项带「待学 N · 到期 M」两行信息。
- **圆角统一**：原生 `<select>` 的弹出层是系统方角、CSS 改不到，全部换成自定义 `Select`（按钮与弹出列表都是圆角，键盘 ↑↓/Enter/Esc、点外面关闭、空间不够时向上弹）。复选框仍是方角（允许的例外）。热力图格子/柱状图本身有 1~3px 圆角，保留。
