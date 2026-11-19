# 计划 A：多供应商（DeepSeek / OpenAI / Gemini / GLM）

> 目标版本：v0.2　预计 **3~4** 个工作日　风险：低
> 前置：无。可与开源准备并行。
> 相关：[总览](PLAN-NEXT.md) · [复用调研](RESEARCH-REUSE.md)
> **2026-11-18 定稿**：供应商收缩到 4 家（+ 可选自定义）。因此**不引入 pi-ai**，改为自写薄适配层 + 声明式配置表；模型名与价格仍然走运行时刷新。

---

## 0. 一页结论

1. **只做 4 家**：DeepSeek、OpenAI、Gemini、GLM。四家都有 OpenAI 兼容端点（Gemini 用官方兼容层），所以**一个 transport 就够**，不需要为每家写一套协议。
2. **不装 pi-ai**。理由见 §3.2：供应商从 9 家缩到 4 家后，一个 0.x、4.5 MB、要求 Node ≥22.19 的依赖，收益已经小于风险。改成自写约 300 行 + 一张声明式表（字段照 Cline 抄，见调研 §0.5.1）。
3. **模型名不写死**：启动后调各家 `/models`，拿到什么显示什么；拉不到就用手填。
4. **价格不靠人抄**：models.dev 快照 + 远程刷新 + 厂商自报，未知就显示「费用未知」，绝不回落成别家的价格。
5. **我们只写 4 件事**：Key 的 DPAPI 存储、角色路由（默认 / 视觉）、SQLite 缓存与预算、中文错误文案。

---

## 1. 范围与理由

| 厂商 | 是否做 | 端点 | 说明 |
|---|---|---|---|
| DeepSeek | ✅ | `https://api.deepseek.com` | 现状，保留为默认 |
| OpenAI | ✅ | `https://api.openai.com/v1` | |
| Gemini | ✅ | `https://generativelanguage.googleapis.com/v1beta/openai/` | 官方 OpenAI 兼容层，不需要 native 协议 |
| GLM（智谱） | ✅（建议直接做） | `https://open.bigmodel.cn/api/paas/v4` | 成本 ≈ 一行配置 + 一次冒烟；国内可直连 |
| 自定义（Ollama / LM Studio / 代理） | ❌ **本版不做** | — | 用的人少；以后加只是一个输入框（见 §12） |

**砍掉通义 / 豆包 / Kimi / 文心 / 混元** 的理由（你的判断）：目标用户（高中生）基本只用得到上面几家；每加一家 = 一套 compat + 一次冒烟 + 一份文档，收益递减。

**以后想加一家的成本**：在 `providers.ts` 加一行 + 跑一次 `ai-smoke`，约半天。架构不需要动——这是声明式表的意义。

---

## 2. 现状盘点（要改的地方）

| 位置 | 现状 | 问题 |
|---|---|---|
| `src/main/ai/client.ts:47` | 手拼 URL，写死 `thinking`、`max_tokens`、`response_format` | 只有 DeepSeek 认 `thinking`；OpenAI 推理模型要 `max_completion_tokens` |
| `src/main/ai/client.ts:25` | 价格表只有 `deepseek-flash`，未知模型**兜底按它算钱** | 换 GPT/Gemini 后金额是错的 |
| `src/main/ai/client.ts:89-92` | 错误文案写死「DeepSeek 账户余额不足」 | 换家以后在骗人 |
| `src/main/ai/client.ts:113-118` | 只读 `prompt_cache_hit_tokens` | 各家缓存字段不同 |
| `src/main/settings.ts:66` | 单个 `secrets.bin` | 只能存一把 Key |
| `src/main/db/schema.ts:111` | `ai_cache` 唯一键无 provider | A 家的答案会被当成 B 家的 |
| `src/main/db/schema.ts:121` | `ai_usage` 只有 `model` | 分不清哪家花的钱 |
| `src/renderer/src/pages/SettingsPage.tsx:176` | 一整块「DeepSeek API」 | 改成 4 家列表 |
| `src/main/ai/import.ts:35` | `image_url` + `detail: 'original'` | `detail` 是 OpenAI 字段，别家兼容层可能报错 |

7 个调用点（`ocr` / `struct` / `validate` / `enrich` / `phonetic` / `judge` / `search-expand`）全部走同一个 `chat()` / `chatJson()`，提示词是纯中文 + JSON 示例。所以换的是传输层，不是业务。

---

## 3. 架构

```
src/main/ai/
  providers.ts    // 4 家的声明式表：baseUrl / api / 能力位 / compat / 环境变量名
  transport.ts    // 唯一的 openai-chat 实现 + 能力降级（400 未知参数 → 去掉重试）
  catalog.ts      // /models：拉取 + 缓存 + TTL + last-known-good（语义抄 DSH listing-cache）
  pricing.ts      // models.dev 快照 + 远程刷新 + 未知处理
  keys.ts         // DPAPI：每家一把 Key
  client.ts       // 角色路由 + 预算 + SQLite 缓存 + 中文错误
  prompts.ts      // 不动
```

### 3.1 声明式表（字段名照 Cline，见调研 §0.5.1）

```ts
export interface ProviderSpec {
  id: 'deepseek' | 'openai' | 'gemini' | 'glm' | 'custom'
  label: string
  baseUrl: string
  api: 'openai-chat'
  capabilities: {
    vision: boolean
    jsonMode: 'force' | 'prompt-only'
    stream: false
  }
  compat: {
    maxTokensField: 'max_tokens' | 'max_completion_tokens'
    temperature: boolean
    reasoning?: { type: 'toggle'; field: 'thinking.type' } | { type: 'effort'; field: 'reasoning_effort' }
    imageDetailField: boolean          // 只有 OpenAI 系发 detail
    usageCache: 'deepseek' | 'openai' | 'none'
  }
  models?: { vision?: string; text?: string }   // 只作占位，真正列表来自 /models
}
```

