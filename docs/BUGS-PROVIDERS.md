# 多供应商 Bug 清单（交给修复会话）

> 生成：2026-11-20　基线：`feat/portable`（含 `12fc7ec` 无 Key 修复）　范围：四家供应商的请求/重试/缓存/预算/设置页
> 这里只列**已经用代码或实测确认**的问题；有猜测的会标「待确认」。
> 修复约束（不要动）：MIT；只做 DeepSeek / OpenAI / Gemini / GLM；不装 pi-ai；不新增运行时依赖；不做自定义端点；不改设置页的分区结构与圆角组件风格。
> 每个修复必须：`npm run typecheck` 0 错误、`npm test` 全绿、补一个**不联网**的 stub 测试（照 `tests/ai-client.test.ts` 的 `stubFetch` 写法）。

## 速览

| ID | 严重度 | 标题 | 主要文件 |
|---|---|---|---|
| P-01 | **P1** | 非法 JSON 被写入缓存，`chatJson` 的修复重试永远打不中网络 | `ai/client.ts`、`db/ai.ts` |
| P-02 | **P1** | 月度预算只在判分/音标检查，导入的 OCR/校验/搭配/搜索可无限花钱 | `ai/client.ts`、`ai/import.ts` |
| P-03 | P2 | 重试策略没有用 `AiError.retryable`，403/404/200 业务错误被重试 3 次 | `ai/client.ts`、`ai/transport.ts` |
| P-04 | P2 | 导入校验把整份笔记塞进一个 prompt，大笔记必失败 | `importers/extract.ts`、`ai/import.ts` |
| P-05 | P2 | 设置页「保存并测试」测的是已保存的模型，不是输入框里的模型 | `pages/SettingsPage.tsx`、`ai/client.ts` |
| P-06 | P2 | 视觉请求首轮没有应用 `imageDetail:false`，Gemini/GLM 先吃一次 400 | `ai/import.ts`、`ai/transport.ts` |
| P-07 | P3 | AI 缓存键不含 model，换模型仍命中旧模型的缓存 | `db/ai.ts`、`ai/client.ts` |
| P-08 | P3 | Gemini 自定义 Base URL 时，目录仍直连 Google 官方 | `ai/providers.ts`、`ai/catalog.ts` |
| P-09 | P3 | 「AI 可用」只看 Key 不看模型，按钮亮着但一按就报错 | `settings.ts`、`Notes.tsx`、`ImportPage.tsx` |

严重度：P1 = 功能不可用 / 会花钱；P2 = 明确错误但可绕过；P3 = 体验与健壮性。

---

## 修复记录（2026-11-20，分支 `fix/providers-bugs`）

| ID | 状态 | commit | 实际做法（与原始建议的差异） |
|---|---|---|---|
| P-01 | 已修 | `523e86a` | `chat` 加 `expectJson`：要求 JSON 的调用，本轮不是 JSON 就不写缓存；`chatJson` 第二轮真的会发请求 |
| P-02 | 已修 | `8cf35c1` | **不硬停**（产品决定：强制暂停要重来一遍，浪费时间和已花的钱）。`overBudget()` 只触发一次提醒，右下角通知条 + 铃铛，带「本月不再提示」（静音到月底，换月自动恢复）；判分/音标原有的硬停一并去掉 |
| P-03 | 已修 | `1db248d` | 重试只看 `AiError.retryable`，400 仍单次；403/404/200 业务错误各只打 1 次 |
| P-04 | 已修 | `9b7dcd2` | 50 条/批、并发 5，issue index 换算回整份笔记；**任一批失败直接抛错**（产品决定：没校验过的词条不能看起来像校验过了），不再降级成 warning |
| P-05 | 已修 | `d0abec6` | 采用「保存后测试」+ **删掉「保存设置」按钮**：改动 500ms 后自动落盘，测试前先 flush 草稿。只写本页字段，不覆盖当前库与派生标记 |
| P-06 | 已修 | `fdae8fb` | 组包前统一 `sanitizeMessages`，Gemini/GLM 首轮就不带 `detail`；400 降级路径复用同一函数 |
| P-07 | **不修** | — | 产品决定不是 bug：缓存键带 provider/kind/内容哈希，换模型复用同输入的回答可以接受；不做缓存失效 |
| P-08 | 已修 | `8cf35c1` | 选「固定官方」：`catalogUrl()` 明确只影响目录，Base URL 只影响聊天；`AiProviderInfo.fixedCatalogUrl` 让设置页在 Base URL 下写清楚 |
| P-09 | 已修 | `d0abec6` | 新增派生字段 `modelSet` / `aiReady`（不落盘，规则与请求路径共用 `shared/aiModel.ts`）；`aiAvailable()` 也要求模型；「保存并测试」缺 Key/模型时置灰并说明缺什么，其它 AI 按钮只置灰；OCR/导入/重新校验的报错分清缺 Key 还是缺模型 |

