# 多个库 Bug 清单（交给修复会话）

> 生成：2026-11-20　基线：`feat/portable`（含 `12fc7ec` 无 Key 修复）　范围：`decks` / `notes.deck_id` / 所有按库作用域的查询 / 库的删除与批量操作 / 库相关 UI
> 这里只列**已经用代码或实测确认**的问题。严重度：P1 = 会丢数据或让功能静默失效；P2 = 明确错误但可绕过；P3 = 体验与健壮性。
> 修复约束（不要动）：方案 A（进度跟单词走，每库一份新词额度）；复制笔记不复制进度；不做撤销；不做库颜色/按库汇总表；单次批量上限 500；热力图/连续天数/正确率跨库是既定设计。
> 每个修复必须：`npm run typecheck` 0 错误、`npm test` 全绿；在 `tests/decks.test.ts` 补一个能复现的用例；不要改 `SCHEMA_VERSION`，除非确实要加列（加列要先升版本，迁移前备份已生效）。

## 速览

| ID | 严重度 | 标题 | 主要文件 | 状态 |
|---|---|---|---|---|
| D-01 | **P1** | 删库/合并后，考试范围仍指向已删库，听写计划静默变空 | `db/decks.ts`、`db/exams.ts`、`planner.ts` | ✅ 已修 |
| D-02 | **P1** | 待入库草稿的目标库被删后，入库进了「当前库」而不是删库时选的目标库 | `db/decks.ts`、`db/importDrafts.ts` | ✅ 已修 + 补测试 |
| D-03 | P2 | 笔记列表「到期」把新卡和全部方向都算进去，和库标签/今日任务对不上 | `db/notes.ts`、`db/cards.ts` | ✅ 界面已删列，死字段已清理 |
| D-04 | P2 | 统计页按库过滤时「今天已复习/总复习数」仍是全局，和页面提示不一致 | `db/stats.ts`、`pages/StatsPage.tsx` | ✅ 已修 |
| D-05 | P2 | 删当前库只靠 UI 补 `currentDeckId`，其它调用方会留下悬空 id | `db/decks.ts`、`pages/SettingsPage.tsx` | ✅ 已修 + 补测试 |
| D-06 | P3 | `cardsInScope` 把「空 noteIds/tags 数组」当成不过滤，考试范围可能被放大 | `db/cards.ts` | ✅ 已修 |
| D-07 | P3 | 设置页删库后不刷新统计（非当前库时），侧边栏/统计页最多旧 60 秒 | `pages/SettingsPage.tsx` | ✅ 已修 |

> **2026-11-20 修复**：以上全部处理完（`fix/decks-ui`，基于 `fix/providers-bugs`），改动与验收见文末「修复记录」。
> 另外修了两个文档收稿后才暴露的 UI 问题：弹窗里的下拉向上弹且被裁剪（U-1）、导入页「导入到」不作用于已识别草稿（U-2）。

**2026-11-20 已顺手修掉（改 `removeDeck` 时一起做的，别再重复开工）**

- **D-02**：`removeDeck` 现在同步 `import_drafts.deck_id`（移到目标库；删最后一个库时置 0）。
- **D-05**：`removeDeck` 现在同步 `settings.currentDeckId`（指向被删库时改为目标库；没有库时写 0，`settings.ts` 已允许 0）。
- **D-07**：`SettingsPage.removeDeckRow` 成功后调用 `refreshStats()`。
- **D-03**：笔记库列表的「到期」列已在 2026-11-20 删除，界面症状消失；`SUMMARY_SELECT` 里的 `due_count` 还留着但没人显示。如果以后还要用这一列，先按本条的计数口径修。

---

## D-01（P1）删库/合并后，考试范围仍指向已删库，听写计划静默变空

**位置**
- `src/main/db/decks.ts:226-242`：`removeDeck(id, moveTo)` 只做 `UPDATE notes SET deck_id = moveTo` + `DELETE FROM decks`，**没有碰 `exams.scope`**
- `src/main/db/exams.ts:16-28`：`scope` 是从 `exams.scope` JSON 解析出来的
- `src/main/planner.ts:49`、`:146`：`cardsInScope(exam.scope)` → `deckInClause('c.item_id', scope.deckId)`（`cards.ts:163`）→ 子查询 `n.deck_id = 已删 id` → 0 行