**禁止** `modelId.includes("...")` 这种硬编码判断（Roo-Code 就是这么写的，模型改名后静默失效）。

### 3.2 为什么不装 pi-ai（结论反转的原因）

| 因素 | 9 家时 | 4 家时 |
|---|---|---|
| 适配层要手写的量 | ~9 套 compat + 视觉差异，易错 | **~300 行**，4 家都是 OpenAI 兼容，差异集中在 3 个字段 |
| 依赖风险 | 0.x、4 个版本 187 处破坏性变更 | 同样的风险，但换来的收益更小 |
| 体积 | 4.5 MB + openai/anthropic/google SDK | 不装 = 省掉 |
| Node 要求 | ≥ 22.19 | 不装 = 无要求 |
| 目录刷新 | 它没有，仍要自己写 | 仍要自己写 |

**所以：pi-ai 从「推荐」降为「备选」**。如果 P0 发现某家（大概率是 Gemini 的兼容层）行为太怪，再考虑只把那一家交给 pi-ai，或抄 DSH 的 300 行。§10 写了判断标准。

### 3.3 四家的真实差异（这是全部工作量）

| 项 | DeepSeek | OpenAI | Gemini（兼容层） | GLM |
|---|---|---|---|---|
| Base URL | `api.deepseek.com` | `api.openai.com/v1` | `.../v1beta/openai/` | `open.bigmodel.cn/api/paas/v4` |
| 视觉 | `deepseek-flash` 支持 | 主流模型支持 | 支持（base64 data URL） | 视模型而定 |
| JSON 模式 | `response_format` 支持 | 支持 | **待实测**（不确定就按 prompt-only） | 支持 |
| 推理参数 | `thinking.type` | `reasoning_effort`；部分模型禁 `temperature` | 兼容层可能忽略 | `thinking.type` |
| max tokens 字段 | `max_tokens` | 推理模型要 `max_completion_tokens` | `max_tokens` | `max_tokens` |
| `/models` | 有 | 有 | 兼容层可能没有 → 用 `x-goog-api-key` 调 `{base}/models`，再不行就 bundled 列表 + 手填 | 有 |
| 缓存计费字段 | `prompt_cache_hit_tokens` | `prompt_tokens_details.cached_tokens` | 无 | 视情况 |
| 并发限制 | — | 按 tier | 按 quota | 有 QPS 限制 |

**统一处理**：能力位说支持才发；400 报「未知参数」→ 自动去掉该参数重试一次（记录降级原因）；`finish_reason === 'length'` 明确提示被截断。

---

## 4. 自动化：模型名与价格

### 4.1 模型名：以厂商 `/models` 为准

- 每个 provider 实现 `listModels()`：`GET {baseUrl}/models`（Bearer；Gemini 用 `x-goog-api-key` 试 native）。
- 启动 30 秒后 + 打开设置页时后台刷新；TTL 24h；失败保留上次成功结果。
- 缓存表 `ai_catalog(provider, model_id, json, etag, fetched_at)`。
- 下拉框可搜索 + **永远允许手填**（Gemini 兼容层、私有部署、`ep-…` 都需要）。
- **语义抄 DSH 的 `listing-cache.ts`**（MIT，约 200 行）：单飞、按凭据分域、后台刷新、失败保留旧值。

### 4.2 价格：三级来源，绝不猜

| 级别 | 来源 | 显示 |
|---|---|---|
| 1 | 厂商响应自报（若兼容层给了 `usage.cost` 或等价字段） | `实际 $x` |
| 2 | models.dev（MIT：`deepseek` / `openai` / `google` / `zhipuai` 都有，**四家全齐，没有手工例外**） | `≈ $x（models.dev 2026-11-18）` |
| 3 | 随包快照（构建时从 models.dev 裁 4 家生成） | 同上 + 标注「离线数据」 |
| — | 都没有 | **`费用未知 · 1234 tokens`**，且 `priced: false` |

- 远程目录整包 6.7 MB，**只留 4 家**入库（约 30 KB），原始包不落盘；TTL 7 天。
- 未知模型**不允许**回落到任何默认价（修掉 `client.ts:29` 的 bug）。
- 预算：有价按金额；本月出现未定价调用时，降级成 **token 上限**并在设置页显示「另有 N 次调用未定价」。

### 4.3 「一年不更新」会怎样

| 事件 | 用户看到 | 要发版吗 |
|---|---|---|
| 上架新模型 | 目录里出现，或手填可用 | 否 |
| 下线旧模型 | 目录消失；旧配置报「可能已下线，请重选」 | 否 |
| 调价 | 新价 + 日期；按新价估算 | 否 |
| 模型改名 | 报「模型不存在」+ 自动匹配建议 | 否 |
| models.dev 挂了 | 用快照，标注可能过期 | 否 |
| **要加第 5 家厂商** | — | **是**（这是唯一需要发版的情况） |

---

## 5. Key 与配置

- `secrets.bin`（单 Key）→ `secrets.v2.json`，整份 JSON 用 `safeStorage.encryptString`：

```jsonc
{ "providers": { "deepseek": "sk-...", "openai": "sk-..." } }
```

- 迁移：旧 `secrets.bin` → `providers.deepseek`，旧文件保留到用户点「清除全部」。
- 写入用「临时文件 + rename」保证原子（并发保存不会写坏）。

`settings.json`：

```jsonc
{
  "ai": {
    "default": { "provider": "deepseek", "model": "deepseek-flash" },
    "vision":  { "provider": "deepseek", "model": "deepseek-flash" },
    "showCost": true
  }
}
```