验证：`npx tsc --noEmit` 0 错误；`npx vitest run` 14 文件 / 135 通过（新增 P-01/P-02/P-03/P-04/P-06/P-08/P-09 的离线 stub 测试）；`npm run build` 通过；`npm run ai-smoke` 真机 8 次调用全过（DeepSeek + GLM，OpenAI/Gemini 无 Key 跳过）。

---

## P-01（P1）非法 JSON 被缓存，`chatJson` 的修复重试永远打不中网络

**位置**
- `src/main/ai/client.ts:245-256`：`chat` 查缓存 → 请求 → **无条件** `setAiCache` → 返回文本
- `src/main/ai/client.ts:273-306`：`chatJson` 第一次解析失败后，用**同一个 `cacheKey`** 再调 `chat`
- `src/main/db/ai.ts:10-35`：缓存只按 `(provider, kind, cache_key)` 存，不区分内容是否合法

**现象**
模型偶尔返回非 JSON（多了解释、Markdown 代码块、被截断）时，第一次响应被写进 `ai_cache`；`chatJson` 的第二次「请只输出合法 JSON」请求在 `chat` 入口直接命中缓存，**不会发出去**。最终抛「AI 返回的内容不是合法 JSON」，而且同一份输入之后每次都失败（缓存一直命中），用户没有清 AI 缓存的入口。

受影响调用点（都带 `cacheKey`）：`structurize`、`validateItems`、`enrichItems`、`phoneticForItems`、`ocrImage`。

**复现（新测试）**
```ts
let n = 0
const calls = stubFetch(() => {
  n++
  return n === 1 ? { body: 'not json' } : { body: '{"ok":1}' }
})
await expect(chatJson({ messages, kind: 'x', cacheKey: 'k' })).resolves.toEqual({ ok: 1 })
expect(calls).toHaveLength(2) // 现在实际是 1 次 + 抛错
```

**根因**
`chat()` 在 `chatJson` 校验之前就缓存了原始文本；修复轮复用同一 cacheKey。

**建议修法（任选，优先 A）**
- A. `chat` 增加 `cache?: boolean`（默认 true）；`chatJson` 第一轮用 `cache:false`，`JSON.parse` 成功后再写缓存。注意 OCR 等 `chat` 直接调用方仍要缓存。
- B. 修复轮清掉 `cacheKey`（`cacheKey: undefined`）成功后写回。
- C. cacheKey 加 attempt 维度并让失败内容不入库（最小改动但保留一份坏缓存）。

**测试**
- 上面这条；再加「缓存命中合法 JSON 时仍只发 1 次」防回归。
- `tests/ai-client.test.ts` 现有「cacheKey 命中不重复请求」必须继续通过。

---

## P-02（P1）月度预算只在判分/音标检查，导入的 OCR/校验/搭配/搜索可无限花钱

**位置**
- 只在这两处检查 `overBudget()`：`src/main/judge.ts:37`、`:93`；`src/main/importers/phonetics.ts:123`、`:211`
- `chat`/`chatJson` 本身不检查：`src/main/ai/client.ts:237-271`、`:273-306`
- 不受预算约束的调用点：`ai/import.ts:35`（OCR）、`:60`（结构化）、`:74`（校验）、`:100`（搭配）、`:126`（音标）；`search.ts:10`（中文扩展）