**现象**
1. 建库 A、导入笔记，建一个「范围库 = A」的听写计划；
2. 在设置里删掉 A，把笔记移到 B（这是允许且推荐的合并操作）；
3. 再打开这个听写计划：`totalCards = 0`、`queue = []`，页面看起来像「这个计划没内容了」，但没有任何提示。用户会以为笔记/计划丢了。

**复现（建议的测试）**
```ts
const A = createDeck({ name: 'exam-A' })
const B = createDeck({ name: 'exam-B' })
const note = addNote(A, ['examword'])
const examId = createExam({ title: 't', examDate: addDays(dateKey(), 7), scope: { deckId: A }, level: 'dictate', targetRetention: 0.95, dailyMinutes: 20 })
expect(buildExamPlan(examId).totalCards).toBeGreaterThan(0)
removeDeck(A, B)
expect(getExam(examId)!.scope.deckId).toBe(B)       // 现在还是 A
expect(buildExamPlan(examId).totalCards).toBeGreaterThan(0) // 现在是 0
```

**建议修法**
- 在 `removeDeck` 的事务里，读出所有 `exams` 行，`parseJson<ExamScope>`，把 `scope.deckId === id` 改成 `moveTo`，再写回 `exams.scope`。
- 用 JS 解析/写回，不要用 SQLite 的 JSON1（node:sqlite 的 JSON 函数可用性随版本，跨版本更稳的是 JS）。
- 如果 `scope` 里没有 deckId（全部库）或 deckId 不是被删库，保持原样。
- 不要删考试、不要改 `noteIds`（笔记本身被移动，id 不变，noteIds 仍然有效）。

**测试**
- 上面这条；再加一条「范围是全部库的考试不受影响」。
- 现有 `tests/decks.test.ts` 的删库用例继续通过。

---

## D-02（P1）待入库草稿的目标库被删后，入库进了「当前库」而不是删库时选的目标库

**位置**
- `src/main/db/decks.ts:226-242`：`removeDeck` 没有更新 `import_drafts.deck_id`
- `src/main/db/importDrafts.ts:275-280`：`commitDraft` 检查 `row.deck_id` 是否存在；不存在就 `currentDeckId() || defaultDeckId()`

**现象**
1. 当前库是 C；在库 A 的导入页里解析了一份笔记（草稿 `deck_id = A`，还识别了图片/花了 token）；
2. 去设置把 A 删掉，笔记移到 B；
3. 回到导入页提交这份草稿 → 笔记进了 **C**（当前库），不是 B（删库时用户明确选的目标库）。用户找不到刚导的笔记，且 C 的今日任务被意外塞入新词。

**复现**
```ts
const A = createDeck({ name: 'draft-A' })
const B = createDeck({ name: 'draft-B' })
const C = createDeck({ name: 'draft-C' })
updateSettings({ currentDeckId: C })
const draftId = createDraft({ ...payload, deckId: A })
removeDeck(A, B)
const { noteId } = commitDraft(draftId)
expect(getNote(noteId)!.deckId).toBe(B) // 现在是 C
```

**建议修法**
- 在 `removeDeck` 的事务里加 `UPDATE import_drafts SET deck_id = ? WHERE deck_id = ?`（moveTo, id）。
- `commitDraft` 的兜底保留（防老草稿/脏数据），但正常情况下不会再走到。
- 注意 `import_drafts.deck_id` 允许 NULL（老草稿），只更新等于被删库的行。

**测试**
- 上面这条；再加「老草稿 deck_id = NULL 仍进当前库」防回归。

---

## D-03（P2）笔记列表「到期」把新卡和全部方向都算进去，和库标签/今日任务对不上

**位置**
- `src/main/db/notes.ts:28-40` 的 `SUMMARY_SELECT`：
  ```sql
  (SELECT COUNT(*) FROM note_items ni JOIN cards c ON c.item_id = ni.item_id
   WHERE ni.note_id = n.id AND c.suspended = 0 AND c.due_at <= ?) AS due_count
  ```
  没有 `state`/`needs_check`/`buried_until`/`learnAhead` 条件，也**没有按 item 去重**。
- 对照：`src/main/db/cards.ts:54-94`（`dueQueue`）与 `:248-267`（`countDue`）只算 `needs_check=1` 或 `state=2/1/3` 到期、`buried_until` 未到、并按 item 去重；`decks.ts:106-117` 的库标签 `dueCount` 也是同样条件。