`Settings.merge()`（`settings.ts:22`）是浅合并，**必须给 `ai` 补深合并**，否则老配置一升级就丢字段。

---

## 6. 界面

设置页改成 4 张供应商卡片 + 一个角色区：

1. 每张卡片：名称 / Key 状态（未配置·已配置·验证失败）/ 模型数 / 「配置」
2. 展开：Key（`type=password`，只回显"已保存"）、Base URL（「高级」折叠）、模型（可搜索下拉 + 手填 + 「刷新目录」）、「保存并测试」（显示延迟与模型回显）
3. 角色：`默认模型` / `图片识别单独指定`（默认跟随）
4. 目录与价格：每个 provider 一行「模型 12 个 · 2 小时前更新」「价格：models.dev · 3 天前」
5. 费用：本月 `≈$X` + 未定价调用数 + 「价格不是账单」一行说明
6. 能力提示：图片导入可用/不可用（不可用时给一句人话）

---

## 7. 数据与接口变更

| 变更 | 说明 | 兼容 |
|---|---|---|
| `secrets.v2.json` | 多 Key | 旧文件自动迁移 |
| `settings.ai` | 角色 + provider 覆盖 + `showCost` | 缺省按 DeepSeek 旧值补全 |
| `ai_usage.provider` | 新列，默认 `'deepseek'`；增 `cost_source`（`provider`/`catalog`/`snapshot`/`none`）与 `priced_at` | `ADD COLUMN` |
| `ai_cache.provider` + 新唯一索引 | 旧索引先 drop 再建 | 回填 `'deepseek'` |
| 新表 `ai_catalog` | 运行时模型目录缓存 | 新增 |
| 新表 `ai_pricing` | 4 家的过滤后价格 | 新增 |
| IPC | `ai:catalog(provider, force)`、`ai:pricing(force)`、`ai:test(provider)`、`settings:setApiKey(provider, key)` | 旧签名保留为默认 provider |

---

## 8. 分阶段实施

### P0 骨架 + 行为不变（0.5 天）

- 建 `providers.ts` / `transport.ts`，先只接 DeepSeek；`chat()` 走新链路。
- `ai_usage` / `ai_cache` 加 `provider` 列与迁移；`secrets.v2` 迁移。
- **验收**：不配任何新东西，现有用户行为完全一致；`npm test` 全绿；OCR 与判分真机各跑一次。

### P1 四家 + 设置页（1.5 天）

- 接 OpenAI / Gemini / GLM；能力位与降级重试；`settings.ai` 深合并。
- 设置页 4 张卡片 + 角色区 + 「保存并测试」；**未验证的 provider 带徽标**（见 §9.1）。
- **验收**：DeepSeek（和 GLM，如果能申请到免费额度）真实测试通过、OCR 与判分走通；OpenAI / Gemini 用**录制夹具**跑通请求构造与响应解析，UI 标「未验证」；某家 401 只让那张卡片变红。

### P2 目录与价格自动化（1 天）

- `catalog.ts`（抄 DSH 语义）+ `pricing.ts`（快照 + 远程 + 未知）+ 构建期 `scripts/gen-pricing.mjs`。
- **验收**：断网启动用快照并标注日期；`/models` 指向坏地址保留旧列表；不在目录里的模型显示「费用未知」。

### P3 打磨（0.5~1 天）

- 错误中文化（不出现「DeepSeek 余额不足」除非 provider 是 DeepSeek）；按供应商用量分布；诊断面板；`ai-smoke.mjs`。
- **验收**：统计页能看出钱花在哪家；未知模型不显示错金额。

---

## 9. 测试计划

**单元测试**（`tests/providers.test.ts`）：
- 4 家的 `buildRequest`：快照（含/不含 `thinking`、`max_tokens` 字段名、`image_url` 有无 `detail`）。
- 响应解析：DeepSeek / OpenAI / 无缓存字段 三种 usage。
- 错误归一化：401/402/429/400 未知参数/网络超时 → 中文文案与是否可重试。
- 降级：400 → 去参数重发成功；两次都 400 → 抛错且只重试一次。
- 价格：有目录 → 估算；无 → `priced:false` 且 `costUsd===0`。
- 聚合：4 家各自的 `listModels` 解析（OpenAI `data[]`、Gemini `models[]`）。

### 9.1 没有 Key 的 OpenAI / Gemini 怎么验收（2026-11-18 现实约束）

你拿不到 OpenAI / Gemini 的 Key（没 VPN、没虚拟信用卡），这**不是不能做**，但要把"没验证"变成产品里可见、可诊断、可修的东西，而不是赌它没问题。

| 手段 | 具体做法 |
|---|---|
| **共享代码路径** | 4 家都走同一个 `transport.ts`（OpenAI 兼容），差异只在 `providers.ts` 的几行 compat。**DeepSeek 跑通 = 传输层跑通**，剩下的是参数/字段差异，不是架构差异 |
| **录制夹具** | 用官方文档的请求/响应样例做 fixture（`tests/fixtures/openai-*.json`、`gemini-*.json`），覆盖正常返回、`usage` 缺失、`finish_reason=length`、400 未知参数、401、429。**断网也能跑**，能抓住"字段名写错"这类 bug |
| **UI 徽标** | OpenAI / Gemini 卡片标「**未验证**」，测试按钮旁写「作者无该地区账号，如报错请贴诊断日志」 |
| **一键诊断** | 测试失败时把**脱敏后的请求摘要**（URL、模型、状态码、响应体前 500 字）写到 `userData/diagnostics/ai-<时间>.log`，并提供「复制诊断信息」 |
| **错误给下一步** | 401 → Key 无效；403 → 可能是地区限制，需要代理；404 → base URL 或模型名不对；429 → 稍后重试。每条都告诉用户该改什么 |
| **README 状态表** | DeepSeek「已验证」、GLM「已验证/未验证」、OpenAI / Gemini「未验证（社区反馈）」；发布说明同步更新 |
| **修复不用发版** | base URL 与模型名在设置页可编辑，目录可刷新——"用户报错 → 你改配置就能修"的周期最短 |