**现象**
用户把「每月 AI 预算」设成 3 美元，导入一批图片/大笔记时，OCR、结构化、校验、搭配仍会继续请求；预算提示只在复习判分时出现。一次 3500 词的导入可能远超预算。

**建议修法**
- 在 `chat()` 入口统一检查：`if (overBudget()) throw new AiError('本月 AI 预算已用完，请在设置里调高或等下月', { status: 402 })`。
- 这样 `chatJson` 自动覆盖；判分/音标已有的检查可以保留（早失败）或删掉（统一入口）。
- 注意 402 在 `chat` 的重试规则里本来就不重试，不会被重试放大。
- OCR 是用户显式动作：预算耗尽时给一条明确错误，不要静默降级成空结果。

**测试**
- 设 `monthlyBudgetUsd` 很小 + 写一条超预算的 `ai_usage`，调 `chat({kind:'validate'})`：断言 fetch 0 次、抛 `/预算/`。
- 现有 `tests/ai-pricing.test.ts` 的 `overBudget` 用例保持。

---

## P-03（P2）重试策略没有用 `AiError.retryable`，403/404/200 业务错误被重试 3 次

**位置**
- `src/main/ai/client.ts:258-268`：
  ```ts
  if (status === 401 || status === 402 || status === 400) throw err
  if (attempt < 2) { await sleep(...); continue }
  ```
- `src/main/ai/transport.ts:138-161`：403 的 `retryable` 是 false（测试 `tests/providers.test.ts:113-118` 也这样断言），404 没有 `retryable`（默认 false），HTTP 200 里的 `payload.error` 没有 status/retryable。
- 测试缺口：`tests/ai-client.test.ts` 只覆盖 401/402/500，没覆盖 403/404/200-error。

**现象**
403（地区/权限）、404（模型名或 Base URL 错）、200 业务错误（内容审核等）都会进入 1.2s + 4s 的重试，打 3 次；用户看到错误前多等约 5 秒。若服务端已处理第一次请求，还可能重复计费（usage 只在成功时记）。

**建议修法**
```ts
} catch (err) {
  lastErr = err
  const retryable = err instanceof AiError ? err.retryable : true
  // 400 的未知参数降级已经在 requestOnce 里做过；到这里还不成就别重试
  if (!retryable || (err instanceof AiError && err.status === 400)) throw err
  ...
}
```
注意：网络错误/超时/429/5xx 的 `retryable` 已经是 true；`normalizeHttpError` 是唯一真相来源。`testApiKey` 的 404 文案（「检查 Base URL 与模型名」）保持不变。

**测试**
- 403、404、200-error 各一条：断言 `fetch` 只 1 次、错误文案正确。
- 500 → 第 2 次成功仍然只 2 次（现有用例）。

---

## P-04（P2）导入校验把整份笔记塞进一个 prompt，大笔记必失败

**位置**
- `src/main/importers/extract.ts:363-379`：`const aiIssues = await validateItems(items)`，**全量**
- `src/main/ai/import.ts:74-91`：`validateItems` 把全部词条拼成 `lines`，一次 `chatJson`，`maxTokens: 3000`
- 对比：搭配是 20 条一批（`extract.ts:299-330`）、音标 30 条一批（`phonetics.ts:125`）

**现象**
几百到几千词的笔记（用户的教材库就是 3500 词）会拼成一个超长 prompt：超上下文/超时/费用暴涨；失败时只 push 一条 `AI 校验未完成` warning，用户以为校验跑过了。`maxTokens: 3000` 对 3500 条的返回也不够。

**建议修法**
- 按 `ENRICH_CHUNK` 的思路分批（建议 50 条/批），每批独立请求；把返回的 `index` 加上该批的 offset 再映射到 items。
- 单批失败只影响该批，给一条 warning（不要吞掉整次导入）。
- `maxTokens` 按时分批后的返回量设（例如 2000/批），超时给足。

**测试**
- 造 120 条 items，stub 返回两批 issues，断言至少 2 次请求、每条 issue 的 `tempId` 指到正确的词条。
- 现有 `tests/drafts.test.ts` 的校验提示计数不要被破坏。