**实测（2026-11-20，便携版 0.3.0，无 Key）**
导入 `samples/demo.txt`（14 词，默认开听写卡，所以每词 3 张卡）后，用 CDP 读：
```json
{
  "noteDueCount": 42,
  "noteItemCount": 14,
  "deckDueCount": 0,
  "planReviewCards": 0,
  "planLearnItems": 14
}
```
笔记库显示「到期 42」，但今日任务「待复习 0」、库标签「到期 0」、待学 14。新卡的 `state=0`、`due_at` 在创建时就是当前时间，被这里算成了到期。

**建议修法**
- 让 `SUMMARY_SELECT.due_count` 与 `countDue` 用完全相同的条件（建议抽一个共享 SQL 片段/常量，避免以后再次漂移）：
  - `c.suspended = 0`
  - `IFNULL(c.buried_until,'') < ?`（今天）
  - `c.needs_check = 1 OR (c.state = 2 AND c.due_at <= ?) OR (c.state IN (1,3) AND c.due_at <= learnCutoff)`
  - `COUNT(DISTINCT c.item_id)`（与库标签/今日任务按「词」计一致）
- 这会多一个参数：`SUMMARY_SELECT` 现在调用处传 `localIso()`/`localIso()` 作为唯一参数（`listNotes` 第 63/98 行、`getNote` 第 104 行），要按顺序补齐 `today/now/learnCutoff`。`learnAheadMinutes` 从 `getSettings()` 取。
- 如果产品决定「笔记列表就显示卡片数」，那就把列名改成「到期卡片」并同步改库标签的口径——二选一，不要一个按卡、一个按词。

**测试**
- 新词导入后 `listNotes()[0].dueCount === 0`；
- 学一个词（`markItemLearned`）后 `dueCount === 1`（按词去重，不是 3）；
- 复习后归零；
- 与 `countDue(deckId)` / `dailyPlan(deckId).reviewCards.length` 保持一致。

---

## D-04（P2）统计页按库过滤时「今天已复习/总复习数」仍是全局，和页面提示不一致

**位置**
- `src/main/db/stats.ts:55`：`totalReviews = SELECT COUNT(*) FROM reviews`（没有 deck 条件）
- `src/main/db/stats.ts:72-74`：`reviewedToday` 只按日期过滤，没有 deck 条件
- `src/renderer/src/pages/StatsPage.tsx:93-105`：页面灰字写「数量类指标按『某库』统计；热力图、连续天数和正确率跨库合并」——「今天已复习」是数量类指标，但实际是全局。

**现象**
统计页选「库 A」：到期、词条数、笔记数都按 A 过滤，但「今天已复习」仍显示所有库的复习数；用户会以为 A 的复习量比实际大。`totalReviews` 同理（如果被侧边栏/其它面板用到）。

**建议修法（需要产品确认口径）**
- 推荐：把 `reviewedToday`/`totalReviews` 也按库作用域算：
  ```sql
  SELECT COUNT(*) FROM reviews r
  JOIN cards c ON c.id = r.card_id
  WHERE substr(r.reviewed_at,1,10) = ? <deckScope('c.item_id', deckId)>
  ```
  共享词条（同一个 item 在两个库）会各计一次，这是「按库看」的自然结果；如果不想重复，改用 `COUNT(DISTINCT r.card_id)` 不能解决跨库问题，只能接受或改口径。
- 或者：保持全局，但把 `StatsPage` 的灰字补上「今天已复习/总复习数也是跨库」。二选一，别让 UI 文案和数字打架。
- 注意 `retention30d`/`heatmap`/`streak` 跨库是既定设计，不要顺手改。

**测试**
- 两个库各复习一次，`dashboardStats(A).reviewedToday` 应为 1（当前是 2）；
- `dashboardStats(null).reviewedToday` 仍为 2；
- 热力图/连续天数/正确率保持跨库（现有测试 `tests/decks.test.ts:131-143` 只断言了 heatmap/streak，补一条 retention）。

---

## D-05（P2）删当前库只靠 UI 补 `currentDeckId`，其它调用方会留下悬空 id