**仍然无法覆盖的**：Gemini 兼容层是否真接受 `image_url` 的 base64、`/models` 是否可用、JSON 模式行为。这三条只能等真实用户反馈；所以**能力位可降级**必须做扎实——不确定就不发那个参数，让功能降级，而不是整个调用失败。

**冒烟脚本**（`scripts/ai-smoke.mjs`）：4 个调用点 × 4 家，输出「通过/失败/耗时/token/价格来源」表；没有 Key 的家自动跳过并标 `SKIP（无 Key）`。这是以后加第 5 家的自检入口。

**真机**：打包后的安装包，在一台只配了某一家 Key 的机器上走完「导入图片 → 入库 → 复习判分」。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 自己写 4 家的参数差异 | 某家 400 | 能力位 + 声明式 compat + 400 自动降级；冒烟脚本覆盖 |
| **Gemini 兼容层行为不齐**（JSON 模式、`/models`） | 两个功能在 Gemini 上降级 | 能力位标 `prompt-only`；目录拉不到就用 bundled 列表 + 手填；在 P1 实测后写死结论 |
| OpenAI 推理模型禁 `temperature` / 要 `max_completion_tokens` | 400 或行为异常 | 由 compat 决定，不按模型名猜 |
| 模型名/价格漂移 | 误导 | §4 的三级价格 + `/models`；未知即「未知」 |
| 以后要加国内厂商 | 半天/家 | 声明式表 + 冒烟脚本；**不要**为了"以后可能"现在就装 pi-ai |
| Key 泄露 | 用户损失 | DPAPI；日志打码；同步白名单排除 |
| 不再有 pi-ai 的 vendor 适配红利 | 新模型特性（如结构化输出）要自己跟 | 只跟 4 家，成本可控；真扛不住再按 §10 的退路 |

**什么时候该回头考虑 pi-ai**：出现下列任一情况——① Gemini 兼容层连续两个功能无法用 300 行以内解决；② 需要接第 5、6 家；③ 需要流式输出或工具调用。届时按调研 §1.5 的方式接入，不动业务层。

---

## 11. 已定 / 待定

| 项 | 状态 |
|---|---|
| 供应商范围 | **已定**：DeepSeek / OpenAI / Gemini / GLM（+ 可选自定义） |
| 是否装 pi-ai | **已定**：不装（4 家时收益不抵风险） |
| 模型名/价格自动刷新 | **已定**：做（这是"一年不更新"的前提） |
| 视觉单独指定 | 建议做（成本很低） |
| 是否显示金额 | 建议显示（`≈` + 日期），可关 |
| 自定义端点 | **已定：本版不做**（用的人少；以后加 = 多一个输入框 + 一个 `custom` 表项） |

---

## 12. 明确不做

- 不做 Claude / Anthropic 协议。
- 不做 Gemini native 协议（兼容层够用）。
- 不做通义 / 豆包 / Kimi / 文心 / 混元（用户群体用不到；以后按 §1 的方式加）。
- 不做自定义端点（Ollama / 代理）——本版不做，接口留好。
- 不做多模型自动比价、投票。
- 不做远程下发行为配置（只下发模型目录/价格）。
- 不做 7 角色路由矩阵（只有 default / vision）。

---

## 13. 实现记录

### 2026-11-18　P0 第一块：供应商表 + 传输层

- 新增 `src/main/ai/providers.ts`：四家的声明式描述（端点、`max_tokens` 字段、JSON 模式、推理参数写法、视觉、缓存计费字段）。**没有任何 `if (provider === ...)`**。
- 新增 `src/main/ai/transport.ts`：`buildChatBody` / `parseChatResponse` / `normalizeHttpError` / `requestChat`。把「HTTP 200 里带业务错误」「400 未知参数可降级」「429/5xx 可重试」都收在这里。
- 新增 `tests/providers.test.ts`（14 个断言）。**注意**：本机沙箱内 vitest 起不来（esbuild 需要 spawn 命名管道，被拦），所以本轮用「tsc 编译成 JS + 普通 node 断言」跑了一遍，14/14 通过；`npx tsc --noEmit` 也通过。`npm test` 需要在你本机（沙箱外）再跑一次确认。
- **尚未接线**：`client.ts` 还是旧实现，行为完全没变。下一步才把它切到 transport，并给 `ai_cache` / `ai_usage` 加 `provider` 列。
- **下一步的具体步骤见 [HANDOFF.md](HANDOFF.md) §5**（改哪 4 个文件、验收命令、真机四项）。

### 2026-11-18　P0 第二块：client 接到 transport + 缓存/用量加 provider 维度

**行为与之前一致**：仍然只走 DeepSeek，`settings.model` / `settings.baseUrl` 照旧、重试策略照旧（401/402 不重试，其余重试 2 次）。

改了 4 个文件：

| 文件 | 改动 |
|---|---|
| `src/main/db/schema.ts` | `ai_cache` / `ai_usage` 各加 `provider TEXT NOT NULL DEFAULT 'deepseek'`（新建库直接带上） |
| `src/main/db/connection.ts` | 新增 `addColumnIfMissing()`：先 `PRAGMA table_info` 判断，缺列才 `ALTER TABLE ... ADD COLUMN`；老库的已有行由 DEFAULT 自动回填 `deepseek`；重复打开不会重复加列 |
| `src/main/db/ai.ts` | `getAiCache(provider, kind, key)` / `setAiCache(provider, kind, key, model, response)` / `logAiUsage({ provider, ... })`；`monthAiCost()` 不变（仍把各家加总） |
| `src/main/ai/client.ts` | 删掉本地 `AiError`（改为 `export { AiError } from './transport'`）；`requestOnce` 用 `PROVIDERS.deepseek` + `requestChat()`；价格表改成 `PRICES[provider][model]`；`logAiUsage` 带 `provider: spec.id`；`testApiKey` 也走 `requestChat`（`回复 ok`、maxTokens 8、20s 超时） |