---

## P-05（P2）设置页「保存并测试」测的是已保存的模型，不是输入框里的模型

**位置**
- `src/renderer/src/pages/SettingsPage.tsx:178-186`：`patchProvider` 只改 `draft.ai.providers`
- `:206-229`：全局「保存设置」才 `settings.update`
- `:240-268`：`saveProviderKey` 保存 Key 后直接 `testApiKey(p.id)`
- `src/main/ai/client.ts:358-372`：`testApiKey` → `targetFor(id)` → `providerConfig(id)`（读**持久化**的 settings）

**现象**
卡片里原来是 `gpt-4o`，用户把模型改成 `gpt-x`，还没点「保存设置」，直接点「保存并测试」→ 发出去的 `model` 还是 `gpt-4o`。Base URL 同理。测试结果/耗时/错误都对应旧配置，用户会误判新模型不可用。

**建议修法**
- 让 `testApiKey(provider, key, overrides?: { model?: string; baseUrl?: string })` 接收草稿值，只用于本次请求，不写 settings。
- 或者 UI 在测试前先 `settings.update({ ai: draft.ai })` 再 test（会顺带保存其它未保存修改，需接受）。
- 成功后 `loadInfo()` 刷新卡片。

**测试**
- 主进程测试：`testApiKey('openai', 'k', { model: 'm-new' })` 的请求体是 `m-new`，且 settings 里的旧模型没变。

---

## P-06（P2）视觉请求首轮没有应用 `imageDetail:false`，Gemini/GLM 先吃一次 400

**位置**
- `src/main/ai/import.ts:44-49`：OCR 无条件拼 `image_url: { url, detail: 'original' }`
- `src/main/ai/providers.ts:115`（gemini）、`:133`（glm）：`compat.imageDetail: false`
- `src/main/ai/client.ts:157-163`：只有在 400 文案命中 `image_url|detail` 时才 `stripImageDetail`
- `src/main/ai/transport.ts:57-86`：`buildChatBody` 不处理消息里的 `detail`

**现象**
用 Gemini/GLM 做图片识别时，首轮请求带着它们不认的 `detail` 字段；不支持的兼容层返回 400，才走降级重发。首次 OCR 慢一倍，诊断日志里也多一条错误。作者的 Gemini 没有真机验证（`unverified: true`），所以这条优先级低于 P-01/P-02，但修起来很便宜。

**建议修法**
- 在 `requestChat` 组包前按 `spec.compat.imageDetail` 统一清洗 messages（或抽一个 `sanitizeMessages(spec, messages)`），首轮就去掉 `detail`。
- `degradeParam` 的兜底可以保留。
- 注意 DeepSeek/OpenAI 的 `imageDetail: true` 要保留字段。

**测试**
- `sanitizeMessages(geminiSpec, [{content:[{type:'image_url', image_url:{url:'data:...', detail:'original'}}]}])` 输出无 `detail`；DeepSeek spec 保留。
- 现有 `tests/providers.test.ts` 的组包用例不涉及消息，可新增。

---

## P-07（P3）AI 缓存键不含 model，换模型仍命中旧模型的缓存

> **结论：不是 bug，决定不修（2026-11-20）**。缓存键带 provider/kind/内容哈希，换模型复用同输入的回答可以接受；不做缓存失效。

**位置**
- `src/main/db/ai.ts:10-35`：唯一键 `(provider, kind, cache_key)`；`model` 只存不查
- `src/main/ai/client.ts:245-256`

**现象**
同一家从模型 A 换成 B（例如 DeepSeek 的不同模型），判分/OCR/搭配的旧缓存仍然命中；用户以为新模型生效，实际拿到旧模型的答案。缓存没有 TTL，也没有清缓存按钮。

**建议修法**
- 在 `chat` 里把 `target.model` 拼进 cache key：`effectiveKey = hashKey([opts.cacheKey, target.model])`；表结构不用改，旧行自然失效。
- 或者 `getAiCache/setAiCache` 增加 model 条件（要迁移唯一键，成本更高）。
- 加测试：同一 cacheKey、换 model 后必须重新发请求。

