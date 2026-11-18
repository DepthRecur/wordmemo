# 交接文档（给下一个会话 / 未来的自己）

> 最后更新：2026-11-18　当前分支：`master`　仓库：`DepthRecur/wordmemo`（本地已 init，尚未 push）
> 这份文档的目的：**新会话读完它就能直接干活**，不需要重新讨论已经定过的事，也不需要重新调研。

---

## 0. 一句话现状

背单词桌面应用（Electron 38 + React 19 + `node:sqlite` + `ts-fsrs`）已可用。现在要加 4 个功能，顺序是：**多供应商 → 多个库 → 便携版自更新 → 云端同步**。第一个功能（多供应商）已经在做，**只完成了底层模块，还没有接线**。

---

## 1. 五分钟上手

```powershell
cd D:\ymh\Code\tools\wordmemo
npm install          # 只有删过 node_modules 才需要
npm run typecheck    # tsc --noEmit，必须 0 错误
npm test             # vitest，4 个测试文件必须全绿
npm run dev          # 开发模式启动（脚本已带 --noSandbox）
```

- **`npm test` 报 `spawn EPERM`**：说明你处在受限沙箱里（esbuild 要 spawn 命名管道）。**在普通 PowerShell / CMD 里跑**就没问题。
- 只跑一个测试：`npx vitest run tests/providers.test.ts`
- 打包（现在还用不到）：`npm run dist` → `release/`
- 应用是单实例的：改完代码要先真退出（托盘右键 → 退出），再重新启动，否则加载的还是旧代码。

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
  providers.ts     ← 【新】四家的声明式描述（端点/compat/能力位），无 if(provider)
  transport.ts     ← 【新】buildChatBody / parseChatResponse / normalizeHttpError / requestChat
  client.ts        ← 旧实现，仍是 DeepSeek 专用；**下一步要切到 transport**
  import.ts        ← 7 个调用点里的 OCR/结构化/校验/补搭配/音标
  prompts.ts       ← 提示词，不动
src/main/db/
  schema.ts        ← 表结构（ai_cache / ai_usage 还没有 provider 列）
  connection.ts    ← migrate()，加列和迁移写在这里
  ai.ts            ← 缓存/用量/月度费用
  notes.ts / items.ts / cards.ts / stats.ts / importDrafts.ts  ← 库功能将来要改这里
src/main/index.ts  ← 启动、托盘、提醒、备份；注意 22-26 行的 dev 数据目录逻辑
scripts/Launcher.cs ← 便携版启动器的基础（将来扩展成换目录）
tests/
  providers.test.ts ← 【新】14 项断言（传输层/供应商表/错误归一化）
  core.test.ts / drafts.test.ts / phonetic.test.ts ← 既有
docs/               ← 四份计划 + 调研 + 本文件
```

---

## 5. 下一步：P0 第二块（直接照着做）

**目标**：把 `client.ts` 切到新的 transport，并给缓存/用量加上 `provider` 维度。**行为必须与现在完全一致**（仍然只走 DeepSeek）。

### 5.1 改哪些文件

1. `src/main/db/schema.ts`
   - `ai_cache` 加 `provider TEXT NOT NULL DEFAULT 'deepseek'`
   - `ai_usage` 加 `provider TEXT NOT NULL DEFAULT 'deepseek'`
   - （唯一索引 `(provider, kind, cache_key)` 留到 P1 再做；P0 不动现有唯一键，避免重建表）
2. `src/main/db/connection.ts` 的 `migrate()`
   - 用 `PRAGMA table_info(...)` 判断列是否存在，缺就 `ALTER TABLE ... ADD COLUMN`
3. `src/main/db/ai.ts`
   - `getAiCache(provider, kind, key)` / `setAiCache(provider, kind, key, model, response)`
   - `logAiUsage({ provider, kind, model, ... })`
4. `src/main/ai/client.ts`
   - 删掉本地 `AiError` 类，改为 `export { AiError } from './transport'`
   - `requestOnce`：`const spec = PROVIDERS.deepseek`；调 `requestChat(spec, { baseUrl: settings.baseUrl, model: settings.model, apiKey: key }, opts)`
   - 费用：`PRICES` 改成 `{ deepseek: { ... } }`；未知模型**暂时保留**旧的兜底行为（P2 再改成「费用未知」）
   - `logAiUsage` 带上 `provider: spec.id`
   - `testApiKey` 也走 `requestChat`（发一条 `'回复 ok'`，maxTokens 8）
   - 重试逻辑保持现状：401/402 不重试，其余重试 2 次

### 5.2 验收（必须全过）

```powershell
npm run typecheck   # 0 错误
npm test            # 4 个文件全绿（在普通 PowerShell 里跑）
```

再加真机（DeepSeek Key）：
1. 启动应用 → 设置页「保存并测试」→ 显示连接成功
2. 导入 `samples/demo.txt` → 能结构化出词条
3. 复习一张卡，输入中文答案 → 判分正常（本地命中或 AI）
4. 设置页「本月 AI 费用」有数字（不是 0）

### 5.3 完成后

- 在 `docs/PLAN-PROVIDERS.md` §13 追加一条实现记录（日期、改了什么、验证结果）
- `git add -A && git commit -m "refactor(ai): wire client to transport; add provider columns"`
- 然后进入 P1（接 OpenAI/Gemini/GLM + 设置页四张卡片），P1 的验收方式见 PLAN-PROVIDERS §9.1（两家没有 Key，用夹具 + 「未验证」徽标）

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

当前状态：git 已 init（master），完成 P0 第一块（providers.ts + transport.ts +
tests/providers.test.ts），尚未接线；client.ts 仍是旧实现。

下一步：按 HANDOFF §5 做 P0 第二块（client.ts 接 transport + ai_cache/ai_usage
加 provider 列），验收 = npm run typecheck 0 错误 + npm test 全绿 + DeepSeek
真机四项。做完在 PLAN-PROVIDERS §13 记一笔并 commit。
```

---

## 10. 维护纪律

- **一次只做一个功能**，做完在对应计划的「实现记录」里写一笔，然后 commit。
- 建议每个功能开一个分支：`feat/providers`、`feat/decks`、`feat/portable`、`feat/sync`。
- 提交信息用 `feat|fix|refactor|docs(scope): ...`。
- 贡献者用 DCO（`git commit -s`），不引入 CLA。
- **不要做的**：改许可证、把 AGPL 代码抄进来、装 pi-ai（除非供应商超过 4 家）、加安装包/签名、同步附件、把 `scripts/ocr-lab/runs/` 或 `gt/` 加回仓库。