**两个有意的取舍（都写进了代码注释）**

1. **唯一键仍是 `(kind, cache_key)`**，`(provider, kind, cache_key)` 留给 P1——P0 不重建表。副作用：不同 provider 写同一个 key 会互相覆盖；P0 只有 DeepSeek，碰不到。但读已经按 provider 过滤，P1 换唯一键时只需改索引。
2. **未知模型仍回落 `deepseek-flash` 的价格**（`client.ts` 的 `DEFAULT_MODEL`），P2 才改成「费用未知、`priced:false`」。这是为了 P0 行为完全不变；PLAN-NEXT §7 的第 8 条 bug 仍未修。

新增两个测试文件（都**不联网**，用 stub fetch / 临时库）：

- `tests/ai-db.test.ts`（5 项）：新库带列、缓存按 provider 分区（`getAiCache('openai', ...)` 取不到 DeepSeek 的答案）、用量入库 + 月度汇总、**老库迁移回填**（先用旧 DDL 建库写数据，再 `openDb`，验证列出现且旧行为 `deepseek`）、重复打开不重复加列。
- `tests/ai-client.test.ts`（6 项）：请求体是 DeepSeek 形状（`max_tokens` / `thinking:{type:'disabled'}` / `response_format` / 地址与 `Authorization`）、用量与价格（60 miss + 40 hit + 20 out ≈ $0.00002112）、`cacheKey` 命中不发第二次请求、401/402 只请求一次、500 重试一次后成功、`testApiKey` 成功/401 两条路径。

**验证结果（2026-11-18）**

- `npx tsc --noEmit -p tsconfig.json` → **0 错误**。
- `npx vitest run` → **6 个文件 64 项全绿**（providers 15 / core 25 / drafts 10 / ai-client 6 / ai-db 5 / phonetic 3）。
  - 注意：DSH 沙箱内 `npm test` 仍会 `spawn EPERM`（esbuild 要 spawn 子进程），必须在沙箱外的普通 PowerShell 里跑；本轮就是这样跑通的。
- **真机（DeepSeek 真 Key，本机 `.data` 旧库升级）**：先用 `electron . --no-sandbox` 把应用正常启动了一次，`app-start` 与托盘检查都正常，说明迁移在真实 1.3 MB 库上没炸；再在 Electron 主进程里用应用自己的 `safeStorage` 解密 Key 跑 4 项（脚本是一次性的，没进仓库，Key 从未落盘）：

| 验收项 | 结果 |
|---|---|
| ① 设置页「保存并测试」 | `{ok:true, message:'连接成功，Key 可用', model:'deepseek-flash'}` |
| ② 导入结构化 | `structurize()` 真实请求返回 2 条：`abandon` / `ability`，释义正确 |
| ③ 复习判分 | 真实卡片 `assess`（en2zh）走 AI：`source:'ai'`，`correct:false`，理由「答非所问」（给的是无关答案，符合预期） |
| ④ 本月 AI 费用 | `monthAiCost()` 由 `$0.088203` → `$0.088385`（calls 314 → 316），不是 0 |

- **真实库迁移后**：`ai_cache` 310 行、`ai_usage` 314 行全部回填 `provider='deepseek'`；`notes/items/cards/reviews` 仍是 17 / 289 / 624 / 975，没有丢数据。当天早些时候 `dailyBackup()` 已经留了 `wordmemo-2026-11-18.db`，相当于迁移前备份（HANDOFF §8 坑 1 的通用修法仍未做）。
- GUI 里的四个页面没有逐个点击（等价性：IPC 处理器调的就是上面这些函数）；如需补一次纯点击验证，按 HANDOFF §5.2 走。

**下一步**：P1（接 OpenAI / Gemini / GLM + 设置页四张卡片 + `settings.ai` 深合并 + `secrets.v2` 多 Key），步骤见 [HANDOFF.md](HANDOFF.md) §5 与本文 §8 P1、§9.1。

### 2026-11-18　P1：四家供应商 + 设置页四张卡片

**范围**：只动 P1 必需的 9 个源文件（`shared/types`、`ai/providers`、`settings`、`ai/client`、`ai/import`、`ipc`、`preload`、`SettingsPage`、测试），没有顺手改别的模块。

**配置与 Key**

| 项 | 实现 |
|---|---|
| `Settings.ai` | `{ default: {provider, model?}, vision: {provider, model?} \| null, showCost, providers: { [id]: {baseUrl?, model?} } }`；`Settings.merge()` 里给 `ai` 补了深合并（`mergeAi()`），`vision` 的 `null` 与"缺省"分开处理 |
| 老配置兼容 | 顶层 `model` / `baseUrl` 保留不动，DeepSeek 的模型与端点仍回落到它们——**不需要迁移 settings.json** |
| Key 存储 | `secrets.bin`（单 Key）→ `secrets.v2.json`（`{version:2, providers:{...}}`，整份用 `safeStorage.encryptString`；临时文件 + `rename` 原子替换），旧的 `secrets.bin` 在首次读 Key 时自动迁移成 `providers.deepseek`，旧文件保留到用户点「清除全部」 |
| `apiKeySet` | 语义改成「**默认角色那家**有没有 Key」，所以 `App.tsx` / `Notes.tsx` / `ImportPage.tsx` 里已有的禁用逻辑不用改 |