**位置**
- `src/main/db/decks.ts:226-242`：`removeDeck` 不更新 `settings.currentDeckId`
- `src/renderer/src/pages/SettingsPage.tsx:421-433`：UI 在删的是当前库时自己 `setDeck(next[0])`
- `src/main/db/decks.ts:54-58`：`currentDeckId()` 会兜底到第一个库，所以主进程不会崩；但 `settings:get` 返回的 `currentDeckId` 仍是已删 id，直到下次 `setDeck`/重启

**现象**
- 从设置页删当前库：UI 会切到 `next[0]`，看起来正常；
- 从其它 IPC 调用（以后可能加的 API、自动化、同步合并）删当前库：`settings.currentDeckId` 悬空；`App` 的 `deckId` memo 会兜底到 `decks[0]`，但 `settings` 里还是旧值；`createNote` 的「无效 deckId → defaultDeck」与 `commitDraft` 的「无效 deckId → currentDeck」兜底不一致，容易出现「进了默认库/进了当前库」两种结果。
- 不影响已有数据，属于健壮性/一致性问题。

**建议修法**
- `removeDeck` 成功提交后：若 `getSettings().currentDeckId === id`，`updateSettings({ currentDeckId: moveTo })`。
- 不要在事务里写 settings 文件（事务回滚时文件已改）；放在事务返回后，失败只记日志，不回滚已删除的库。
- UI 的 `setDeck(next[0])` 可以保留（幂等），但建议改成切到 `moveTo`，和笔记去向一致。

**测试**
- `updateSettings({ currentDeckId: A })`；`removeDeck(A,B)`；断言 `getSettings().currentDeckId === B` 且 `currentDeckId() === B`。
- 删非当前库不改 `currentDeckId`。

---

## D-06（P3）`cardsInScope` 把「空 noteIds/tags 数组」当成不过滤，考试范围可能被放大

**位置**
- `src/main/db/cards.ts:152-194`：`if (scope.noteIds?.length)` / `if (scope.tags?.length)` / `if (scope.itemIds?.length)`——空数组直接跳过
- 调用方：`planner.ts:49`、`:146`（`cardsInScope(exam.scope)`）
- 当前 UI：`ExamPage.tsx:82-89` 在 `form.allNotes || form.scope.length === 0` 时只发 `{deckId}`，所以正常点不到；但 IPC/以后的新 UI 若传 `{noteIds: []}` 想表示「没选任何笔记」，会被解释成「整库/全部库」。

**建议修法**
- 区分 `undefined`（不过滤）与 `[]`（空集合 → `1=0`）：
  ```ts
  if (scope.noteIds !== undefined) {
    if (!scope.noteIds.length) clauses.push('1 = 0')
    else { ... }
  }
  ```
- `tags`/`itemIds` 同理。
- 不要改 `deckId === null/undefined` 的「全部库」语义。

**测试**
- `cardsInScope({ noteIds: [] })` → `[]`；
- `cardsInScope({ noteIds: undefined })` → 不额外过滤；
- `cardsInScope({ noteIds: [n1] })` 只看 n1。

---

## D-07（P3）设置页删库后不刷新统计（非当前库时）

**位置**
- `src/renderer/src/pages/SettingsPage.tsx:420-436`：成功删库后只 `refreshDecks()`；只有删的是当前库才 `setDeck()`（间接刷 stats）
- `src/renderer/src/App.tsx:301-307`：全局统计每 60 秒才刷一次
- 删除非当前库且把笔记移到当前库时，当前库的 `note/item/todayNew` 会变，但侧边栏/统计页最多旧 60 秒

**现象**
删掉库 X、把它的笔记移到当前库 Y：Y 的库标签计数刷新了（`refreshDecks`），但顶部/统计页的数字还是旧的；切到统计页再切回来可能仍是旧的（StatsPage 用 props `initialStats` 同步当前库）。托盘计数因为 IPC 里 `requestTrayRefresh()` 是新的。

**建议修法**
- `removeDeckRow` 成功后调用 `void refreshStats()`（props 已存在，`SettingsPage.tsx:37`）；如果删的是当前库，`setDeck` 已经会刷，重复一次也无害。
- 可选：删库/移动后让 App 的 `libraryVersion` +1，强制 Notes 列表丢弃缓存（目前 Notes 的 `onChanged` 只在 Notes 页内动作时触发）。

**测试**
- UI 手工验收即可；如果要自动化，可在 CDP 里记录 `stats.dashboard` 的调用次数/DOM 数字。

---

## 已确认不是 bug（不要「修」）