---

## P-08（P3）Gemini 自定义 Base URL 时，目录仍直连 Google 官方

**位置**
- `src/main/ai/providers.ts:96-107`：`modelsConfig.url` 固定 `https://generativelanguage.googleapis.com/v1beta/models`
- `src/main/ai/catalog.ts:116-120`：`doRefresh` 用 `spec.modelsConfig?.url ?? modelsEndpoint(spec, providerBaseUrl(...))`，有 url 就永远用 url
- `src/main/ai/client.ts:72-81`：聊天会尊重用户配的 `baseUrl`（代理/中转）

**现象**
用户给 Gemini 配了代理/中转 baseUrl：聊天走代理，但「刷新目录」仍直连 Google。代理环境里目录失败；在意网络策略的用户也会觉得配置没生效。

**建议修法（二选一，先和产品确认）**
- 用户覆盖了 baseUrl 时，目录也走 `providerBaseUrl + /models`（但形状/鉴权要确认中转是否兼容 OpenAI 形态）；或
- 保留官方目录，但在设置页明确写「目录固定走官方端点」并给失败提示，不要静默直连。
- 不要为了这个改 Gemini 的聊天协议。

**测试**
- 单测 `modelsEndpoint`/目录刷新：自定义 baseUrl 时实际 URL 符合预期；没有覆盖时仍是官方 URL。

---

## P-09（P3）「AI 可用」只看 Key 不看模型，按钮亮着但一按就报错

**位置**
- `src/main/settings.ts:140`、`:156`：`apiKeySet = hasApiKey(default)`
- `src/renderer/src/pages/Notes.tsx:716`、`ImportPage.tsx:871`：用 `settings.apiKeySet` 禁用 AI 按钮
- `src/main/ai/client.ts:241-243`：真正调用时才发现 `target.model` 为空并抛「还没有给 X 填模型名」

**现象**
只填了 Key、没填模型时，AI 按钮是可点的；点下去才报错。导入时每次都会产生一条「AI 校验未完成：还没有给 X 填模型名」警告，看起来像 bug。

**建议修法**
- 在 `aiSettingsInfo` 增加 `modelSet: boolean`，或把可用性判断统一成 `hasApiKey && providerModel`；UI 的禁用条件改用服务端返回的 `available`。
- 也可以让 `aiAvailable()` 同时要求模型非空（注意 `ocrImage` 的 vision 角色也要同样处理）。
- 加测试：有 Key 无模型 → `aiAvailable` false / UI 禁用；有 Key 有模型 → true。

---

## 不是 bug（不要「修」掉）

- **OpenAI / Gemini 的 `unverified: true` 徽标**：没有真机 Key，等社区反馈；不要因为「看起来能跑」就摘掉。
- **GLM `whenOff: 'omit'`**：强制思考模型拒绝 `thinking: {type:'disabled'}`，这是 2026-11-19 真机验证的结论；不要改回 `disabled`。
- **DeepSeek 无模型时回退 `deepseek-flash`**：当前默认模型，避免老配置没模型就完全不能用。
- **未知模型 `priced:false`、金额 0、只统计 token**：这是既定预算策略，不要按 DeepSeek 价格猜。
- **图片导入需要 Key**：OCR 本身就是 AI 功能；无 Key 时给明确错误，不做本地 OCR（不在本版范围）。
- **无 Key 时的「解析提示」**：2026-11-20 已从 `issues` 挪到 `warnings`，**不要**再把它塞回待处理校验项。

## 建议的修复顺序

1. P-01（缓存坏 JSON）→ P-02（预算）→ P-03（重试）：这三条影响钱和功能可用性。
2. P-05（设置页测试）→ P-04（分批校验）：用户可见、易验证。
3. P-06 → P-07 → P-08 → P-09：体验与健壮性，可分批提交。

## 验证

```powershell
npm run typecheck
npm test
# 真机（有 Key 时）：npm run ai-smoke（会花几次极短调用；先退出正在运行的应用）
```