**路由与降级**

- `client.ts`：`resolveTarget(role)` → `{ spec, baseUrl, model }`；`role = 'default' | 'vision'`，vision 为 `null` 时跟随默认。`ocrImage()` 传 `role: 'vision'`（`import.ts` 只改了 1 行 + 一句文案）。
- 每家按自己的 Key 取用（`getApiKey(spec.id)`）；没 Key、没填模型分别给不同的可读错误，且都不发请求。
- **400 未知参数 → 去掉被点名的参数重试一次**：`thinking`（改 compat，不再发这个字段）、`response_format`、`temperature`、`image_url.detail`；两次都 400 才抛错。400 不再走外层重试（重试同一个坏请求没意义）。
- 价格：`PRICES[provider][model]`，P1 只有 DeepSeek 有内置价；**其他家按 0 记**（不是错价，是不计价，P2 接 models.dev）。
- 设置页的 `aiProviderInfo()` 只回 `{id,label,baseUrl,model,keySet,vision,unverified}`，**不含 Key**；`unverified` 来自 `providers.ts`（deepseek `false`，其余三家 `true`，等真机跑通再改，见 §9.1）。

**设置页**：四张供应商卡片（名称 / 未验证徽标 / Key 状态 / 当前模型 / 「配置」展开：Key、模型、Base URL、「保存并测试」带延迟与模型回显、清除）+「AI 角色与预算」面板（默认模型、图片识别单独指定、每月预算、AI 校验、AI 判分、显示费用）。

**验证（2026-11-18）**

- `npx tsc --noEmit` → **0 错误**。
- `npx vitest run` → **8 个文件 80 项全绿**（providers 15 / core 25 / ai-client 13 / drafts 10 / ai-db 5 / settings-secrets 5 / settings-ai 4 / phonetic 3）。新增覆盖：默认角色切 GLM 的端点与模型、vision 独立路由、没填模型不发请求、400 降级只重试一次、401/402 不重试、旧 `secrets.bin` 迁移与多 Key 并存、`ai` 深合并与 `apiKeySet` 跟随。
- **真机（本机 `.data` 真库 + 真 DeepSeek Key）**：

| 验收项 | 结果 |
|---|---|
| 旧 Key 迁移 | `secrets.v2.json` 生成，`secrets.bin` 仍在；解出的 Key 长度 35（DPAPI 正常） |
| 四家状态 | deepseek `keySet:true / unverified:false`，其余 `keySet:false / unverified:true` |
| 「保存并测试」DeepSeek | `ok:true`「连接成功，Key 可用」，**827 ms** |
| 未配置家的测试 | GLM → 「还没有填写 API Key」，不报错不崩 |
| 默认角色真实调用 | 走旧 `settings.model` 回落路径，真实返回 |
| 应用启动 | `app-start` + 托盘检查正常（迁移后的真实 1.3 MB 库） |
| 设置页渲染 | 隐藏窗口里加载构建产物、点进「设置」：四张卡片 + 角色区 + 「未验证」/「已配置」徽标都在，**console 无错误** |

**留下的欠账（P2 / P3）**：`ai_cache` 唯一键仍是 `(kind, cache_key)`；非 DeepSeek 家不记金额；`ai_usage` 缺 `cost_source` / `priced_at`；模型仍手填（P2 接 `/models`）；`App.tsx:287` 与 `db/importDrafts.ts:338` 的「DeepSeek API Key」文案还没改（P3 统一中文化）；README 的供应商状态表还没加。

### 2026-11-18　P2：模型目录 + 价格自动化

**数据层**

| 变更 | 说明 |
|---|---|
| 新表 `ai_catalog(provider, model_id, payload, fetched_at)` | `/models` 的缓存，按家整表替换（一个事务） |
| 新表 `ai_pricing(provider, payload, fetched_at)` | models.dev 的 4 家子集，每行一家 |
| `ai_usage` + `cost_source` / `priced_at` | `provider`/`catalog`/`snapshot`/`none`；金额为 0 且 `none` 时不混进金额统计 |
| `ai_cache` 唯一键 → `(provider, kind, cache_key)` | SQLite 改不了建表约束，`migrateAiCacheUnique()` 在事务里重建表并搬数据；**失败就保持原样继续跑**（纯缓存，串一次比启动失败好） |

**新模块**

- `src/main/ai/catalog.ts`：`/models` + TTL 24h + 并发单飞 + 失败保留上次成功列表。OpenAI 形状 `{data:[{id}]}`；Gemini 形状 `{models:[{name}]}`（去 `models/` 前缀、只留 `generateContent`），Gemini 打 native 端点并带 `x-goog-api-key`，其余走 Bearer。
- `src/main/ai/pricing.ts` + `scripts/gen-pricing.mjs` + `pricing-snapshot.json`（**15.9 KB / 110 个模型**，日期 2026-11-18）：三级来源「远程目录 → 随包快照 → 未知」。**未知一律 `priced:false`、金额 0、只统计 token**，修掉了 PLAN-NEXT §7 第 8 条的「按 DeepSeek 价算别家」。
- `src/main/ai/info.ts`：设置页的只读视图（单独放一个文件，避开 catalog ↔ client 的循环依赖）。
- 启动 30 秒后后台刷新目录与价格（两者都有 TTL，不是每次启动都联网）。

**预算**：`overBudget()` 有价按金额；这个月一旦出现未定价调用，就同时按 token 上限兜底（`$1 ≈ 200 万 token` 的粗估，宁早勿晚）。

