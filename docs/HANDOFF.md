# 交接文档（给下一个会话 / 未来的自己）

> 最后更新：2026-11-18　当前分支：`master`　仓库：`DepthRecur/wordmemo`（本地已 init，尚未 push）
> 这份文档的目的：**新会话读完它就能直接干活**，不需要重新讨论已经定过的事，也不需要重新调研。

---

## 0. 一句话现状

背单词桌面应用（Electron 38 + React 19 + `node:sqlite` + `ts-fsrs`）已可用。现在要加 4 个功能，顺序是：**多供应商 → 多个库 → 便携版自更新 → 云端同步**。第一个功能（多供应商）**P0 已做完并验证**：传输层 + `client.ts` 已接线 + 缓存/用量带 `provider` 列，行为仍是「只用 DeepSeek、和以前完全一样」。下一步是 **P1：接 OpenAI / Gemini / GLM + 设置页四张卡片**。

---

## 1. 五分钟上手

```powershell
cd D:\ymh\Code\tools\wordmemo
npm install          # 只有删过 node_modules 才需要
npm run typecheck    # tsc --noEmit，必须 0 错误
npm test             # vitest，6 个测试文件（64 项）必须全绿
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
  providers.ts     ← 四家的声明式描述（端点/compat/能力位），无 if(provider)
  transport.ts     ← buildChatBody / parseChatResponse / normalizeHttpError / requestChat
  client.ts        ← 已接 transport：ACTIVE_PROVIDER = deepseek，价格表按 provider 分组
  import.ts        ← 7 个调用点里的 OCR/结构化/校验/补搭配/音标
  prompts.ts       ← 提示词，不动
src/main/db/
  schema.ts        ← 表结构（ai_cache / ai_usage 已有 provider 列）
  connection.ts    ← migrate()，含 addColumnIfMissing()；加列和迁移写在这里
  ai.ts            ← 缓存/用量/月度费用（读写都按 provider 分区）
  notes.ts / items.ts / cards.ts / stats.ts / importDrafts.ts  ← 库功能将来要改这里
src/main/index.ts  ← 启动、托盘、提醒、备份；注意 22-26 行的 dev 数据目录逻辑
scripts/Launcher.cs ← 便携版启动器的基础（将来扩展成换目录）
tests/
  providers.test.ts  ← 15 项：传输层/供应商表/错误归一化
  ai-client.test.ts  ← 6 项：client 接线（stub fetch，不联网）
  ai-db.test.ts      ← 5 项：provider 列 + 老库迁移回填
  core.test.ts / drafts.test.ts / phonetic.test.ts ← 既有（25 / 10 / 3 项）
docs/               ← 四份计划 + 调研 + 本文件
```

---

## 5. 下一步：P1（四家供应商 + 设置页）

**P0 已完成并验证**（传输层 + `client.ts` 接线 + `provider` 列；typecheck 0 错误、`npm test` 6 文件 64 项全绿、DeepSeek 真机四项通过）。细节见 [PLAN-PROVIDERS §13](PLAN-PROVIDERS.md) 的两条 2026-11-18 记录。

### 5.1 P1 要做的四件事（按这个顺序）

1. **`settings.ai` 深合并 + 多 Key**（`src/main/settings.ts`、`src/shared/types.ts`）
   - `Settings.merge()` 现在是浅合并，`ai` 必须补深合并，否则老配置一升级就丢字段（PLAN-PROVIDERS §5）。
   - `secrets.bin` → `secrets.v2.json`（整份 JSON 用 `safeStorage.encryptString`；临时文件 + rename 保证原子）；旧文件迁移成 `providers.deepseek`，旧文件保留到用户点「清除全部」。
2. **角色路由**：把 `client.ts` 的 `ACTIVE_PROVIDER` 换成 `settings.ai.default` / `settings.ai.vision`；`testApiKey(provider)` 加参数，旧签名默认 `deepseek`。
3. **接另外三家**：只改 `providers.ts` 的能力位与 `chat()` 的传参；`400` 未知参数用 `AiError.unknownParam` 去掉该参数重试一次；`image_url.detail` 按 `spec.compat.imageDetail` 发不发（`src/main/ai/import.ts:47`）。**不要**写 `if (provider === ...)`。
4. **设置页四张卡片**（`src/renderer/src/pages/SettingsPage.tsx`）：Key 状态 / 模型（可搜索下拉 + 手填）/「保存并测试」/ 未验证徽标（OpenAI、Gemini）/ 本月费用一行。

### 5.2 验收（PLAN-PROVIDERS §8 P1 + §9.1）

```powershell
npm run typecheck   # 0 错误
npm test            # 全绿（普通 PowerShell；沙箱内 vitest 会 spawn EPERM）
```

- DeepSeek（有 Key）真机：设置页测试、导入、判分通过；GLM 申请到免费额度就一起测。
- OpenAI / Gemini 没有 Key：用 `tests/fixtures/` 的录制样例跑请求构造与响应解析，UI 标「未验证」。
- 某家 401 只让那张卡片变红，不影响别家。

### 5.3 完成后

- 在 `docs/PLAN-PROVIDERS.md` §13 追加实现记录，`git commit -s -m "feat(ai): four providers + settings cards"`，再进 P2（目录与价格自动化）。

### 5.4 P0 留下的欠账（P1/P2 一起收）

- 唯一键仍是 `(kind, cache_key)` → P1 换成 `(provider, kind, cache_key)`（drop 再建）。
- 未知模型仍按 `deepseek-flash` 的价格算钱（PLAN-NEXT §7 第 8 条）→ P2 改成 `priced:false` + 「费用未知」。
- `ai_usage` 还缺 `cost_source` / `priced_at` → P2 加。

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

当前状态：git 已 init（master），多供应商的 P0 已做完并验证（providers.ts +
transport.ts + client.ts 接线 + ai_cache/ai_usage 的 provider 列；typecheck
0 错误、npm test 6 文件 64 项全绿、DeepSeek 真机四项通过）。现在仍然只走
DeepSeek，行为与以前一致。

下一步：按 HANDOFF §5 做 P1 —— settings.ai 深合并 + secrets.v2 多 Key + 角色路由
+ 接 OpenAI/Gemini/GLM + 设置页四张卡片；验收 = typecheck 0 错误 + npm test 全绿 +
DeepSeek（有 Key）真机 + OpenAI/Gemini 用夹具标「未验证」。做完在 PLAN-PROVIDERS
§13 记一笔并 commit（git commit -s）。
```

---

## 10. 维护纪律

- **一次只做一个功能**，做完在对应计划的「实现记录」里写一笔，然后 commit。
- 建议每个功能开一个分支：`feat/providers`、`feat/decks`、`feat/portable`、`feat/sync`。
- 提交信息用 `feat|fix|refactor|docs(scope): ...`。
- 贡献者用 DCO（`git commit -s`），不引入 CLA。
- **不要做的**：改许可证、把 AGPL 代码抄进来、装 pi-ai（除非供应商超过 4 家）、加安装包/签名、同步附件、把 `scripts/ocr-lab/runs/` 或 `gt/` 加回仓库。
