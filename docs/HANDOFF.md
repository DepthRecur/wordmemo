# 交接文档（给下一个会话 / 未来的自己）

> 最后更新：2026-11-18　当前分支：`master`　仓库：`DepthRecur/wordmemo`（本地已 init，尚未 push）
> 这份文档的目的：**新会话读完它就能直接干活**，不需要重新讨论已经定过的事，也不需要重新调研。

---

## 0. 一句话现状

背单词桌面应用（Electron 38 + React 19 + `node:sqlite` + `ts-fsrs`）已可用。现在要加 4 个功能，顺序是：**多供应商 → 多个库 → 便携版自更新 → 云端同步**。第一个功能（多供应商）**P0 + P1 已完成并验证**：四家都能配 Key、角色路由（默认/视觉）生效、设置页是四张卡片；剩下 P2（模型目录 + 价格自动化）与 P3（打磨）。

---

## 1. 五分钟上手

```powershell
cd D:\ymh\Code\tools\wordmemo
npm install          # 只有删过 node_modules 才需要
npm run typecheck    # tsc --noEmit，必须 0 错误
npm test             # vitest，8 个测试文件（80 项）必须全绿
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
  providers.ts     ← 四家的声明式描述（端点/compat/能力位/unverified），无 if(provider)
  transport.ts     ← buildChatBody / parseChatResponse / normalizeHttpError / requestChat
  client.ts        ← 角色路由（default/vision）+ 按家取 Key + 400 降级重试 + 价格表
  import.ts        ← 7 个调用点里的 OCR/结构化/校验/补搭配/音标（OCR 走 vision 角色）
  prompts.ts       ← 提示词，不动
src/main/settings.ts ← settings.ai 深合并 + secrets.v2.json（多 Key，safeStorage 整份加密）
src/main/db/
  schema.ts        ← 表结构（ai_cache / ai_usage 已有 provider 列）
  connection.ts    ← migrate()，含 addColumnIfMissing()；加列和迁移写在这里
  ai.ts            ← 缓存/用量/月度费用（读写都按 provider 分区）
  notes.ts / items.ts / cards.ts / stats.ts / importDrafts.ts  ← 库功能将来要改这里
src/main/index.ts  ← 启动、托盘、提醒、备份；注意 22-26 行的 dev 数据目录逻辑
src/renderer/src/pages/SettingsPage.tsx ← 四张供应商卡片 + AI 角色区
scripts/Launcher.cs ← 便携版启动器的基础（将来扩展成换目录）
tests/
  providers.test.ts     ← 15 项：传输层/供应商表/错误归一化
  ai-client.test.ts     ← 13 项：client 接线 + 角色路由 + 400 降级（stub fetch，不联网）
  ai-db.test.ts         ← 5 项：provider 列 + 老库迁移回填
  settings-secrets.test.ts ← 5 项：secrets.bin → v2 迁移 + 多 Key 并存
  settings-ai.test.ts   ← 4 项：ai 深合并 + apiKeySet 跟随默认角色
  core.test.ts / drafts.test.ts / phonetic.test.ts ← 既有（25 / 10 / 3 项）
docs/               ← 四份计划 + 调研 + 本文件
```

---

## 5. 下一步：P2（模型目录与价格自动化）

**P0 + P1 已完成并验证**：四家都能配 Key、设置页四张卡片可用、角色路由（default/vision）生效、`secrets.v2` 多 Key。typecheck 0 错误、`npm test` 8 文件 80 项全绿、真机（迁移 + DeepSeek 测试 + 设置页渲染）通过。细节见 [PLAN-PROVIDERS §13](PLAN-PROVIDERS.md) 的三条 2026-11-18 记录。

### 5.1 P2 要做的三件事（PLAN-PROVIDERS §8 P2）

1. **`catalog.ts`**（新文件）：`GET {baseUrl}/models` 拉模型列表 + `ai_catalog(provider, model_id, json, etag, fetched_at)` 缓存；TTL 24h、启动 30 秒后与打开设置页时后台刷新、失败保留上次成功结果（语义抄 DSH 的 `listing-cache.ts`，MIT）。设置页的模型输入改成「可搜索下拉 + 永远允许手填」。
2. **`pricing.ts`**（新文件）+ `scripts/gen-pricing.mjs`：models.dev 快照（构建时只裁 4 家，约 30 KB）+ 远程刷新（TTL 7 天）；**未知模型一律 `priced:false` + 「费用未知 · N tokens」，绝不回落到别家价格**（修掉 `client.ts` 现在按 deepseek-flash 兜底的 bug）。
3. **`ai_usage` 补 `cost_source` / `priced_at`**（`provider`/`catalog`/`snapshot`/`none`），预算在有未定价调用时降级成 token 上限。

### 5.2 顺便要收的欠账

- `ai_cache` 唯一键 `(kind, cache_key)` → `(provider, kind, cache_key)`（旧索引先 drop 再建，旧行已回填 `deepseek`）。
- 非 DeepSeek 家现在按 0 记价（P2 用 models.dev 补上）。

### 5.3 验收（PLAN-PROVIDERS §8 P2）

```powershell
npm run typecheck   # 0 错误
npm test            # 全绿（普通 PowerShell；沙箱内 vitest 会 spawn EPERM）
```

- 断网启动用快照并标注日期；`/models` 指向坏地址时保留旧列表；不在目录里的模型显示「费用未知」。

### 5.4 P3 的欠账（别丢）

- 错误中文化：`src/renderer/src/App.tsx:287`、`src/main/db/importDrafts.ts:338` 还写着「DeepSeek API Key」。
- README 的供应商状态表（DeepSeek 已验证 / OpenAI·Gemini·GLM 未验证）；`scripts/ai-smoke.mjs`（4 调用点 × 4 家，没 Key 的自动 SKIP）。

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

当前状态：git 已 init（master），多供应商 P0 + P1 已完成并验证：四家（DeepSeek /
OpenAI / Gemini / GLM）都能配 Key，角色路由 default/vision，设置页四张卡片，
secrets.v2 多 Key（旧 secrets.bin 自动迁移）。typecheck 0 错误、npm test 8 文件
80 项全绿、真机（迁移 + DeepSeek 测试 + 设置页渲染）通过。

下一步：按 HANDOFF §5 做 P2 —— catalog.ts（/models + 缓存 + TTL）、pricing.ts +
scripts/gen-pricing.mjs（models.dev 快照 + 未知模型 priced:false）、ai_usage 补
cost_source/priced_at、ai_cache 唯一键换成 (provider, kind, cache_key)。验收 =
断网用快照 + 坏地址保留旧列表 + 未知模型显示「费用未知」。做完在 PLAN-PROVIDERS
§13 记一笔并 commit（git commit -s）。
```

---

## 10. 维护纪律

- **一次只做一个功能**，做完在对应计划的「实现记录」里写一笔，然后 commit。
- 建议每个功能开一个分支：`feat/providers`、`feat/decks`、`feat/portable`、`feat/sync`。
- 提交信息用 `feat|fix|refactor|docs(scope): ...`。
- 贡献者用 DCO（`git commit -s`），不引入 CLA。
- **不要做的**：改许可证、把 AGPL 代码抄进来、装 pi-ai（除非供应商超过 4 家）、加安装包/签名、同步附件、把 `scripts/ocr-lab/runs/` 或 `gt/` 加回仓库。