**设置页**：模型输入改成 datalist（可搜索 + **永远可以手填**）、每家「刷新目录」+「目录 N 个 · x 前」+ 单模型价格行；面板头一行「价格：models.dev · 日期 · 本月 ≈$x · N 次调用（另有 M 次未定价）」+「刷新价格」。

**验证（2026-11-18）**

- `npx tsc --noEmit` → **0 错误**；`npx vitest run` → **10 个文件 94 项全绿**（新增 `ai-pricing` 12 项、`ai-cache-key` 2 项）。
- 真机（真 Key + 真库）：

| 项 | 结果 |
|---|---|
| 缓存键迁移 | 真实库 `ai_cache` 已是 `(provider, kind, cache_key)` |
| 真实 `/models` | DeepSeek 返回 2 个模型（`deepseek-flash`、`deepseek-v4-pro`），写进 `ai_catalog` |
| 真实 models.dev | 下载一次 → 110 个模型入库；价格来源从 `snapshot` 变 `catalog`，数值一致（0.15/0.6/0.003） |
| 真实调用 | 新行 `cost_source=catalog`、`priced_at=2026-11-18`、金额 $0.0000027 |
| 设置页 | 价格行 / 刷新价格 / 四张卡片都渲染正常，console 无错误 |
| 启动 | 独立数据目录启动 `app-start` 正常；新库的表与新约束齐全 |

本轮真机只花了约 **$0.0000027**（一次 8 token 的调用；模型目录与价格目录都是免费接口）。

**P2 的欠账**：models.dev 的 `tiers`（按上下文长度分段计价）没接，长上下文会低估；「厂商响应自报价格」只是枚举位，4 家目前都没给。

### 2026-11-18　P3：打磨（多供应商收尾）

| 项 | 改动 |
|---|---|
| 错误文案 | `App.tsx` / `importDrafts.ts` 里的「DeepSeek API Key」→「API Key（默认模型那家）」；不会再对着 GLM 用户说 DeepSeek |
| 按供应商统计 | `DashboardStats` 加 `aiByProvider`（provider / label / calls / cost）与 `aiUnpricedCalls`；统计页「词库概况」里按家列出「N 次 · $x」，并提示「另有 M 次调用没有价格」 |
| 一键诊断 | 设置页测试失败时出现「复制诊断信息」：provider / baseUrl / model / ok / message / latency / 时间，**不含 Key**，可以直接贴出来 |
| 冒烟脚本 | `npm run ai-smoke` → `scripts/ai-smoke.mjs` → `electron . --ai-smoke` → `src/main/ai/smoke.ts`：4 个调用点（结构化/校验/判分/音标）× 4 家，没有 Key 的家输出 `SKIP（无 Key）`，有失败时退出码非 0 |
| README | 新增「AI 供应商与验证状态」表（DeepSeek 已验证 / GLM 待验证 / OpenAI·Gemini 未验证）、首次配置改成四家、写明 `npm run ai-smoke` 与「价格不是账单」 |

**验证（2026-11-18）**

- `npx tsc --noEmit` → **0 错误**；`npx vitest run` → **10 个文件 95 项全绿**。
- 真机 `npm run ai-smoke`（隔离数据目录 + 真实 Key）：

```
DeepSeek    结构化    通过    748ms   {"items":[{"headword":"abandon",...}]}
DeepSeek    校验      通过    596ms   {"issues":[]}
DeepSeek    判分      通过    942ms   {"relation":"same","confidence":0.95,...}
DeepSeek    音标      通过    933ms   {"items":[{"index":1,"us":"/əˈbændən/",...}]}
OpenAI / Gemini / 智谱 GLM   SKIP（无 Key）
合计：4 次调用，失败 0 次；跳过 3 家（没有 Key）。
```

- 界面：设置页四张卡片 + 价格行照常；统计页出现「DeepSeek N 次 · $x」的按家拆分行；console 无错误。

**踩到的坑（写下来给以后）**：把数据目录复制出来跑冒烟时，必须**连 `Local State` 一起复制**——Electron 的 `safeStorage` 密钥存在 `userData/Local State` 里（DPAPI 保护），只复制 `secrets.v2.json` 会解不开 Key（`isEncryptionAvailable()` 仍为 true，但 `getApiKey()` 返回 null）。

### 2026-11-18　UI 打磨：设置页分区 + 灰字清理 + 去掉「显示费用」开关

起因是用户的三点反馈：设置页边框对不齐、很多小字是写给维护者看的、`显示 AI 费用估算` 勾了没用。

| 问题 | 结论与修法 |
|---|---|
| `showCost` 勾选无效 | **是漏写**：这个字段只存不读。用户决定**不做开关**——金额始终显示，但明确标注「估算，可能和账单有出入」。字段从 `AiSettings` / `DEFAULT_SETTINGS.ai` / 深合并里删掉，设置页那个 Toggle 也删了 |
| 设置页边框错位 | 改成**左侧分区导航**（6 区）：AI 供应商 / AI 角色与预算 / 复习节奏 / 提醒 / 发音源 / **高级与诊断**（数据 + 后台退出 + 构建/权限/托盘折进「诊断信息」）。右栏一次只显示一节，`draft` 共享，切区不丢未保存修改（左侧当前项有点标） |
| 小字是写给维护者的 | 删 3 条（Anki learn ahead 解释、「DeepSeek 已真机验证…不用等发版」、音标那段长解释改为一句）；改写 9 条（Key 说明、目录行、视觉能力、发音源、后台运行、导入页两处、笔记页去重键、统计页 SQLite）；把构建/权限/托盘/重启说明挪进折叠的「诊断信息」。规则写进 HANDOFF §10 |

改动文件：`SettingsPage.tsx`（分区 + 文案）、`styles.css`（约 45 行分区样式）、`StatsPage.tsx`（估算说明、按家金额）、`Notes.tsx` / `ImportPage.tsx`（文案）、`shared/types.ts` + `settings.ts`（删 `showCost`）、两个测试文件（同步删断言）。