- **同一个词进两个库，学一次两边都不再算新词**：`tests/decks.test.ts:111-129` 明确断言；这是方案 A「进度跟单词走」。
- **卡片只有一份、进度不按库分开**：`cards` 没有 `deck_id`，既定设计。
- **批量移动/复制/删除没有撤销**：2026-11-19 决定，操作可重复。
- **单次批量上限 500**：UI 会提示并只选前 500，防 3500 份卡死。
- **库颜色、按库汇总表**：明确不做。
- **热力图/连续天数/30 天正确率跨库**：既定设计（但 D-04 的「今天已复习」不在这个名单里）。
- **删库不能连笔记一起删**：`removeDeck` 的硬约束（`~~不能删最后一个~~` 已于 2026-11-20 放宽：最后一个库可以删，笔记转「未归类」）。

## 建议的修复顺序

1. D-01（考试范围）→ D-02（草稿目标库）：都是「删库后引用没跟着走」，一次事务里一起修最省事。
2. D-03（笔记列表到期数）：用户每天都会看到，实测证据明确。
3. D-04（统计口径）：先确认产品想要「按库」还是「全局」，再改代码或文案。
4. D-05 → D-06 → D-07：健壮性/体验，可单独提交。

## 验证

```powershell
npm run typecheck
npm test
# 多个库相关用例集中在 tests/decks.test.ts；新增用例请沿用该文件的 createDeck/addNote/headers 辅助函数。
```

## 修复记录（2026-11-20，`fix/decks-ui`）

复核时确认：D-02 / D-05 / D-07 与 D-03 的界面症状在此前提交里已经修过，本次只补测试和清死代码；D-01 / D-04 / D-06 本次才真正修。

| 项 | 改法 | 验证 |
|---|---|---|
| **U-1** 弹窗下拉上弹被裁 | `Select` 列表 portal 到 `body` + `fixed`，按视口算空间；下方放不下且上方更宽裕才上翻，`maxHeight` 限制并内部滚动；靠右触发器右对齐，宽度仍 ≤360 | CDP 逐页：笔记移动/复制、导入、今日任务、统计、考试新建、设置；向下弹出、完整可见、键盘/点外部正常 |
| **U-2** 导入「导入到」不改草稿 | `ImportDraftPatch.deckId` + `saveDraft` 单独写 `import_drafts.deck_id`（校验库存在）；下拉显示草稿库、改时同写草稿与当前库，草稿条徽标同步；新文件用下拉显示值 | CDP：改下拉后 header/徽标/`draft_id` 三者一致；`tests/decks.test.ts` 两条 |
| **D-01** 考试范围悬空 | `removeDeck` 事务内用 JS 改写 `exams.scope.deckId` → `moveTo`；删最后一个库时删掉该字段（= 全部库，不写 0） | 单测：范围 A 的计划删库后变 B 且 `totalCards > 0`；全部库范围不受影响 |
| **D-02** 草稿目标库 | 已有修复，补回归测试 | 单测：删库后草稿入库进 `moveTo` |
| **D-03** 笔记「到期」口径 | 界面已无此列，删掉 `NoteSummary.dueCount`、SQL 子查询和多余参数 | typecheck / 全量测试 |
| **D-04** 统计口径 | `reviewedToday`/`totalReviews` join `cards` 后走 `deckScope`；热力图/连续/正确率不动 | 单测：两库各复习一次，按库各 1、全部 2；三项跨库指标相等 |
| **D-05** 当前库悬空 | 主进程写 `currentDeckId` 挪到事务外；`updateSettings` 改 tmp+rename；设置页删当前库后 `refreshSettings()` + `refreshStats(target)`，不再覆盖成列表第一个 | 单测两条 + CDP：删当前库（非第一个）→ 当前库 = 所选目标库 |
| **D-06** 空数组范围 | `cardsInScope` 区分 `undefined` / `[]`，空集合加 `1 = 0` | 单测：`{noteIds: []}`/`{tags: []}`/`{itemIds: []}` 为空，`{}` 不过滤 |

**未做（仍按原文决定）**：库颜色、按库汇总表、撤销、热力图/连续/正确率跨库、笔记列表 3500 条虚拟化、考试页 tag 过滤、>10 库合并提示。`cards.ts` 对悬空 `deckId` 仍会静默返回 0 行（D-01 修好后不会再产生这种数据；如需 IPC 级校验另开）。
