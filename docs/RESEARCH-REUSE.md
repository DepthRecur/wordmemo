# 开源复用调研：四个功能都能借什么

> 调研时间：2026-11-17 ~ 11-18　方法：GitHub API 读仓库元数据 + 读源码目录/文件 + 官方文档
> 证据分级：**实读** = 本次真的读到了 API 返回或文件内容；**转述** = 由子调研读取、未二次核对；**未核实** = 明确没查清
> 写这份文档时 GitHub 匿名 API 已触发限流（60 次/小时），下面标「实读」的许可证与版本号是我在限流前/通过 npm registry、jsDelivr 读到的。

---

## 0. 结论速查

| 功能 | 用什么 | 许可证 | 复用方式 | 一行结论 |
|---|---|---|---|---|
| 多供应商 | 4 家自写薄适配（声明式表照 [Cline](https://github.com/cline/cline) 抄字段）；[pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) 留作「以后扩厂商」的备选；[models.dev](https://github.com/anomalyco/models.dev) 供价格 | MIT / Apache-2.0 | 自写而非依赖 | 4 家时依赖的收益不抵风险（0.x、4.5 MB、Node ≥22.19） |
| 自动更新 | `electron-updater` + electron-builder 26 | MIT（**实读** npm 6.8.11） | 直接依赖 | `update-electron-app` 因 Squirrel 格式直接出局 |
| 云端同步 | [age-encryption](https://github.com/FiloSottile/typage)（BSD-3）+ 自己写「事件流 + 重放」 | BSD-3 | 直接依赖加密库 | Obsidian Git **不像**，只借它的触发策略（且它是 MIT） |
| 多个库 | 参考 [Anki](https://github.com/ankitects/anki) 的语义（AGPL，**只读**） | — | 只借语义 | 我们因「全局单词去重」而选了和 Anki 不同的模型 |

**一句话**：四个功能里真正需要「复用」的是——**pi-ai（多供应商传输层）**、**models.dev（价格数据）**、**electron-updater（更新）**、**age（加密）**。其余是「借结构、不借代码」。

> **2026-11-18 追加**：本文最初写「多供应商不加运行时依赖」，在拆开 DeepSeek Harness 的应用包之后改了结论——它自己能接多供应商，靠的是 MIT 的 `@earendil-works/pi-ai`，见 §1.6。那才是该借的「模块」。

---

## 0.5 产品级调研（按「找用到这个功能的产品」的方式）

前面几节偏向「库/数据」。这一节是补做的**产品级**调研：每个功能都去找**真正实现了它的开源应用**，定位到具体模块文件，再判断「能抄 / 只能抄结构 / 只能读 / 可依赖」。

**总账**：

| 功能 | 看过的产品 | 能整段抄的代码 | 结论 |
|---|---|---|---|
| 多供应商 | DSH（MIT）、opencode（MIT）、Cline（Apache-2.0）、Roo-Code（Apache-2.0，已归档）、Continue（Apache-2.0）、crush（FSL，非开源） | 无整包；**Cline 的 `builtins.ts` 结构可抄** | 4 家自写 ~300 行；扩展时再考虑 pi-ai |
| 自动更新 | Rocket.Chat（MIT）、Mattermost（Apache-2.0）、Etcher（Apache-2.0）、MarkText（MIT）、PicGo（MIT）、youtube-music（MIT）、lx-music（Apache-2.0）、VS Code（MIT） | **`updateCheckSchedule.ts`（36 行，MIT，零依赖）** | 其余只抄模式；**默认改成「只探测不代装」** |
| 云端同步 | Obsidian Git（MIT）、Joplin（AGPL）、obsidian-livesync（MIT）、GitJournal（AGPL）、chezmoi（MIT）、Syncthing（MPL-2.0） | **`promiseQueue.ts`（53 行，MIT，零依赖）** | 记录级合并**没有任何先例**，必须自己写 |
| 多个库 | Anki（AGPL）、AnkiDroid（GPL）、qwerty-learner（GPL）、memorex（MIT） | 无 | 自己写约 200 行 UI 状态机；抄 Anki 的 5 条约定 |

> 一句话：**能整段搬的只有两个文件（合计 89 行）**。这不奇怪——产品层的价值在「约定」，不在「代码量」。真正值钱的是下面每条里的「学到什么」。

### 0.5.1 多供应商：三个产品，三种写法

| 产品 | 模块路径 | 许可证 | 参数差异怎么处理 | 能否抄 |
|---|---|---|---|---|
| DeepSeek Harness | `dsh-llm-pi-ai/` + `dsh-llm-deepseek/` | **MIT** | 委托给 pi-ai | 只能读/抄 200 行目录缓存（见 §1.6） |
| [opencode](https://github.com/anomalyco/opencode) | `packages/ai/src/providers/*.ts`（一家一文件）+ `protocols/openai-chat.ts` | **MIT** | 声明式 `compatibility`（如 `maxTokensField: "max_tokens"`） | 不建议：绑它的 `effect` 框架与 `Route/Endpoint` 抽象 |
| [Cline](https://github.com/cline/cline) | `sdk/packages/llms/src/providers/builtins.ts`（约 46 KB）+ `builtin-types.ts` + `catalog/` | **Apache-2.0** | **声明式 spec 表**：`id/name/family/protocol/capabilities/apiKeyEnv/defaults.baseUrl/apiLineBaseUrls(国内/国际双线)/configFields/metadata.routing` | **抄结构**：这是最值得照抄的一张表；包本身 11.3 MB，不适合依赖 |
| Roo-Code | `src/api/providers/deepseek.ts` | Apache-2.0（**已归档**） | 硬编码 `modelId.includes("deepseek-reasoner")` | 反例，别学 |
| Continue | `core/llm/llms/*.ts` + `index.ts` 注册表 | Apache-2.0 | 每类覆写 `_streamChat`，无统一表 | 只读：强耦合它的 `BaseLLM`/`config-yaml` |
| crush | — | **FSL-1.1-MIT（不是 OSI 开源）** | — | **不能抄也不能依赖**（两年内禁止竞品替代） |

**学到什么**：
1. **声明式 > 硬编码 if**：Roo 那种 `modelId.includes(...)` 会在模型改名时静默失效，正是你担心的「模型名写错」。
2. **国内/国际双线 baseURL** 是真实需求（Cline 为每家列了 `china`/`international` 两条线）。
3. **价格与上下文全部来自 models.dev 的生成管线**，三家（Cline/opencode/pi-ai）里只有前两家做了「生成」，pi-ai 是**构建期生成、随包发布，没有运行时刷新**——所以我们自己那层 `/models` + models.dev 刷新不是多余，是补它没有的。

### 0.5.2 自动更新：八款产品，只有 36 行值得抄

| 产品 | 用的是什么 | 关键文件 | 许可证 | 结论 |
|---|---|---|---|---|
| [Rocket.Chat](https://github.com/RocketChat/Rocket.Chat.Electron) | electron-updater 6.x | `src/updates/main.ts`（~1000 行）、**`src/updates/updateCheckSchedule.ts`（36 行）** | **MIT** | 只抄那个纯函数；`main.ts` 绑 Redux |
| [Mattermost](https://github.com/mattermost/desktop) | **已放弃应用内自动更新**，只通知 | `src/main/updateNotifier.ts` | Apache-2.0 | 抄「跳过版本 + 24h 重提醒 + 手动穿透」 |
| [Etcher](https://github.com/balena-io/etcher) | electron-updater 6.1.8 | 内联在 `lib/gui/etcher.ts` | Apache-2.0 | 抄 `while(!done){check; wait 5min}` 结构（不叠加异步） |
| [MarkText](https://github.com/marktext/marktext) | electron-updater ^6.8.12 | `packages/desktop/src/main/menu/actions/marktext.ts` | MIT | 抄 IPC 事件薄胶水；**别抄它下载完就强杀重启**（源码里自己留了 TODO） |
| [PicGo](https://github.com/Molunerfinn/PicGo) | 自研检查 | `src/main/utils/updateChecker.ts` | MIT | 抄「`NO_MORE_NOTICE` 复选框 + 打开发布页」 |
| [youtube-music](https://github.com/th-ch/youtube-music) | electron-updater 当**版本探针** | `src/index.ts` | MIT | 抄「只探测 + 安装交给 GitHub 页面」 |
| [lx-music](https://github.com/lyswhut/lx-music-desktop) | electron-updater 6.8.9（devDep） | `src/renderer/utils/update.js`（内容未核实） | Apache-2.0 | 更新放在渲染进程，参考价值有限 |
| VS Code | **自研 + Inno Setup** | `src/vs/platform/update/electron-main/updateService.win32.ts` | MIT | 不值得：换生态等于重写 |

**学到什么（这条直接改了计划）**：
- **未签名 NSIS 下「静默下载 + 自动安装」是高风险动作**：`electron-updater` 的安装器起不来时**不会报错，还会照常退出**（Rocket.Chat 专门用 `downloadedUpdateHelper.file` + `fs.existsSync` 去补这个洞）；而 MarkText 的强杀重启会把用户没保存的东西一起带走。
- 所以第一版应当：**探测到新版本 → 提示 → 打开 Releases 页让用户自己下**。静默安装降级为「高级选项」，并且必须配 **20 秒退出看门狗** + 安装前 `app.removeAllListeners('window-all-closed')`。
- `updateCheckSchedule.ts` 的细节值得整段抄：24h 间隔、失败退避 1h→2h→4h→6h、**时钟回拨时用 `Math.min` 保证不会永久停摆**。

### 0.5.3 云端同步：六个产品，没有「记录级合并」的先例

| 产品 | 粒度 | 加密 | 冲突策略 | 许可证 | 能抄什么 |
|---|---|---|---|---|---|
| [Obsidian Git](https://github.com/Vinzent03/obsidian-git) | 文件 | 无 | 人工解 git 冲突 | **MIT** | **`src/promiseQueue.ts`（53 行，零依赖）**；`src/automaticsManager.ts` 的「lastAuto 时间戳 + 剩余时间续算」模式；`withGitOperation` 三行状态原语 |
| [Joplin](https://github.com/laurent22/joplin) | item | AES-GCM + PBKDF2，master key 版本化 | 冲突副本 + 「Conflicts」笔记本，**绝不静默丢** | **AGPL（只读）** | 设计：`BaseSyncTarget` 的 `initFileApi/initSynchronizer` 两钩子解耦后端；`serializeForSync`；`syncInfoUtils` 版本协商 |
| [obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync) | chunk（Rabin-Karp） | E2EE，HKDF + 前缀版本化 | 交给 CouchDB revision tree | MIT | 只读：依赖 CouchDB 复制协议，且块 ID 与密钥耦合，抄不了 |
| [GitJournal](https://github.com/GitJournal/GitJournal) | 文件 | 无 | git merge（issue #241 记载可能覆盖对方改动） | AGPL（只读） | 反例：文件级 + 自动 merge 会丢数据 |
| [chezmoi](https://github.com/twpayne/chezmoi) | 文件 | **age 单文件加密**，加密器做成可替换接口 | 无 | **MIT** | 抄「一文件一密文 + `Encryption` 接口 + 明文/密文同后缀约定」的结构（Go→TS 30 行） |
| [Syncthing](https://github.com/syncthing/syncthing) | 文件 | 无 | **冲突副本** `<名>.sync-conflict-<日期>-<时间>-<设备>` | MPL-2.0 | 抄冲突副本的**命名规则**（可排序、可 grep、可批量清理） |

**学到什么**：
1. **「reviews 当事件流、cards 重放」在开源里没有直接先例**。最接近的是 PouchDB 的 `_rev` 版本树和 Joplin 的 revisions（都是快照，不是全局 oplog）。所以它是我们自己要发明的东西——**S0 的 golden test 不是形式主义，是唯一的安全网**。
2. 可抄的三块零件：串行队列（obsidian-git）、时间戳续算（obsidian-git）、冲突副本命名（Syncthing）；加密边界照 chezmoi。
3. Joplin 的「冲突不硬合、落进 Conflicts 笔记本」值得抄成我们的 `conflicts/` 目录 + UI 提示——**永远不静默丢数据**。

### 0.5.4 多个库：MIT/Apache 阵营里根本没有实现

| 产品 | 多库 | 批量选择 | 批量移动 | 许可证 | 结论 |
|---|---|---|---|---|---|
| [Anki](https://github.com/ankitects/anki) | deck 树 | `select_all/invert_selection/clear_selection`、`SELECTION_LIMIT=500`、按 id 恢复选区 | Change Deck；**对话框内建「新建 deck」** | AGPL（只读） | 抄 5 条约定（见下） |
| [AnkiDroid](https://github.com/ankidroid/Anki-Android) | 沿用 Anki | 长按进选择态、`selectRowsBetween(start,end)`、`toggleSelectAllOrNone` | `moveSelectedCardsToDeck` | GPL-3.0 | 抄交互，不抄码 |
| [Joplin](https://github.com/laurent22/joplin) | 笔记本 | `useOnNoteClick`（30 行：ctrl→toggle / shift→extend / 否则单选） | move to notebook | AGPL | 抄这 30 行的分支结构 |
| [qwerty-learner](https://github.com/RealKai42/qwerty-learner) | 静态词库清单 | 无 | 无 | GPL-3.0 | 不同构，无参考价值 |
| memorex | 多个 markdown 目录 | 无 | 无 | **MIT** | 许可合格但功能为零 |

**学到什么（5 条直接写进 PLAN-DECKS）**：
1. 批量动作**只吃 id 列表**（`get_selected_card_ids()` → `set_card_deck(ids, deck)`），UI 与后端零耦合。
2. 选库用**可搜索对话框**，不是拖拽；「移到新库」做成对话框里的一个按钮（Anki 的 `Ctrl+N`，建完直接带着选中项移进去）——这正是「分裂」的完整先例。
3. 选区要**有上限**（Anki 500）并**按 id 恢复**（搜索/排序后不丢选区），失效 id 丢弃。
4. 空选区禁用动作；一次操作**单步撤销**；完成后给一条 `N cards updated` 的反馈。
5. **Anki 没有「批量复制到另一个 deck」**（只有单条 Create Copy）。所以我们的「批量复制」没有先例，必须自己定义清楚语义（我们定：复制笔记、词条与进度共享，见 PLAN-DECKS §6.2）。

---

## 1. 多供应商

### 1.0 怎么判断「一个模块能不能剥下来」（可复用的方法）

你提的思路是对的：**不要只找"专门做这件事的库"，去找"已经做完这件事的产品"，再从里面剥。** 判断能不能剥，按这四步走：

1. **许可证**：读文件，不读印象。`LICENSE` 文件 + 包里 `package.json` 的 `license` 字段，二者都要看（我在 DSH 上就是这么发现它其实是 MIT 的）。
2. **依赖半径**：剥一个包 ≈ 剥它的 `peerDependencies`。DSH 的 `dsh-llm-pi-ai` 表面是一个文件夹，实际挂着 cordis 容器 + 十几个 `dsh-*` 兄弟包，**半径 338 个包** → 不可剥，只能读设计。
3. **接口面**：它暴露的 API 是不是只跟"这件事"有关？`listing-cache.ts` 只依赖 clock/credential/load 三个回调，**半径 0** → 可整段抄。
4. **变更频率**：0.x 且一年几十个破坏性变更的包，不适合直接依赖；适合"抄一次、锁死"。

> 这四步的结论直接决定"依赖它"还是"抄它"还是"只读它"。

### 1.1 可复用的项目

| 项目 | 许可证 | star（转述） | 相关度 | 能借什么 | 不能用的原因 |
|---|---|---|---|---|---|
| [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) | **MIT**（npm `license` 实读） | — | **最高** | 统一 LLM API：provider 注册、各家 `compat`/`thinkingFormat`、视觉、`usage.cost.totalFromProvider`、`CredentialStore`、`fetchModels` + `models.refresh()`；子路径导入可按 provider 裁剪 | 0.x 破坏性变更密集；解包 4.5 MB；要求 Node ≥22.19 |
| `@deepseek-ai/dsh-llm`（DSH 应用包内） | **MIT**（LICENSE 实读：Copyright (c) 2026 DeepSeek） | — | 高 | 与厂商无关的 LLM 接口、错误类型、重试 | cordis DI 插件，不能单独运行 |
| `@deepseek-ai/dsh-llm-pi-ai`（同上） | MIT | — | 高 | `catalog.ts` / `discovery.ts`：分协议探测 `/models` 的规则 | 依赖 338 个兄弟包，剥不动 |
| `@deepseek-ai/dsh-llm-deepseek`（同上） | MIT | — | 高 | **`listing-cache.ts`（单飞 + 后台刷新 + last-known-good）**、`listing.ts`（解析 `/models`） | 与 DeepSeek 专有接口耦合 |
| [anomalyco/models.dev](https://github.com/anomalyco/models.dev)（原 sst/models.dev） | MIT（npm 包 `@opencode-ai/models` 的 `license` **实读**为 MIT） | 7.6k | **高** | 供应商/模型的 base URL、能力位（`attachment`=视觉、`reasoning`、`structured_output`）、上下文与价格；`provider.toml` 里的注释记录了各家 `max_tokens` vs `max_completion_tokens`、`thinking.type` vs `enable_thinking` 的差异 | 只是数据：324 家里大量是转售网关，要裁剪；**没有文心千帆** |
| [openai/openai-node](https://github.com/openai/openai-node) | Apache-2.0 | 11k | 中高 | `src/core/error.ts` 的 400/401/403/404/409/422/429 → 子类映射，**直接照抄这 20 行结构** | 整包是单家 SDK，与现有 fetch 层重复 |
| [ChatGPTNextWeb/NextChat](https://github.com/ChatGPTNextWeb/NextChat) | MIT | 89k | 中 | `app/client/platforms/` 的「一家一个文件」适配器；`path()` / `chat()` / `extractMessage()` 三段式 | 数据过时（2024 世代模型名）；**文心/混元那两个类不能抄**（见 1.4） |
| [cline/cline](https://github.com/cline/cline) 的 `@cline/llms` | **Apache-2.0** | 62k | 高 | **`sdk/packages/llms/src/providers/builtins.ts` 的声明式 spec 表**（id/family/protocol/capabilities/apiKeyEnv/defaults.baseUrl/apiLineBaseUrls 国内国际双线/configFields/metadata.routing）+ `catalog/` 的 models.dev 生成管线 | 包 11.3 MB、拉 `@aws-sdk/*`/OpenTelemetry，不适合依赖；只抄结构与字段名 |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | MIT | — | 中 | `packages/ai/src/providers/*.ts` 的 `compatibility` 声明式写法 | 绑它的 `effect` 框架与 `Route/Endpoint` 抽象，抄出来等于重写 |
| [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | MIT | 13k | 中 | `ProviderConfig` 的声明式参数映射（`param/default/min/max/transform`） | 是网关、要部署；只有 52 家，缺豆包/文心/混元 |
| [songquanpeng/one-api](https://github.com/songquanpeng/one-api) | MIT | 37k | 中低 | `relay/adaptor/baiduv2/constants.go`：**models.dev 没有的文心端点常量** | Go；仓库近一年没动；抄常量不抄代码 |

### 1.2 覆盖矩阵（决定我们到底要自己补几家）

| 厂商 | models.dev | 结论 |
|---|---|---|
| DeepSeek / 通义 / 豆包 / 智谱 / Kimi / OpenAI / Gemini | 有，含 base URL + 能力位 + 价格 | 直接 vendor |
| 腾讯混元 | 半覆盖：只有 TokenHub 与 LKEAP 入口（`tokenhub.tencentmaas.com/v1`），**经典 `api.hunyuan.cloud.tencent.com` 不在里面** | 端点自己填，能力位借它的 |
| 文心/千帆 | **完全没有**（`qianfan`/`wenxin`/`baidubce` 在 6.7 MB 数据里 0 命中） | 自己维护；用 [千帆官方 OpenAI 兼容文档](https://cloud.baidu.com/doc/qianfan/s/Hmh4suq26) 的 `https://qianfan.baidubce.com/v2` + API Key |

> **顺带解决了之前的「最大未决项」**：千帆 v2 是 **API Key 直连**（官方文档写明「调整 api_key、base_url、model 即可用 OpenAI SDK」），不需要 client_id/secret 换 token 的老 OAuth 流程。所以「用户只填一个 Key」对文心成立。

### 1.3 一个必须建模对的东西：推理参数的三种写法

| 厂商 | 写法 |
|---|---|
| DeepSeek / 智谱 / Kimi | `thinking.type = enabled \| disabled`（Kimi K3 改用 `reasoning_effort = low \| high \| max`） |
| 通义 | `enable_thinking: bool` + `thinking_budget: int` |
| 火山方舟 | 另一套 |

**不要**用一个 `enableReasoning: boolean` 再往各家翻译。按 models.dev 的 `reasoning_options: [{type:"toggle"} | {type:"effort", values:[...]}]` 建模，UI 才知道该渲染「开关」还是「三档」。

### 1.4 绝对不能抄（这次调研最容易踩的坑）

| 项目 | 许可证 | 为什么危险 |
|---|---|---|
| [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio) | **AGPL-3.0** | 形态和我们最像（Electron + BYOK），但 AGPL + 闭源分发不兼容。**一行代码都不抄**，只看交互流程 |
| [lobehub/lobe-chat](https://github.com/lobehub/lobe-chat) | 自定义「LobeHub Community License」（Apache-2.0 + 附加商业许可条件） | star 最高的几个恰好最不能抄 |
| [chatboxai/chatbox](https://github.com/chatboxai/chatbox) | **GPL-3.0** | 同上 |
| [open-webui/open-webui](https://github.com/open-webui/open-webui) | 自定义「Open WebUI License」 | 同上 |
| NextChat 的 `baidu.ts` / `tencent.ts` | MIT，但**技术上错** | 文心走老 OAuth（`aip.baidubce.com` 换 token）；混元走腾讯云 TC3 签名原生 API（`hunyuan.tencentcloudapi.com`，字段首字母大写）。两者都与「用户只填一个 Key」冲突 |
| `litellm/enterprise/` | MIT 明文排除 | 不要碰 |

### 1.5 落地方式

> **2026-11-18 更新：供应商收缩到 4 家（DeepSeek / OpenAI / Gemini / GLM）后，本项目改为不依赖 pi-ai。** 本节保留为「以后要扩到第 5、6 家」时的接入方案（成本约 1 天验证 + 1 天接线）。

**依赖 `@earendil-works/pi-ai`（精确锁版本）+ 用 Cline 的表结构写我们自己的 `providers.config.ts`。**

- **传输层依赖 pi-ai**：解包 4.5 MB（实读 4,509,513 字节），子路径导入可按 provider 裁剪；`createProvider({ baseUrl, fetchModels, models:[{ id, api:'openai-completions', input, cost }] })` 正好覆盖国内 6 家 + 自定义。
- **配置层抄 Cline**（Apache-2.0，只抄字段与分层，不抄实现）：一张 `builtins` 表，字段 `id / name / family / protocol / capabilities / apiKeyEnv / defaults.baseUrl / apiLineBaseUrls(国内·国际) / configFields / metadata.routing`。禁止 `modelId.includes(...)` 这种 if。
- **注意 pi-ai 没有运行时目录刷新**：它的 catalog 是构建期 `node catalog/generate.ts --strict` 生成、随包发布（`dist/providers/data`）。所以「新模型上线不用发版」必须靠我们自己的 `/models` + models.dev 刷新（PLAN-PROVIDERS §5），Cline 的 `catalog/` 管线是这部分的参考实现。
- 不装 `@opencode-ai/models`（8.2 MB，只为取数据不值）；不依赖 `@cline/llms`（11.3 MB 且拉 AWS SDK）。
- 唯一需要手工维护的是 **文心/千帆的端点**（models.dev 没有），一行配置 + NOTICE 注明。

### 1.6 DSH 拆解实录（为什么「直接搬 DSH 的模块」搬不动）

我把这台机器上 `D:\soft\DeepSeek Harness\resources\app.asar` 拆开数了一遍（25,552 个文件）：

| 事实 | 证据 |
|---|---|
| DSH 是多供应商的 | 338 个 `@deepseek-ai/dsh-*` 包，其中 `dsh-llm`（厂商无关接口）、`dsh-llm-pi-ai`（适配器）、`dsh-llm-deepseek`（DeepSeek 实现）、`dsh-credentials`、`dsh-token-meter` |
| 这些包 **是 MIT** | 逐个读 `LICENSE`：`MIT License / Copyright (c) 2026 DeepSeek` |
| 但它不是「一个模块」 | `dsh-llm-pi-ai/package.json` 的 `peerDependencies` 挂着 `dsh-llm`、`dsh-credentials`、`dsh-attachment`、`dsh-fs`、`dsh-timeout`、`dsh-launch-environment`、`cordis`… |
| 真正的引擎是外部 MIT 包 | 依赖里写着 `"@earendil-works/pi-ai": "^1.3.0"` |
| 它自己的「模型自动更新」怎么做的 | `dsh-llm-deepseek/src/listing-cache.ts`：注释原文 "Credential-scoped `/models` cache with single-flight loads, background refresh, and last-known-good retention"；`listing-config.ts`：默认 `modelsMaxAgeMs = 600_000`（10 分钟）、`modelsTimeoutMs = 5_000` |
| 它**不算钱** | `dsh-llm-pi-ai/src/catalog.ts` 注释原文："The harness never reads pi-ai's cost metadata — `replay.ts` zeroes it and no consumer reports spend" |

**所以正确的借法是两条，不是一条**：
1. **依赖 pi-ai** 拿到"传输 + 厂商差异"这一层；
2. **抄 DSH 的 `listing-cache.ts`**（约 200 行，MIT，半径 0）拿到"目录刷新不能把用户搞崩"这一层——单飞、按凭据分域、后台刷新、失败保留旧值。

**顺带一个反证**：DSH 自己都不做费用展示（把 cost 清零）。这说明"价格一定会滞后"是行业共识；我们的策略应该是**如实标注来源与日期、未知就不显示**，而不是假装精确。

---

## 2. 自动更新

### 2.1 结论

用 **`electron-updater`（MIT，npm latest 6.8.11，v26 线 6.8.12 —— 均实读）+ electron-builder 26**，`publish.provider = github`。

`update-electron-app` + `update.electronjs.org` 出局，原因很硬（官方 README 原文）：

> For Windows, you'll need to build a `.exe` and `.nupkg` files with electron-forge or electron-winstaller.

它依赖 Squirrel 的 `RELEASES` + `.nupkg`；electron-builder 的 NSIS 产物是 `*-Setup.exe` + `latest.yml` + `.blockmap`，**服务端无货可发**，而 electron-builder 官方明确「Squirrel.Windows is not supported」。

### 2.2 必须写对的 5 个配置（写错任一条都会静默失效）

1. **`artifactName` 必须含 `${version}`**（默认就带）——否则第一次更新必然整包。
2. **`electron-updater` ≥ 6.8.11**——旧版在 GitHub 302 跨域下会**静默退化成整包**，日志里只有 `fallback to full download`。
3. **`nsis.perMachine: false`**——per-machine 更新要 UAC，自动安装会被跳过，用户永远停在旧版。
4. **`owner`/`repo` 显式写死**——仓库改名后名字被抢注，等于给别人向你用户推更新的机会。
5. **`nsis.differentialPackage: "store-asar"` + `asar.contentAlignment: 512`**——差分才真的小（官方基准：一行改动 96–409 KB → 8.6–9.6 KB）。

### 2.3 差分：能用，但别承诺

GitHub 上的差分历史上反复坏过（302 跳转后 Range 丢失、blockmap 缓存过期导致 sha512 mismatch），2026-10 才系统性修好。**按「多数时候能差分、偶尔退整包」写文档**，不要向用户承诺增量。

### 2.4 `--no-sandbox`：三保险（不是单选）

| 保险 | 做法 | 覆盖什么 |
|---|---|---|
| 1. 代码侧 | `app.commandLine.appendSwitch('no-sandbox')` + `disable-gpu-sandbox`，在 `ready` 之前 | 与安装包/快捷方式解耦，**更新后天然保留** |
| 2. 快捷方式 | `build/installer.nsh` 的 `customInstall` 里重建 `.lnk` 带参数 | 覆盖"从开始菜单点"，也覆盖"exe 启动早期就崩" |
| 3. 崩溃自愈 | `userData/launch-ok` 打点，连续 3 次未打点则强制兼容模式 | 兼容那些只崩 GPU 的机器（参考 [electron#49167](https://github.com/electron/electron/issues/49167)：某些 Windows 配置下需 `--no-sandbox` + `--disable-gpu-sandbox` 才行） |

> 官方文档明确说 `--no-sandbox` **「只应在测试时使用」**，所以这三条要配合「设置页显式开关 + 首启提示」一起做，不能默认全量关沙箱。

### 2.5 备选（评估过但不用）

| 方案 | 为什么不用 |
|---|---|
| [Velopack](https://github.com/velopack/velopack)（MIT） | 自带 Setup.exe（不是 NSIS）、要 .NET 8 SDK、引入原生 `.node`；换安装器收益不抵成本 |
| Squirrel.Windows（MIT） | 2024-07 后无提交、423 个 open issue，且 electron-builder 不支持它做自动更新 |
| electron-release-server（MIT） | 要自建服务器，违背前提；已停更 |

---

## 3. 云端同步

### 3.1 Obsidian Git 像不像？—— 不像，四层都不在同一个粒度上

| 维度 | Obsidian Git | 我们的构想 | 判断 |
|---|---|---|---|
| 同步对象 | 整个 vault 的**文件**（`.md`/图片/画布） | SQLite 的**表行** | ✗ |
| 合并粒度 | 文本**行级 3-way merge**（isomorphic-git 依赖 diff3） | 记录/字段级 | ✗ |
| 冲突策略 | **停下来喊人**：列出冲突块，人工逐块选 | 自动合并、静默 | ✗ 哲学相反 |
| 加密 | **没有**，靠私有仓库 + HTTPS | 端到端加密 | ✗ 缺一层 |
| 二进制 db | 做不到：二进制页 + WAL，任何一侧改动都整文件冲突，强合并必 `malformed` | 必须支持 | ✗ 根本不可用 |

**它值得借的只有两样**（而且它是 **MIT**，LICENSE 我实读了）：

1. **触发策略**：`interval`（可设 0 关闭）、`after idle`、commit 与 push 用**两个独立计时器**、**跨会话续算**（关掉应用后，下次启动自动补跑上次没跑完的同步）。这套「不打扰但会补」的心智正好是我们要的。
2. **凭证处理**：桌面端用本地 askpass server，token 不落盘到仓库。

### 3.2 真正可复用的：age 加密（BSD-3）

- [FiloSottile/typage](https://github.com/FiloSottile/typage) = npm `age-encryption`，BSD-3-Clause，纯 JS/WASM（依赖已审计的 `@noble/*`），**不用自己设计信封格式**。
- 注意：原 `str4d/age-encryption.js` 仓库已 404，npm 上的 `age-encryption` 现在指向 typage。
- **age 是整文件重写、不支持追加** → 必须「按天/按批分片」，这恰好和「增量上传」吻合，也顺手解决了「一个大日志越滚越大」的问题。

### 3.3 否掉的路线

| 路线 | 为什么否 |
|---|---|
| [cr-sqlite](https://github.com/vlcn-io/cr-sqlite)（MIT） | ① 需要 SQLite 扩展加载，我们用的是 `node:sqlite`（Electron 38 内置 Node 22，能否 `loadExtension` 第三方 dll 未实测）；② 合并语义是**逐列 LWW**——`reps/lapses` 各改一半会丢掉另一台的复习，对背单词不可接受；③ 要把表改成 CRR，导入/去重逻辑全跟着改 |
| [Automerge](https://github.com/automerge/automerge) / [Yjs](https://github.com/yjs/yjs)（均 MIT） | 是「文档 CRDT」，要么双写、要么把整个库塞进一个 blob；我们已经有确定性的 FSRS 重放，不需要 CRDT 引擎 |
| [Joplin](https://github.com/laurent22/joplin)（**AGPL-3.0**） | 只能读设计：它的「单条 item 增量 + E2EE + 冲突进 Conflict 笔记本，绝不丢数据」是最接近的成熟形态，但 AGPL 不能抄代码 |
| Obsidian LiveSync（MIT） | 要 CouchDB（自建/托管）= 服务器，违背前提 |
| Standard Notes / NotesNook / Anytype | 都要账号服务器；且 AGPL / 自定义许可 |
| [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git)（MIT） | 备用路线：真想要「提交历史/回滚」时再上。它不解决记录级合并（合并仍是文本 diff3），只多给了内容寻址与 packfile |

### 3.4 结论

**GitHub 当对象存储（Contents/Git Data API）+ age 分片加密 + 自建「reviews 事件流 / cards 重放」合并。** 这套组合里没有一行是重复造轮子：加密用 age，传输用官方 API，合并规则是这个应用特有的业务（本来也找不到现成轮子）。

---

## 4. 多个库（Deck）

### 4.1 Anki 的四个答案（AGPL，只读语义）

| 问题 | 答案 | 依据 |
|---|---|---|
| 一张卡属于几个牌组 | **一个**；同一个 note 可以生成多张卡分散在不同牌组 | Anki 手册 editing / browsing |
| 移动卡片到别的牌组，进度保留吗 | **保留**（Change Deck ≠ Reset） | browsing（Change Deck）、resetting-progress FAQ |
| 复制笔记到别的牌组 | 产生**全新卡、全新进度**（Create Copy） | browsing |
| 每日新卡上限按牌组还是全局 | **按牌组**（deck options / preset），父牌组可做总闸 | deck-options |

### 4.2 我们为什么不照 Anki 做

Anki 的模型是「卡属于牌组」→ 同一个词在两个牌组就是**两份独立进度、复习两遍**。这适合 Anki，因为 Anki **不做全局去重**。

我们恰好相反：`docs/PLAN.md:16.15` 明确做了**单词级全局去重**（一个词只有一条记录、一份进度）。如果照 Anki 给每个库复制一份进度：

- 同一个词在两个库各复习一遍 → **对高中生是净负担**，不是功能；
- 合并两个库时，两份进度要选一个（丢一边）或做冲突合并（复杂且无意义）。

所以本项目的模型是：**库是「笔记的容器 + 学习范围」，进度仍跟着单词走；每库一份「每日新词额度」**。这正是「分别背、分别限流」的效果，同时不会把同一个词复习两遍。

> 反例参考：[obsidian-spaced-repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition)（MIT）是「deck 只是视图、进度跟卡走、一张卡可属多个 deck」——但它的 deck 不参与额度计算，所以无法解决「3500 词占满队列」这个具体问题。

### 4.3 可借鉴的交互（这层才是真正值得抄的）

- **三种选择操作一个都不能少**：Anki Browse 的 Edit 菜单是 `Select All` / `Select Notes`（只保留已选）/ **`Invert Selection`（反选，最常被漏掉）**。
- **修饰键**：`Ctrl+A` 全选、`Shift` 点选区间、`Ctrl` 点切换单项。
- **无修饰键场景**：AnkiDroid 的「长按进入选择态 → 长按第二项 = 选中区间」，适合触控板用户。
- **批量动作放顶部工具栏，不要只做右键菜单**：Anki 的批量动作在菜单栏，右键只是次要入口；且「先选动作 → 选目标 → 再点确认」天然构成二次确认（Change Deck 选完牌组还要点 `Move Cards`）。
- **状态可见**：工具栏常驻「已选 N 项」，0 选中时禁用批量按钮；危险操作给可撤销提示。

---

## 5. 许可证纪律（写进 CONTRIBUTING）

### 5.1 先分清两件事：**进向** vs **出向**

- **进向**（别人的代码进你的项目）：由**对方的许可证**决定，和你自己开不开源**无关**。你 MIT 开源，不等于能把 AGPL 代码抄进来。
- **出向**（你的项目给别人用）：由**你选的许可证**决定。开源只是让你有义务把源码给到使用者，不改变你能不能吃别人的代码。

一句话：**开源不放松任何限制，只是换了一组你要履行的义务。**

### 5.2 能不能抄，取决于你最终选哪个许可证

| 第三方许可证 | 你的项目用 **MIT** | 你的项目用 **AGPL-3.0** | 典型例子 |
|---|---|---|---|
| MIT / BSD / ISC | ✅ 保留版权与许可文本 | ✅ | DSH、pi-ai、obsidian-git、Rocket.Chat、PicGo |
| Apache-2.0 | ✅ 保留 `LICENSE` + `NOTICE`，标注改动 | ✅ | Cline、AnkiDroid 的部分文件、VS Code |
| MPL-2.0 | ✅ 但**改过的 MPL 文件**仍须以 MPL 发布 | ✅ | Syncthing（单文件级 copyleft） |
| LGPL-2.1/3.0 | ⚠️ 动态链接可；打包进 asar 要提供替换方式 | ✅ | npm 里少见 |
| GPL-2.0/3.0 | ❌ 整个项目必须 GPL | ✅ AGPL §13 允许组合；**GPL 部分仍按 GPL 提供源码** | qwerty-learner、Chatbox、AnkiDroid |
| AGPL-3.0 | ❌ 整个项目必须 AGPL | ✅ | Anki、Joplin、Cherry Studio、GitJournal |
| FSL / 自定义「源码可见」 | ❌ | ❌ | crush（FSL）、lobe-chat、open-webui |
| 没有 LICENSE 的仓库 | ❌ 默认「保留所有权利」 | ❌ | — |

**所以：**
- 你继续用 **MIT** → 之前定的「AGPL/GPL 只读、不抄代码」**原样成立**，一个字都不用改。
- 如果你改主意用 **AGPL-3.0** → Anki/Joplin 的**代码**就可以抄了，代价是：任何人分发你的软件都必须给源码；App Store / 带 DRM 的分发会冲突；一些公司会直接不用；而且**这是单向门**（见 §5.3）。
- 想两全的选择：**MIT + 只抄语义不抄代码**。Anki 的「Change Deck 流程」「三操作选择」这类是**交互约定**，不受版权保护，照着自己写完全合法。

**如果真换成 AGPL，实际能多拿到什么？**（别为了"能抄"而错付代价）

| 项目 | 语言/栈 | 抄了有用吗 |
|---|---|---|
| [Joplin](https://github.com/laurent22/joplin) | TypeScript + React | **有用**：多选列表、`useOnNoteClick`、E2EE/sync target 抽象都是同栈 |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | Electron + TS + React | **有用**：多供应商设置页交互 |
| [Anki](https://github.com/ankitects/anki) | Python + Qt + Rust | **没用**：抄不进 Electron/React，只能抄语义——而语义不受版权保护，MIT 下也能学 |
| [qwerty-learner](https://github.com/RealKai42/qwerty-learner) | React + TS | 用处有限：它没有"库"实体，只有静态词库清单 |

结论：**为了抄 Anki 而改 AGPL 是亏的**（同栈用不上）；真正值钱的 AGPL 代码只有 Joplin 那一套，而它要的东西我们已经用「事件流 + 重放」自己解决了。

### 5.3 单向门：许可证要现在定，不要以后改

- 现在就你一个作者 → 你可以随时改许可证。
- 一旦接受外部 PR 且没有 CLA → 想从 MIT 改成 AGPL，需要**每一位贡献者**同意，实际上做不到。
- 建议：**MIT + DCO**（贡献者签署「我有权提交这段代码」），不要求签 CLA。这样保持简单，也保留"将来想换许可证"的理论可能（需逐个联系）。
- 如果你心里已经认定「这辈子就要 copyleft」→ 现在就用 AGPL-3.0，别等到抄了代码再纠结。

### 5.4 发布二进制时额外的义务（很多人漏掉）

| 对象 | 要做什么 |
|---|---|
| Electron 本体（MIT） | 随包附带 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`（Electron 发行目录里自带） |
| npm 依赖 | 用 `license-checker --production` 生成 `THIRD-PARTY-NOTICES.txt`，随安装包/zip 一起发 |
| Apache-2.0 依赖的 `NOTICE` | 必须把你的 NOTICE 内容传递下去（不是只给 LICENSE） |
| 图标 / 字体 | 确认 `build/icon.ico`、`lucide-react`（ISC）、字体来源允许分发 |
| `samples/`、`shots/`、`.data/` | **教科书/老师笔记的扫描件涉及版权与隐私**，开源前必须替换成自造样例；`.data/` 与 `secrets.bin` 绝不入库 |
| 项目名与厂商名 | 「WordMemo」自己用没问题，但别用 DeepSeek/OpenAI 的 logo，也别暗示官方背书 |
| API 服务条款 | BYOK（用户自带 Key）是合规的关键；**绝不能**内置或转售 Key，也别拿 API 做批量训练 |

### 5.5 执行清单

| 类别 | 可以用 | 只能读思路 | 明确不要碰 |
|---|---|---|---|
| 代码复制（MIT 项目） | MIT / BSD / ISC / Apache-2.0（保留声明与 NOTICE） | AGPL-3.0（Anki、Joplin、Cherry Studio、GitJournal、logseq）、GPL-3.0（Chatbox、qwerty-learner、AnkiDroid） | crush（FSL）、lobe-chat / open-webui（自定义）、无 LICENSE 的仓库、litellm `enterprise/` |
| 设计 / 交互 | 不受版权保护的「约定、流程、算法」可以直接照做 | — | 逐字复制注释、变量名、UI 文案 |
| 数据 | models.dev（MIT）可 vendor 子集 | — | 其它来源不明的模型/价格表 |

**两条规矩**：复制进项目的代码必须在 `NOTICE` 里列出来源与许可证；**只读项目在注释里写「参考自 …，未复制代码」**。

### 5.6 MIT 还是 Apache-2.0（本项目该选哪个）

> **已定（2026-11-18）：MIT**，`LICENSE` 已放仓库根目录。

| 维度 | MIT | Apache-2.0 |
|---|---|---|
| 长度 | 一页，几乎不用读 | 十页，含定义与专利条款 |
| 专利授权 | ❌ 没有明示专利许可 | ✅ **明示授予**贡献者与下游的专利许可 |
| 专利反击 | ❌ 无 | ✅ 谁告你专利侵权，就自动失去该项目的专利许可 |
| 商标 | 不涉及 | 明确**不授予**商标权 |
| 修改声明 | 不要求 | **必须标注修改过的文件** |
| NOTICE 文件 | 不需要 | 有 NOTICE 就必须原样传递 |
| 与 GPLv2 兼容 | ✅ | ❌（与 GPLv2 不兼容；GPLv3/AGPLv3 没问题） |
| 与 MIT/BSD 项目互操作 | ✅ | ✅（可被 MIT 项目使用，需保留声明） |
| 对使用者 | 最省心 | 多一份合规工作 |

**本项目的选择：MIT。** 理由：
1. 这是一个**个人维护的背单词工具**，没有专利资产，Apache 的专利条款对你的实际场景几乎无增量价值。
2. Apache 的「必须标注修改」与 NOTICE 传递，会让一个学生项目的合规成本高于收益；而且你想让老师/同学直接拿去做衍生版本，MIT 的门槛最低。
3. 你选的依赖（pi-ai MIT、age BSD、Electron MIT、Rocket.Chat 36 行 MIT、obsidian-git 53 行 MIT）在 MIT 下完全兼容。

**唯一要注意的**：如果你**逐字复制** Apache-2.0 的代码（比如 Cline 的 `builtins.ts`），那部分代码仍然是 Apache-2.0，要保留它的 LICENSE/NOTICE 并标注修改。所以计划里写的是「**抄字段与分层，不抄代码**」——自己写一张表，MIT 就干净了。

> 一句话：**MIT 管"别人能怎么用你的代码"，Apache-2.0 多给"专利"和"多一堆义务"。** 没有专利、要最大传播 → MIT。

---

## 6. 未核实 / 下一步要实测

1. **混元经典端点** `api.hunyuan.cloud.tencent.com/v1` 是否仍可用（models.dev 只记了 TokenHub / LKEAP）；官方公告说能力在迁往 TokenHub。**接之前实测一次。**
2. **火山方舟的 `model` 能否填 `ep-...` 接入点 ID**（来自既有认知，未逐字核实官方文档）——UI 必须允许手填 model，不能只给下拉。
3. **models.dev 价格单位**：数值量级与官方 $/1M tokens 吻合，但 schema 未声明单位。**接入后抽 2~3 家用官方价核对。**
4. **Electron 38 内置 Node 22 是否支持 `node:sqlite` 的 `loadExtension`**（决定 cr-sqlite 路线是否根本不可行）——已否掉该路线，不必再验。
5. **`electron-updater` 6.8.11 与 `electron-builder` 25/26 的混搭**——理论上独立，实际建议同版本线（26 线用 `v26` dist-tag 的 6.8.12）。
6. **age-encryption 在 Electron 主进程的打包体积**（WASM/纯 JS）——装机包会涨多少，实测后再定是否接受。
7. **Anki「移动保留进度」**没有官方正面表述，是从「Change Deck 与 Reset 是两个动作」推出的；语义方向可信，细节（学习步骤是否重置）未逐条核。
8. GitHub API 限流期间部分文件路径来自子调研转述（如 NextChat 的具体文件、one-api 的 constants.go），**落地前点开确认一眼**。
9. **pi-ai 的三个待验证点**（P0 spike 要回答）：① 内置 provider 的目录刷新是不是 no-op（README 说 static built-in 对 `refresh()` 是 no-op，所以我们的模型目录必须走 `createProvider` + `fetchModels`）；② `compat`（`thinkingFormat` 等）放在 model 对象哪一层；③ electron-vite 把 ESM-only 的 pi-ai 内联进 CJS 主进程会不会出问题、安装包涨多少。
10. **models.dev 的运行时接口**：`api.json` 是 6.7 MB 整包，是否有按 provider 的轻量端点没核实；若没有，就按"下载后只留 4 家"处理。
11. **DSH 的 338 个包是 asar 内的目录视图**，我按 `package.json` 的存在判断包边界；不排除有软链/重复嵌套导致计数偏大。结论（"不是一个模块"）不受影响。
12. **Roo-Code 已归档**（最后一次 push 2026-05-15），其 `src/api/providers` 只能当反例，不能依赖。
13. **`lx-music` 的更新实现**只核实了文件存在（`src/renderer/utils/update.js`，2.07 KB），内容被 CDN 的 MIME 拦掉、没读到。
14. **obsidian-livesync 的块 ID 与密钥耦合**：其 changelog 记载曾因块 ID 复用 E2EE 密钥派生而存在暴力破解风险，所以即使代码是 MIT，抄分块层也必须重做 ID 规格。
15. **GitJournal 的冲突行为**依据的是 issue #241 与商店评论（"自动 merge 可能覆盖桌面端改动"），`.dart` 源码未逐行读。
16. **Anki「批量复制」不存在**（只有单条 Create Copy）；我们的批量复制是自定义语义。
17. **Cline `builtins.ts` 的字段是实读**，但其中 `bailing` / `tencent-tokenhub` 是否对应文心/混元**未核实**；文心仍按千帆 v2 自己补。
18. **crush 的许可证是 FSL-1.1-MIT**（实读 `LICENSE.md` 全文）：两年内禁止"竞争性使用"，之后转 MIT。不是开源许可，不要写进"可复用"清单。

---

## 7. 各计划里对应的动作

| 计划 | 要用到的结论 |
|---|---|
| [PLAN-PROVIDERS.md](PLAN-PROVIDERS.md) | 4 家自写薄适配；配置表抄 Cline 的 `builtins` 字段；抄 DSH 的 `listing-cache.ts`；模型名走 `/models`、价格走 models.dev + 快照；文心端点不在范围内；绝不抄 Cherry/Chatbox/Lobe/OpenWebUI/crush |
| [PLAN-UPDATE.md](PLAN-UPDATE.md) | **便携版 + 启动器换目录**（不用 electron-updater/NSIS）；不签名；检查节流可借 Rocket.Chat 的 24h/退避逻辑；手动路径 B 与自动路径共用同一份 zip |
| [PLAN-SYNC.md](PLAN-SYNC.md) | **整段抄 obsidian-git 的 `promiseQueue.ts`**；抄它的 lastAuto 续算与 Syncthing 的冲突副本命名；记录级合并没有先例（S0 退路）；加密用 age（不造 AES 信封）；否掉 cr-sqlite |
| [PLAN-DECKS.md](PLAN-DECKS.md) | 没有 MIT/Apache 的产品级实现；Anki 语义只读但模型不同；抄 5 条交互（id 列表、选区上限、内联新建库、单步撤销、空选区禁用） |