**验证**：typecheck 0；`npm test` 10 文件 95 项全绿；离屏截图逐个分区检查（6 个分区都只有对应面板可见、左栏 active 正确、无 console 错误），统计页/导入页文案已更新。

> 截图验收的坑：离屏窗口默认会被 throttle，`capturePage()` 会返回**上一帧**，CSS transition 还会卡在中间态（看起来像两个分项同时高亮）。修法是 `webPreferences.backgroundThrottling: false` + 用 CDP `Page.captureScreenshot`，别用 `capturePage()`。

### 2026-11-19　模型下拉框（公开名 + 可搜索）

**问题**：`/models` 只回 id（`deepseek-flash`），公开名是 `DeepSeek-V4.1-Flash`；用户不知道该填哪个，手填又容易错。

**数据（已经具备，不用新接口）**

- `ai_catalog` 的 payload 里本来就存了 API 自报的 `name`（DeepSeek 会回 `DeepSeek-V4.1-Flash`，Gemini 回 `displayName`）；
- OpenAI / GLM 的 `/models` 只有 id → 用 models.dev 的 `name` 补；这次让 `refreshPricing()` 把 `name` 也存进 `ai_pricing`（以前丢掉了），随包快照本来就有；
- 合并优先级：**API 自报 → models.dev → id**，不硬编码任何名字映射。

**交互**

- `components/ModelPicker.tsx`：可搜索下拉，输入框本身就是值（**永远允许手填**，代理/新模型不受影响）；
- 每行两行式：公开名（主）/ `id`（等宽小字）/ 右侧价格（`≈$x/M 入 · $y/M 出` 或「费用未知」）；
- 搜索同时匹配公开名与 id；↑↓ / Enter / Esc；点击外部关闭；当前值不在目录里时提示「可以直接手填」；
- 打开时高亮停在当前值上，避免手滑按 Enter 换模型。

**边界（按用户要求）**

- 候选**只来自 `/models`**：没 Key / 没拉过目录就是空列表，**不拿内置快照冒充**——免得用户选了一个其实调不了的模型；
- 卡片标题与角色下拉都显示公开名（拿不到就退回 id）；
- models.dev 只用于补名字和价格，不参与"能不能用"的判断。

**验证**：typecheck 0；`npm test` **11 文件 101 项全绿**（新增 `ai-models` 6 项：API 名优先 / models.dev 回退 / 目录外模型费用未知 / 目录空则空列表 / 远程名字覆盖快照 / 刷新保留 name）；离屏截图确认下拉展开、搜索 `v4` 过滤、两行式条目不折行、console 无错误。

### 2026-11-19　GLM 真机验证 + 「强制思考」模型兼容

用户填了 GLM 的 Key，按约定跑 `npm run ai-smoke`，**发现一个真 bug**：

```
智谱 GLM 拒绝了这次请求：该模型始终思考，不支持关闭思考；请使用 low、high 或 max。
```

- 原因 1：GLM 新的 `glm-5.x-flash` **始终思考**，拒绝 `thinking: {type:'disabled'}`；
- 原因 2：报错是**中文**，而 `normalizeHttpError` 的 `unknownParam` 只认英文、`degradeParam` 也只匹配 `thinking|reasoning` → 降级没触发；
- 原因 3：「保存并测试」只发 `max_tokens: 8`，强制思考模型会把 8 个 token 全花在推理上 → 返回空内容。

**实测**（直接打 GLM 接口，`glm-5.3-flash`）：

| 请求 | 结果 |
|---|---|
| 不带 `thinking`，max_tokens 200 | 200，`ok`，completion 74（其中思考 70） |
| `thinking: {type:'low'}` | **400**（仍然「不支持关闭思考」） |
| 不带 `thinking`，max_tokens 2000 | 200，`ok`，completion 57 |

**修法**

1. `providers.ts` 的 `ReasoningCompat` 加 `whenOff: 'disabled' | 'omit'`，**GLM 用 `omit`**：不需要思考时干脆不发这个字段（老模型默认不思考、新模型默认思考，两条路都不报错）。DeepSeek 保持 `disabled`。
2. `normalizeHttpError` 的「未知参数」判定加中文（不支持 / 未知参数 / 无效参数）；`degradeParam` 的 thinking 判定加「思考 / 推理」。
3. 通用学习降级：某个 `provider:model` 一旦因为 thinking 被拒，本次会话不再发该字段（`omitThinkingFor` 集合），避免每次调用都先 400 一次；「保存并测试」也走这条逻辑。
4. 「保存并测试」的 max_tokens 8 → **256**（普通模型仍然只回两三个 token，强制思考模型才有机会吐出内容）。

**验证**

- `npm test` **11 文件 106 项全绿**（新增：GLM 默认不发 thinking、中文 400 也算 unknownParam、学习降级后不再发 thinking、测试按钮自动重试）。
- 真机 `npm run ai-smoke`（DeepSeek + GLM，各 4 个调用点）：

```
DeepSeek  结构化 1443ms / 校验 817ms / 判分 959ms  / 音标 1132ms   全通过
智谱 GLM  结构化 2976ms / 校验 3047ms / 判分 21880ms / 音标 2159ms 全通过
OpenAI / Gemini  SKIP（无 Key）
合计：8 次调用，失败 0 次
```

- GLM 的 `unverified` 置为 `false`，README 状态表改成「已验证」。
- **已知体验问题**：`glm-5.x-flash` 判分要约 22 秒（强制思考），用户如果嫌慢，可以在设置里换成 `glm-4.6` 这类非强制思考的模型——这也是模型下拉框要显示公开名的原因之一。
