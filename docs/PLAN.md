# WordMemo — 英语笔记背诵工具 · 设计方案

> 版本：v0.1（2026-11-02）
> 状态：**仅设计，暂不写实现代码**
> 目标平台：Windows 10/11 桌面端，单用户、本地优先

---

## 0. 一句话概括

把老师杂乱的英语笔记（拍照 / txt / md / docx / xlsx）变成**结构化词条库**，用 **FSRS** 安排长期复习，用**听写日期倒排**生成冲刺计划，用 **DeepSeek** 做识别、校验与语义判分，用**本地缓存的真人发音**支持听写训练。

---

## 1. 需求 → 方案 → 验收

| # | 你的要求 | 本方案 | 怎么验收 |
|---|---|---|---|
| 1 | 所有笔记进数据库，可查询、按时间排序 | SQLite 单文件库 + FTS5 全文索引；笔记有「上课日期 / 导入时间」两种时间轴 | 搜 `abandon` 能命中词条与笔记；按上课日期/导入时间排序正确 |
| 2 | 用 FSRS（开源、不自己实现）排间隔并弹窗提醒 | 直接依赖 `ts-fsrs`（FSRS-7），**不重写任何记忆公式**；Windows 原生通知 + 托盘 | 评分后下次到期日由 ts-fsrs 计算；到点弹通知 |
| 2b | 设置老师下次听写日期，算法自动分配任务 | 独立的「听写冲刺」计划层：读取 FSRS 记忆状态，按考试日倒排每日配额 | 设置 7 天后听写，自动生成每天任务；进度条与「预计考试日记忆率」可查看 |
| 3 | 不只应付听写，还要长期记忆 | 双轨道：长期轨道（FSRS 默认保留率 0.90）+ 冲刺轨道（0.95，考前加练）；冲刺复习同样写入 FSRS 历史 | 考试结束后卡片自动回到长期轨道，间隔随复习历史自然变长 |
| 4 | 爬取权威发音、本地缓存 | 有道词典发音 → 百度翻译 TTS → 免费词典 API 三级回退；mp3 落盘缓存 | 断网后已下载过的词仍可播放；同一单词不重复请求 |
| 4b | 中英双向随机、不显示音标、可播读音 | 每个词条生成「英→中」「中→英」两张卡（可选第三张「听→写」），每张卡独立 FSRS 状态；复习界面永不渲染音标 | 方向由到期卡随机决定，长期看两个方向都会出现；界面上找不到 IPA |
| 4c | 中文翻译不唯一，用 AI 判语义；能命中词库就不调 AI | 三级判分：精确/变体匹配 → 词库义项/同义词命中 → 才调 DeepSeek；AI 结论永久缓存 | 常见答案 0 token；只有生僻表达才产生 AI 调用 |
| 5 | 只支持 DeepSeek API Key | 只用 `https://api.deepseek.com`（OpenAI 兼容），Key 用 Windows DPAPI 加密 | 设置页填入 Key 可测通；不依赖其他厂商 |
| 6 | 图片 + 文档上传；AI 识别；解析器用成熟项目；入库前 AI 校验；错误黄色标记 | 图片走 DeepSeek 视觉（`deepseek-flash`）；docx→mammoth，xlsx→ExcelJS，txt/md 自读；统一 AI 校验并逐条标黄 | 上传 5 种格式都能出结构化结果；有问题字段显示黄色 + 说明 + 建议 |

---

## 2. 关键决策（以及为什么）

### 2.1 形态：Electron 桌面应用

| 方案 | 结论 | 理由 |
|---|---|---|
| **Electron + React + TS** | ✅ 采用 | 需要托盘、开机自启、Windows 通知、本地文件与数据库；本机已装 Node 24，无需 Rust；生态最成熟 |
| Tauri 2 | ❌ | 需要 Rust 工具链（本机没有），且 SQLite/通知仍要自己接，收益只有体积 |
| 纯本地网页（Node 服务 + 浏览器） | 备选 | 实现最简单，但没有托盘/原生窗口，弹窗依赖后台进程，体验差一截 |
| Python + FastAPI | ❌ | 本机 Python 3.14 太新，依赖轮子滞后；且要和前端两套运行时 |

> 版本基线：Electron **45.x**（内置 Node **24.22**、Chromium 156）。这也是 `ts-fsrs` v6 要求 Node ≥ 24 的直接满足条件。

### 2.2 数据库：优先 Node 内置 `node:sqlite`

- Node 24 的 `node:sqlite` 已是 **Release Candidate**，同步 API、支持事务、自带备份接口。
- **零原生编译**：不需要 Visual Studio Build Tools，也不会遇到 Electron ABI 重编译问题。
- 备选：`better-sqlite3`（MIT，最成熟）。若 M0 验证发现内置 SQLite 没开 FTS5，则切换，成本很小（仓储层已隔离）。

### 2.3 调度：只做「策略层」，不做「算法层」

- 记忆状态、间隔、遗忘曲线、参数优化 → **全部交给 `ts-fsrs`**。
- 我们只写：选哪些卡今天复习、考试前如何加练、每天多少分钟。这是产品策略，不是 FSRS 实现。

### 2.4 OCR：直接调用 DeepSeek 视觉，不做本地 OCR

- DeepSeek 官方现已提供视觉能力：`deepseek-flash` 支持 JPEG/PNG/GIF/WebP，单图最多约 **1024 tokens**，非常便宜。
- 本机不需要 GPU、不需要 PyTorch、不需要下载几百 MB 模型。
- 保留 PaddleOCR / RapidOCR 作为「离线应急」可选插件，但不进第一版。

### 2.5 发音：网页接口 + 本地缓存（不打包发音库）

- 有道：`https://dict.youdao.com/dictvoice?audio=<word>&type=2`（美音）/ `type=1`（英音），返回 `audio/mpeg`（已实测可用）。
- 百度：`https://fanyi.baidu.com/gettts?lan=en&text=<word>&spd=3&source=web`，返回 `audio/mpeg`（已实测可用）。
- 兜底：`https://api.dictionaryapi.dev/api/v2/entries/en/<word>`（返回音频 URL，源自 Wiktionary）。
- 离线兜底：Chromium 自带 `speechSynthesis`（系统英文语音），无网络也能读。

---

## 3. 系统架构

```
┌──────────────────────────────────────────────────────────────────┐
│ Renderer (React)                                                  │
│  导入页 · 笔记库 · 今日复习 · 听写冲刺 · 统计 · 设置              │
│  只通过 preload 暴露的白名单 IPC 访问能力                          │
└───────────────▲──────────────────────────────────────────────────┘
                │ contextBridge / IPC
┌───────────────┴──────────────────────────────────────────────────┐
│ Main (Node 24 in Electron)                                        │
│                                                                   │
│  ImportService ──► Parser(image/docx/xlsx/txt/md) ──► Structurizer│
│        │                                              │           │
│        └────────────► Validator (DeepSeek) ◄──────────┘           │
│                              │                                    │
│  ReviewService ──► Judge(local→AI) ──► ts-fsrs ──► SQLite         │
│        │                    │                                     │
│        └──► TTS Service ──► 本地 mp3 缓存                          │
│                                                                   │
│  ExamPlanner ──► 每日任务 ──► Notifier(托盘/通知)                  │
└───────────────▲──────────────────────────────────────────────────┘
                │
        %APPDATA%/WordMemo/
          ├─ wordmemo.db
          ├─ media/tts/<sha1>.mp3
          ├─ files/<sha1>.<ext>     原始上传件
          ├─ backups/               每日备份
          └─ settings.json          非敏感配置
```

### 3.1 进程职责

| 层 | 负责 | 不负责 |
|---|---|---|
| Renderer | 页面、交互、图片压缩/转正、Markdown 预览 | 不直接读文件、不碰数据库、不持 API Key |
| Main | 数据库、文件、AI 调用、TTS 下载、FSRS、通知、托盘 | 不写 UI 逻辑 |
| Shared | 类型、常量、中文/英文归一化、评分规则 | 无副作用 |

### 3.2 目录结构（建议）

```
src/
  main/
    index.ts                 # 窗口/托盘/自启/单实例
    db/{schema.sql,migrate.ts,repo/*.ts}
    ai/{client.ts,ocr.ts,structurize.ts,validate.ts,judge.ts,prompts/*.ts}
    import/{image.ts,docx.ts,xlsx.ts,text.ts,normalize.ts}
    media/{tts.ts,cache.ts,queue.ts}
    scheduler/{fsrs.ts,planner.ts,session.ts,stats.ts}
    notify/{notifier.ts,schedule.ts}
    ipc/{handlers.ts,channels.ts}
  preload/index.ts
  renderer/
    pages/{Import,Library,Review,Exam,Stats,Settings}.tsx
    components/*
    stores/*
  shared/{types.ts,normalize.ts,constants.ts}
```

---

## 4. 数据模型

SQLite，`journal_mode=WAL`，`foreign_keys=ON`，单文件便于备份。

### 4.1 核心表

```sql
-- 导入批次：一张图/一个文件 = 一条 source，保留原始文件与解析原文
CREATE TABLE sources (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,          -- image | txt | md | docx | xlsx
  original_name TEXT NOT NULL,
  stored_path   TEXT,                   -- files/ 下相对路径
  sha256        TEXT NOT NULL,
  raw_text      TEXT,                   -- OCR / 解析得到的 Markdown 原文
  created_at    TEXT NOT NULL
);

-- 一次课/一份笔记
CREATE TABLE notes (
  id           INTEGER PRIMARY KEY,
  source_id    INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  note_date    TEXT,                    -- 上课日期 YYYY-MM-DD（可按文件内容/手动指定）
  tags         TEXT NOT NULL DEFAULT '[]',
  raw_markdown TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | validated | archived
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 全局词条：同一个词跨笔记只保留一条，避免重复卡片
CREATE TABLE items (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'word', -- word | phrase | sentence | grammar
  headword      TEXT NOT NULL,          -- 原形，如 look forward to
  headword_norm TEXT NOT NULL,          -- 小写、去首尾空格、统一撇号/连字符
  pos           TEXT,                   -- n. / v. / adj. / phrase ...
  phonetic      TEXT,                   -- 只存不展示（见 6.6）
  meanings      TEXT NOT NULL DEFAULT '[]',  -- ["放弃；抛弃","沉溺于"]
  examples      TEXT NOT NULL DEFAULT '[]',  -- [{"en":"...","zh":"..."}]
  extra         TEXT NOT NULL DEFAULT '{}',  -- 搭配/用法/语法点/老师强调
  accepted_zh   TEXT NOT NULL DEFAULT '[]',  -- 判分时认可的等价中文（人工或 AI 追加）
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_items ON items(headword_norm, IFNULL(pos,''), kind);

-- 笔记 ↔ 词条 多对多：保留每条笔记里的原始行，复习时可展示上下文
CREATE TABLE note_items (
  note_id  INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  raw_line TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (note_id, item_id)
);

-- 卡片：一个词条 × 一个方向 = 一张卡，各自独立的 FSRS 状态
CREATE TABLE cards (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL,            -- en2zh | zh2en | listen2en
  due_at      TEXT,
  stability   REAL, difficulty REAL,
  reps        INTEGER DEFAULT 0,
  lapses      INTEGER DEFAULT 0,
  state       INTEGER DEFAULT 0,        -- ts-fsrs State
  last_review TEXT,
  suspended   INTEGER DEFAULT 0,
  fsrs_json   TEXT NOT NULL,            -- ts-fsrs 卡片快照（含 stabilityFast 等新字段）
  UNIQUE(item_id, direction)
);

-- 每次作答（既是统计来源，也是 FSRS 参数优化的数据基础）
CREATE TABLE reviews (
  id          INTEGER PRIMARY KEY,
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  reviewed_at TEXT NOT NULL,
  rating      INTEGER NOT NULL,         -- 1 Again / 2 Hard / 3 Good / 4 Easy
  answer      TEXT,
  correct     INTEGER,
  elapsed_ms  INTEGER,
  mode        TEXT,                     -- longterm | exam
  judge_by    TEXT,                     -- exact | variant | local | ai | manual
  exam_id     INTEGER
);
CREATE INDEX ix_reviews_card ON reviews(card_id, reviewed_at);

-- 听写考试
CREATE TABLE exams (
  id               INTEGER PRIMARY KEY,
  title            TEXT NOT NULL,
  exam_date        TEXT NOT NULL,       -- YYYY-MM-DD
  scope            TEXT NOT NULL,       -- {"note_ids":[],"tags":[],"item_ids":[]}
  level            TEXT NOT NULL DEFAULT 'dictate', -- recognize | dictate | mixed
  target_retention REAL NOT NULL DEFAULT 0.95,
  daily_minutes    INTEGER NOT NULL DEFAULT 20,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TEXT NOT NULL
);

-- 每日计划（可随时重算，历史保留用于回看）
CREATE TABLE exam_plan (
  id           INTEGER PRIMARY KEY,
  exam_id      INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  card_id      INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  plan_date    TEXT NOT NULL,
  kind         TEXT NOT NULL,           -- new | review | final
  done         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_plan ON exam_plan(exam_id, plan_date);

-- 发音缓存
CREATE TABLE pronunciations (
  id         INTEGER PRIMARY KEY,
  word_norm  TEXT NOT NULL,
  accent     TEXT NOT NULL,             -- us | uk
  source     TEXT NOT NULL,             -- youdao | baidu | freedict | system
  rel_path   TEXT NOT NULL,
  bytes      INTEGER,
  fetched_at TEXT,
  UNIQUE(word_norm, accent, source)
);

-- AI 结果缓存：同样的输入永不重复付费
CREATE TABLE ai_cache (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,           -- ocr | struct | validate | judge
  cache_key    TEXT NOT NULL,
  model        TEXT,
  request_json TEXT,
  response_json TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(kind, cache_key)
);

-- AI 用量（设置页展示花费）
CREATE TABLE ai_usage (
  id           INTEGER PRIMARY KEY,
  at           TEXT NOT NULL,
  kind         TEXT,
  model        TEXT,
  prompt_tokens INTEGER, cached_tokens INTEGER, completion_tokens INTEGER,
  cost_usd     REAL
);

-- AI 校验问题 → 黄色标记
CREATE TABLE validation_issues (
  id         INTEGER PRIMARY KEY,
  note_id    INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  item_id    INTEGER REFERENCES items(id) ON DELETE CASCADE,
  field      TEXT,                      -- headword | meaning | pos | example | line
  severity   TEXT NOT NULL,             -- warning | error
  message    TEXT NOT NULL,
  suggestion TEXT,
  resolved   INTEGER NOT NULL DEFAULT 0
);
```

### 4.2 搜索与排序

- `items_fts`：FTS5，索引 `headword / meanings / extra`；中文用 `trigram` tokenizer 支持子串（若内置 SQLite 未启用 trigram，则退化为 `LIKE`，数据量 < 5 万时完全够用）。
- 笔记库排序：上课日期 ↓、导入时间 ↓、标题、到期数量。
- 过滤：标签、来源类型、是否有未处理校验问题、卡片状态（新/学习中/复习/暂停）。

### 4.3 时间约定

- 所有时间存 **本地时间的 ISO 字符串**（`YYYY-MM-DDTHH:mm:ss`），避免 UTC 跨日。
- 「一天」的分界默认 **凌晨 4:00**（可配置）：23:30 学习仍算当天，符合学生作息。
- 上课日期允许手动改（文件名/图片内容里常带日期）。

---

## 5. 导入流水线

```
选择/拖入文件
   │
   ├─ 图片(png/jpg/jpeg) ──► 浏览器端预处理 ──► DeepSeek 视觉 OCR ──┐
   ├─ docx ──► mammoth → HTML → turndown → Markdown ───────────────┤
   ├─ xlsx ──► ExcelJS → 行列 → Markdown 表格 ─────────────────────┤
   ├─ txt  ──► 编码检测 → 纯文本 ──────────────────────────────────┤
   └─ md   ──► 直接读取 ──────────────────────────────────────────┤
                                                                   ▼
                                                          结构化(JSON)
                                                                   │
                                              ┌────────────────────┴───────────┐
                                              ▼                                ▼
                                      AI 校验(必做)                    人工预览/编辑
                                              │                                │
                                              └──────────► 黄色标记 ◄──────────┘
                                                                   │
                                                            确认入库(事务)
                                                                   │
                                            建卡(2~3 方向) + 初始化 FSRS + 发音预取
```

### 5.1 图片

1. **前端预处理**（不引入原生图像库）：
   - 用 `createImageBitmap(file, { imageOrientation: 'from-image' })` 按 EXIF 转正；
   - Canvas 缩放到最长边 ≤ 2000px，导出 JPEG q=0.85；
   - 目的：避免手机竖拍方向错、减少上传体积。
2. **校验真实格式**：读文件头（magic bytes），只接受 PNG/JPEG，不信任扩展名。
3. **OCR 调用**：
   - 模型 `deepseek-flash`，图片以 base64 data URL 放入 `user` 消息；
   - 提示词要求「**忠实转录**，保留单词/词性/中文释义/例句/语法点的层级，不翻译、不补充、不纠错；不确定的字符用 `⟦?⟧` 标出」；
   - 输出 Markdown 原文，先给用户看「图片 ↔ 转录」对照。
4. **多图**：一次导入可拖多张，按文件名自然排序，逐张识别后合并为一份笔记（可手动拆成多份）。
5. **失败兜底**：超时/限流重试 2 次；仍失败则保留原图，允许手工输入。

### 5.2 文档

| 格式 | 解析方案 | 说明 |
|---|---|---|
| `txt` | `chardet` 检测编码 + `iconv-lite` 转 UTF-8 | 国内 txt 常见 GBK，不能假定 UTF-8 |
| `md` | 原样读取 | 保留表格与列表 |
| `docx` | `mammoth.js` → HTML → `turndown` → Markdown | 表格、加粗、列表都能保留；BSD-2 许可 |
| `xlsx` | `ExcelJS` 读单元格 → Markdown 表格 | 自动识别「单词/释义」列；合并单元格按左上角展开 |
| `xls`（旧格式） | 可选 `SheetJS` | 第一版可不支持，提示另存为 xlsx |

文档解析**只负责忠实还原内容**，不做「抽取词条」的判断——抽取统一交给下一步，避免两套逻辑。

### 5.3 结构化（原文 → 词条 JSON）

- 输入：Markdown 原文（可能含表格、列表、自由段落）。
- 规则优先：
  - 表格：识别表头包含「单词/词汇/English/Word」与「释义/中文/Meaning」的列；
  - 列表：`word  n. 中文`、`word - 中文`、`word：中文` 等常见分隔符；
  - 命中规则且置信度高 → 直接生成候选，不调 AI。
- AI 兜底/补全：把整段原文交给 DeepSeek，要求输出严格 JSON：

```json
{
  "items": [
    {
      "headword": "abandon",
      "pos": "v.",
      "meanings": ["放弃", "抛弃"],
      "phonetic": null,
      "examples": [{"en": "abandon the plan", "zh": "放弃计划"}],
      "extra": "常与 oneself to 连用",
      "source_line": "abandon v. 放弃，抛弃",
      "confidence": 0.98
    }
  ],
  "warnings": [{"line": 3, "reason": "疑似 OCR 断行"}]
}
```

- 约束：
  - `headword` 必须是原文出现的英文，**禁止模型自行补充同义词**；
  - `meanings` 只保留原文中文，不扩写；
  - 无法确定时置 `null` 并写入 `warnings`，不要瞎猜。
- 使用 `response_format: {"type":"json_object"}`，提示词里出现 “json” 字样；`max_tokens` 给足防止截断。
- 解析失败自动重试一次，仍失败则降级为「规则结果 + 提示人工整理」。

### 5.3.1 不是所有内容都要变成卡片

老师的笔记里除了单词，还有语法点、句型、固定搭配、例句。处理原则：

- **笔记原文永远完整保留**（`notes.raw_markdown`），不因为抽词而丢内容；
- 结构化只把「可背诵的原子单位」抽成 `items`，`kind` 区分 `word / phrase / sentence / grammar`；
- 纯语法说明（如“虚拟语气：if 从句用过去完成时”）可以做成一张 `grammar` 卡：正面是知识点标题，背面是解释，同样走 FSRS；
- 预览页每行都有「加入复习 / 仅保留在笔记」开关，默认只勾选能识别出英文词头的行；
- 宁可少抽，不要把一个段落硬拆成十几个语义不通的“词条”。

### 5.4 AI 校验（所有来源都必做）

**检查项**（逐条产出 issue，而不是笼统说“有错”）：

| 类型 | 例子 | 严重度 |
|---|---|---|
| OCR 乱码/断词 | `aband on`、`recieve` | error |
| 拼写错误 | `enviroment` | error |
| 词性与释义不匹配 | `abandon adj. 放弃` | warning |
| 中文释义与英文不对应 | `apple n. 香蕉` | error |
| 释义缺失/为空 | 只有单词没有中文 | warning |
| 例句与词条不匹配 | 例句里没有该词 | warning |
| 疑似重复/合并错误 | 同一词条出现两次且释义冲突 | warning |
| 原文不确定标记 | OCR 输出里含 `⟦?⟧` | warning |

**输出协议**：

```json
{
  "issues": [
    {
      "source_line": 12,
      "field": "meaning",
      "severity": "error",
      "message": "中文释义与英文词义不匹配",
      "suggestion": "改为：苹果"
    }
  ]
}
```

**UI 规则**：
- 有问题的一行/字段加**黄色底**，行首 ⚠️；鼠标悬停显示原因与建议；
- 「采纳建议 / 忽略 / 手动改」三个动作；
- 底部横幅：「AI 发现 6 处需核对，其中 2 处可能影响记忆」；
- 存在 `error` 时，入库按钮需勾选「我已核对」；
- 未处理的问题在笔记库里保留黄色角标。

**省钱**：校验按 **50 条/批** 发送；只发 `headword + pos + meanings`，不发例句原文；同一份内容的哈希命中缓存直接复用。

### 5.5 去重与合并

- 归一化键：`headword_norm + pos`。
- 同一次导入内重复 → 合并释义、保留第一条的例句。
- 与库中已有词条重复 → 在预览里提示「已存在，将合并释义」；用户可选择「合并 / 作为新词条（同形不同义）」。
- 合并只追加 `meanings` 与 `note_items` 关联，**不重置已有卡片的 FSRS 状态**。

### 5.6 导入事务与回滚

- 一次导入 = 一个数据库事务：`source → note → items → note_items → cards → issues`。
- 任何一步失败整体回滚，原始文件仍保留在 `files/`，方便重试。
- 导入完成后异步预取发音（不阻塞 UI）。

---

## 6. 复习与判分

### 6.1 卡片设计

每个词条默认 2 张卡，用户可为单个词条开启第 3 张：

| 方向 | 正面 | 作答 | 适用 |
|---|---|---|---|
| `en2zh` | 英文单词/短语 | 输入中文 | 阅读/考试“认识” |
| `zh2en` | 中文释义 | 输入英文 | 拼写/听写 |
| `listen2en` | 只播发音（可选显示中文） | 输入英文 | 真·听写训练 |

- 三张卡各有独立 FSRS 状态（同一个词“认得”和“写得出”是两种能力，不能共用一个记忆状态）。
- 设置里提供「双向进度」开关：
  - **独立进度（默认，推荐）**：两个方向各自排期，某个方向很熟、另一个方向仍会到期；
  - **共用进度**：每个词每次只随机抽一个方向，答对一次两个方向一起推进（复习量小，但“会认不会写”会被掩盖）。
- 考试范围可设 `level=recognize`（只练 en2zh）或 `dictate`（zh2en + listen2en）。
- 每场复习从「今日到期 + 计划内」的卡里随机抽方向，满足「随机看中文写英文 / 看英文写中文」。

### 6.2 单卡流程

1. 正面展示（英文或中文），**不显示音标**。
2. 右上角 🔊：点击播放美音；长按/下拉切换英音；播放不扣分、不限制次数。
3. 输入答案 → 回车提交（中文输入法组合期间不触发提交）。
4. 判定 → 反馈：
   - ✅ 正确：绿色，展示完整词条（英文 + 中文 + 例句 + 发音自动播一次，可关）；
   - 🟡 接近：显示差异（哪几个字母不同），让用户选「算对（Hard）/ 算错（Again）」；
   - ❌ 错误：红色，展示正确答案与例句，可「再试一次」。
5. 评分（默认自动，可手动改）→ 写 `reviews` → `ts-fsrs.review()` 更新卡片 → 下一张。
6. 快捷键：`Space` 播放、`Enter` 提交、`1~4` 评分、`Esc` 退出。

### 6.3 判分：先本地，后 AI

```
用户答案
  │
  ├─ 归一化（去空格/标点/全角半角/大小写；中文去“的/地/得”？不做，避免误判）
  │
  ├─ 方向 = zh2en
  │    ├─ 与 headword 精确相等 → ✅ exact
  │    ├─ 命中变体表（-ise/-ize、-our/-or、连字符/空格、to 可选）→ ✅ variant
  │    ├─ 编辑距离 ≤ 阈值（≤4 字母 1，>4 字母 2）→ 🟡 near（Hard）
  │    └─ 否则 → ❌ Again
  │
  └─ 方向 = en2zh
       ├─ 答案包含任一词库义项（≥2 字）或义项包含答案 → ✅ local
       ├─ 命中 accepted_zh（人工/AI 曾认可）→ ✅ local
       ├─ 否则 → 调 DeepSeek 判语义等价
       │         ├─ equivalent=true, confidence≥0.6 → ✅ ai（并把答案写入 accepted_zh）
       │         ├─ equivalent=true, confidence<0.6 → 🟡 请用户确认
       │         └─ equivalent=false → ❌ ai
       └─ 无网络/超时 → 让用户自评（对/错），不阻塞复习
```

**AI 判分提示词要点**：
- 角色：英语老师，判断学生给出的中文释义是否与目标词在该语境下语义等价；
- 输入：`word`、`pos`、`reference_meanings`、`student_answer`；
- 输出严格 JSON：`{"equivalent":true,"confidence":0.92,"normalized":"放弃","reason":"..."}`；
- 明确「近义但程度/褒贬明显不同 → false」「只答出词性/造句 → false」「包含目标义项且无冲突 → true」；
- `thinking: disabled`，`temperature: 0`（判分不需要长思考，省钱省时）。

**省 token 的硬措施**：
1. 能本地命中就绝不调用 AI（预计 80%+ 的答案走本地）。
2. 判分结果永久缓存：键 = `item_id + 方向 + 归一化答案 + 义项哈希`；义项变了才失效。
3. 一次复习里多个未命中答案 **合并成一次请求**（最多 20 条），返回数组。
4. 系统提示词固定且短，命中 DeepSeek 上下文缓存（命中价约为未命中的 1/50）。
5. 设置页显示「本月 AI 调用 / token / 估算花费」，超预算可关掉 AI 判分（退化为自评）。

### 6.4 评分映射

| 情况 | Rating |
|---|---|
| 第一次即正确、用时 < 6s | Easy (4) |
| 正确 | Good (3) |
| 接近/提示后正确/用时很长 | Hard (2) |
| 错误、看答案 | Again (1) |

> 评分最终由 `ts-fsrs` 解释，我们只负责把「对/错/快/慢」映射成 1~4。

### 6.5 发音获取与缓存

请求顺序（可在设置里调换）：

1. 有道美音 `type=2` → 2. 有道英音 `type=1`（用户选英音时优先）→ 3. 百度 TTS → 4. dictionaryapi.dev → 5. 系统 `speechSynthesis`（不落盘）

- 下载后存 `media/tts/<sha1(word|accent|source)>.mp3`，数据库记 `pronunciations`。
- 并发 2、每次间隔 300ms、失败指数退避；导入后后台慢慢补，不阻塞。
- 命中缓存直接读本地文件，**零网络请求**。
- 单词含空格/撇号时正确 URL 编码；短语整句合成。
- 失效处理：接口 403/404/超时 → 标记该源失败 24h，换下一个源；全失败则按钮置灰并提示「可先用系统发音」。
- 合规提示：有道/百度是网页接口，非官方开放 API；仅个人学习使用、结果只存本地、不再分发。若日后失效，可切换到系统语音或自建 TTS。

### 6.6 音标为什么“看不到”

- `phonetic` 字段可以存（笔记里本来可能有），但：
  - 复习界面**默认不显示**（0.7 起口径：用户主动点「音标提示」才看，见下方说明）；
  - 笔记详情始终可见；
  - 没有导出功能，所以「导出默认剔除音标」暂时不适用。
- 这是产品约束，不是加密；目的只是避免“看音标反推拼写”。
- **2026-11-26 口径统一**：实现取「默认隐藏、可点开」而不是原文的「任何位置都不渲染」——点开是用户主动行为，比彻底封死更好用；三处文案（复习页、笔记详情提示、本文件）已按同一说法。

---

## 7. 调度系统

### 7.1 两条轨道

| | 长期轨道 | 听写冲刺轨道 |
|---|---|---|
| 目标 | 记得久 | 考试日写得出 |
| 保留率 | 0.90（可调 0.85~0.95） | 0.95（可调 0.90~0.97） |
| 间隔上限 | 365 天 | 不超过「距考试天数」 |
| 新卡/天 | 20（可调） | 由剩余天数与总量推算 |
| 触发 | 到期即复习 | 每日按计划 + 到期 |

**关键点：只有一份 FSRS 状态。** 冲刺复习也是真实复习，会写进 `reviews` 并更新同一张卡；考完后卡片回到长期轨道，因为冲刺期间 stability 已提高，后续间隔自然变长——这正好同时满足“应试”和“长期记忆”。

### 7.2 冲刺计划怎么算（不重写 FSRS）

对每张卡：

1. 用 `ts-fsrs` 的 `nextInterval(memoryState, r, ...)` **反查**：给定“距考试还有 d 天”，求出当前状态下若不复习，考试日的预测记忆率 `R_d`（二分/查表都通过库函数，不自己写遗忘曲线）。
2. 计算缺口 `gap = target − R_d`；`gap ≤ 0` 的卡不需要加练。
3. 估算“现在复习一次”能把考试日记忆率抬高多少（用 `scheduler.preview()` 模拟 Good 后的状态，再反查 `R_d'`）。
4. 按 `收益 / 预计耗时` 排序，在每日时间预算内贪心装入。

**每日任务 = 到期卡（FSRS 自然到期）∪ 计划加练卡**，去重后按「冲刺优先、逾期优先、产出方向优先」排序。

**时间预算**：用户设「每天 X 分钟」；单卡耗时用最近 20 次同类卡的平均值（新卡 ×2）。默认 20 分钟。

**来不及的判定**：
```
所需总时长 ≈ Σ 每张卡达到目标所需的复习次数 × 单次耗时
可用总时长 = Σ 每天预算（今天 ~ 考前一天）
若 所需 > 可用 → 显示：
  「按当前预算，预计 82% 的词能达到目标。建议每天 +8 分钟，或把范围缩小到 3 个单元。」
```

**边界情况**：
- 考试就是今天/明天：只做「高频错词 + 全部词速览」，不再排长期间隔；给出「考前 30 分钟速览」清单。
- 考试改期：计划整体重算（`exam_plan` 保留历史，不影响 FSRS 状态）。
- 新增笔记在考试范围内：立即纳入计划，从今天起分配。
- 词条标记为「仅认识」：只排 `en2zh`，不排 `zh2en`。

### 7.3 ts-fsrs 接入方式（已核实）

- 版本：v6，默认 **FSRS-7**，MIT。
- 初始化：
  ```ts
  // 仅示意 API，不是最终实现
  const scheduler = await DefaultScheduler({
    version: 'FSRS-7',
    desiredRetention: 0.9,
    enableShortTerm: true,
    learningSteps: ['1m', '10m'],
    relearningSteps: ['10m'],
    enableFuzz: true,
    maximumInterval: 365,
  })
  ```
- 新建卡：`scheduler.newCard({ now })`
- 复习：`scheduler.review({ card, grade, now })` → `{ card, revlog }`
- 预览：`scheduler.preview({ card, now })`（用于冲刺收益估算，不落库）
- 查间隔：`scheduler.nextInterval(memoryState, retention, {...})`
- 卡片快照原样存 `cards.fsrs_json`，升级版本时可回放 `reviews` 重建（`ts-fsrs/reschedule`）。
- 已复习 ≥ 1000 次后，可选做参数个性化：官方 `@open-spaced-repetition/binding`（WASM，无需 Python）。**第一版不做**。

> 明确边界：`ts-fsrs` 只算“这张卡下次什么时候到期”；“今天先学哪张、考试前怎么加练”是我们的调度策略层，不修改 FSRS 数学。

---

## 8. 提醒与后台

| 能力 | 实现 |
|---|---|
| 到点提醒 | Electron `Notification`（Windows 原生 toast） |
| 托盘 | `Tray` + 图标角标显示到期数；右键菜单：开始复习 / 听写冲刺 / 设置 / 退出 |
| 开机自启 | `app.setLoginItemSettings`，首次启动询问，默认关 |
| 默认提醒时间 | 12:30、19:30（可增删） |
| 免打扰 | 23:00–07:00 不弹，改为托盘红点 |
| 错过提醒 | 启动时若当天未复习，补一条「今天还有 N 张卡」 |
| 考前加强 | 距考试 ≤3 天，提醒文案带倒计时；≤1 天提醒「明天听写，建议过一遍错词」 |
| 点击行为 | 聚焦窗口 → 直接进入复习页 |
| 单实例 | `app.requestSingleInstanceLock()`，第二次启动只唤醒窗口 |

注意：Windows「专注助手/勿扰」可能吞掉通知，设置页给一句提示，并允许改用托盘闪烁。

---

## 9. 页面与交互

### 9.1 导入页
- 拖拽区（支持多文件、粘贴图片）；
- 左：原图/原文预览；右：结构化结果表格；
- 每行状态灯（✅ / 🟡 / ❌），可内联编辑；
- 顶部：笔记标题、上课日期、标签、来源类型；
- 底部：`AI 校验中…` → `发现 6 处需核对` → `确认入库`。

### 9.2 笔记库
- 列表/卡片两种视图；列：标题、日期、词条数、到期数、问题数；
- 搜索框（英文/中文，FTS）、标签筛选、时间排序；
- 详情：Markdown 渲染 + 词条表 + 发音按钮（音标默认隐藏）；
- 操作：编辑、重新校验、导出、归档、删除（二次确认）。

### 9.3 今日复习
- 顶部：到期数、新卡数、预计用时；
- 中部：卡片区（大字号、输入框、🔊）；
- 底部：进度条 + 快捷评分；
- 结束页：正确率、用时、今日新增到期预测、连续打卡。

### 9.4 听写冲刺
- 新建考试：日期（日期选择器）、范围（笔记/标签/全部）、级别（认识/听写/混合）、每日分钟、目标保留率；
- 主视图：倒计时、今日任务数、完成度环、覆盖率、预计考试日记忆率；
- 日历：每天计划量热力图；点某天看清单；
- 警告区：时间不够时给具体建议。

### 9.5 统计
- 复习热力图（近 12 周）；
- 记忆保持率曲线（按 FSRS 预测 vs 实际）；
- 到期预测（未来 30 天柱状图）；
- 难词榜（lapses 最多）、AI 花费。

### 9.6 设置
- DeepSeek API Key（密码框 + 测试连接 + 清除）；
- 长期保留率、每日新卡上限、学习步骤；
- 发音源顺序、口音偏好、缓存大小/清空；
- 提醒时间、开机自启、免打扰；
- 备份/恢复/导出（JSON、Markdown、CSV）；
- 危险区：清空数据。

---

## 10. DeepSeek 集成

### 10.1 已核实的能力（2026-11 官方文档）

| 项 | 值 |
|---|---|
| Base URL | `https://api.deepseek.com`（OpenAI 兼容） |
| 模型 | `deepseek-flash`（DeepSeek-V4.1-Flash-1017）、`deepseek-v4-pro` |
| 视觉 | **`deepseek-flash` 支持**（JPEG/PNG/GIF/WebP）；`v4-pro` 不支持 |
| 图片 token | 单图上限约 **1024 tokens**，按尺寸缩放 |
| 图片大小 | 单图 ≤ 32 MiB（base64/URL），请求体 ≤ 48 MiB |
| JSON 输出 | `response_format: {"type":"json_object"}`，提示词需含 “json” 并给示例 |
| 思考开关 | `{"thinking":{"type":"disabled"}}`（默认开启）；判分/校验建议关闭 |
| 上下文 | 1M；支持上下文硬盘缓存 |
| 价格（off-peak） | 输入 $0.15/M（缓存命中 $0.003/M），输出 $0.6/M；peak 翻倍 |

> 价格与模型名可能调整，以官网为准；代码里把模型名做成配置项。

### 10.2 四个调用点

| 场景 | 模型能力 | 频率 | 备注 |
|---|---|---|---|
| 图片 OCR | vision | 每张图 1 次 | 忠实转录，不纠错 |
| 结构化 | text + JSON | 规则失败时 | 输入原文，输出 items |
| 入库校验 | text + JSON | 每次导入 1 次/50 条 | 产出 issues |
| 语义判分 | text + JSON | 仅本地未命中 | 结果永久缓存 |

### 10.3 成本估算（按 off-peak 价，仅供感觉）

| 操作 | 估算 token | 估算费用 |
|---|---|---|
| 1 张图片 OCR | ~1.4k 入 / 0.8k 出 | ≈ $0.0007（约 0.005 元） |
| 100 条校验 | ~3k 入 / 0.8k 出 | ≈ $0.001（约 0.007 元） |
| 1 次 AI 判分 | ~0.3k 入 / 0.08k 出 | ≈ $0.0001（约 0.0007 元） |

正常一学期使用（几百张图、几千次判分）总成本通常在 **几元人民币** 量级。

### 10.4 客户端实现要点

- 使用官方 `openai` Node SDK 指向 DeepSeek（`baseURL` 可配），或直接 `fetch`；主进程发请求，避免 CORS。
- **短任务一律 `thinking: disabled`**（OCR / 结构化 / 校验 / 判分）；只有“整份笔记疑难校对”可选 `low` 思考强度，避免默认 high 带来的延迟与额外 token。
- 图片只能放在 `user` 消息里（放进 `system` 会 400）；请求体上限 48 MiB。
- 重试：429/5xx 指数退避（1s/3s/8s）；401 直接提示 Key 无效；超时 60s（OCR 120s）。
- JSON 解析失败：把原响应 + “只输出合法 JSON” 再请求一次；仍失败则降级并记录。
- 所有请求写 `ai_usage`；设置页可设「每月预算」，超了只允许本地判分。
- 隐私：导入的图片/文本会发送到 DeepSeek；首次使用弹一次说明，可在设置里查看「哪些内容会被上传」。

---

## 11. 安全、备份与可靠性

- **API Key**：`safeStorage.encryptString`（Windows DPAPI）存 `secrets.bin`；不写日志、不进数据库、不导出。
- **进程隔离**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；preload 只暴露白名单方法。
- **备份**：每天首次启动用 SQLite backup API 复制到 `backups/wordmemo-YYYYMMDD.db`，保留 7 份；导入前额外备份一次。
- **导出**：全量 JSON（含笔记/词条/复习历史）、Markdown（按笔记）、CSV（词表）。
- **迁移**：`user_version` + 顺序迁移脚本；迁移前自动备份。
- **崩溃恢复**：WAL + 事务；未完成导入回滚；启动时检查孤儿文件。
- **日志**：本地滚动日志（不含答案全文与 Key），设置页可导出用于排错。

---

## 12. 里程碑与验收

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| **M0 技术验证（半天）** | Electron 45 壳；`node:sqlite` 建表/读写/FTS5 探测；`ts-fsrs` 跑通建卡+复习；DeepSeek 视觉识别一张样图；有道/百度音频下载落盘 | 四件事在本机全部跑通，失败项有备选方案 |
| **M1 笔记库（1~2 天）** | 数据库与迁移、笔记 CRUD、手动新建、搜索/排序、标签 | 能录入 20 条词并检索、按日期排序 |
| **M2 导入（2~3 天）** | 图片 OCR、txt/md/docx/xlsx 解析、结构化、AI 校验、黄色标记、预览编辑、去重合并 | 5 种格式各 1 个样例全部入库；故意造 3 个错能标黄 |
| **M3 复习（2~3 天）** | 双/三方向卡片、ts-fsrs、输入判分、本地→AI 判分、发音缓存、禁音标 | 连续复习 3 天，间隔按 FSRS 变化；断网可复习已缓存词 |
| **M4 听写冲刺（2 天）** | 考试 CRUD、计划器、每日任务、覆盖率和“来不及”提示 | 设 7 天后考试，每天任务量 ≤ 预算且覆盖全部范围 |
| **M5 提醒与打磨（1~2 天）** | 托盘、通知、自启、免打扰、统计、设置、备份导出 | 到点弹窗；关窗后仍在托盘；重启数据不丢 |
| **M6 打包（1 天）** | electron-builder NSIS 安装包 + 便携版；图标；首次启动引导 | 在干净目录安装可用；不要求管理员权限 |

**总体验收（Definition of Done）**
1. 一张手写/印刷英语笔记照片 → 5 分钟内变成可复习词条（含人工核对）。
2. 设置听写日期后，每天打开就知道“今天背哪些”，不需要自己安排。
3. 考试结束后，这些词仍按长期间隔出现在复习里。
4. 复习界面永远看不到音标，但随时能听发音。
5. 中文答案不同但意思对时，不判错；常见答案不花 token。
6. 断网时：已导入的笔记可复习、已缓存发音可播放；未缓存发音与 AI 判分给出明确提示。

---

## 13. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| DeepSeek 视觉对手写体识别率一般 | 转录错误多 | 两阶段（先转录后结构化）+ 原图对照 + 黄色标记强制核对；必要时接 PaddleOCR 做第二意见 |
| 有道/百度发音接口非官方、可能失效/限流 | 播放失败 | 三级回退 + 本地缓存 + 系统语音兜底；接口地址做成配置 |
| `node:sqlite` 未启用 FTS5 或 API 有坑 | 搜索受限/开发受阻 | M0 探测；失败切 `better-sqlite3`（仓储层隔离，改动 <1 天） |
| FSRS 参数不适合个人 | 间隔偏长/偏短 | 先用默认 FSRS-7；≥1000 次复习后接官方 optimizer；保留“重置学习进度” |
| 冲刺计划把卡片间隔压得太短 | 考后复习变密 | 冲刺只对“缺口 > 0”的卡加练；考后按自然到期走，不额外补偿 |
| AI 判分误判 | 学习数据被污染 | 低置信度让用户确认；可撤销评分；`judge_by` 记录来源便于排查 |
| 通知被系统勿扰拦截 | 错过复习 | 托盘红点 + 启动补提醒 + 设置页提示 |
| 数据丢失 | 无法恢复 | 每日备份 + 导入前备份 + 一键导出 |

---

## 14. 明确不做（第一版）

- 不做手机 App / 云同步 / 多用户；
- 不做 PDF（你没提；需要时加 `pdfjs-dist` 或 markitdown）；
- 不做语音识别（跟读打分），只做“听发音 → 写单词”；
- 不做语法问答/作文批改；
- 不做 AI 自动生成释义（避免污染老师原意）；
- 不做 FSRS 参数在线训练（留到数据足够后）；
- 不内置词典数据（发音按需抓取 + 缓存）。

### 14.1 2026-11-25 复核后补充的「明确不做」

第一版设计里的这些想法，逐条复核后决定不做（理由随条目）：

- **全量导出（JSON / Markdown / CSV）与「危险区 → 清空数据」**：备份 + 加密快照已经覆盖「带走/换机」，清空数据直接删 `%APPDATA%\WordMemo` 更安全（少一条误删路径）。
- **首次使用的隐私弹窗**：供应商是用户自己选的，导入的内容会发给谁由他决定；README 与设置页已写明「哪些内容不上传」。
- **笔记库「列表 / 卡片」两种视图**：列表已经够密够快，两种视图是纯维护成本。
- **冲刺页日历热力图**：按天列表已经能回答「今天背哪些」。
- **记忆保持率曲线（FSRS 预测 vs 实际）**：单个 30 天保持率足够指导决策，曲线的解读成本高于收益。
- **「双向进度」开关（独立 / 共用）**：共用进度会让「这个词到底学没学会」无法解释，且要改建卡与调度（动数据模型）。
- **一次复习多卡合批判分（≤20 条一次请求）**：判分频次不高，费用本来在「几元一学期」量级。
- **一次拖多张图合并成一份笔记**：现在是每个文件一份草稿，手动合并不难，合并 UI 更麻烦。
- **FTS5 全文索引**：数据量在 1 万条以内，`LIKE` 够用（真慢了再说）。
- **笔记「导出 / 归档」**：见上，导出不做；`notes.status` 字段留着，但没有归档入口。
- **有 `error` 时必须勾选「我已核对」才能入库 + 列表黄色角标**：现在是一行提示 + 入库按钮照常可用，误入库的概率低，加门槛反而拖慢正常流程。
- **同形词「合并 / 作为新词条」二选一**：要动词条唯一索引（数据模型），同形不同义很少，代价远高于收益。
- **错过提醒后补发通知**：补发通知的打扰性大于收益；托盘 tooltip 已经写着「今天还有 N 张卡」。

> 2026-11-25 的决策过程记在 [BACKLOG.md](BACKLOG.md)，执行计划见 [PLAN-0.7.md](PLAN-0.7.md)。

---

## 15. 需要你拍板的 3 件事

1. **形态**：Electron 桌面应用（推荐，有托盘/弹窗/自启） vs 本地网页（更轻，但弹窗依赖后台进程）？
2. **听写方向**：是否要第三张「只听发音写单词」的卡？（推荐要，最贴近老师报听写）
3. **发音源**：接受有道/百度网页接口（免费、音质好、但非官方、可能失效）吗？还是只用系统语音 + 免费词典 API（更稳但音质一般）？

---

## 16. 实现记录（2026-11-02）

方案已落地为可运行代码，与原计划的差异如下。

### 16.1 技术栈微调

| 项 | 计划 | 实际 | 原因 |
|---|---|---|---|
| Electron | 45.x（Node 24） | **38.8.6**（Chromium 140 / Node 22.22） | 45 与 38 在本机都需要 `--no-sandbox`（沙箱初始化失败）；38 更保守，且 `ts-fsrs` 在 Node 22.22 下实测可用 |
| SQLite | `node:sqlite` | `node:sqlite` + `createRequire` 垫片 | Node 的 `builtinModules` 尚未包含 `sqlite`，Vite 会把它误解析成裸模块 `sqlite` |
| 运行形态 | 仅 Electron | **仅 Electron**（浏览器版曾作为排查期的临时方案，已移除） | 临时用 Edge 应用窗口验证过，但用户只需要 Electron |
| 图表 | Recharts | 手写 CSS/SVG | 数据量小，少一个依赖 |

### 16.2 Electron 崩溃的真实原因（已修正）

- 现象：`electron.exe` 启动即退出，事件日志 `APPCRASH 0xc0000005`，最小脚本也到不了 `app.whenReady()`。
- 误判：一开始怀疑极域学生端；结束 `StudentMain.exe` 后仍然崩溃。
- 定位：二分启动参数发现加 `--no-sandbox` 后一切正常，单实例锁、`node:sqlite`、`ts-fsrs` 都没有问题；又发现环境里存在 `ELECTRON_RUN_AS_NODE=1`，脚本继承后 Electron 会以 Node 模式运行，表现同样是“窗口一闪而过”。
- 结论：① Chromium 沙箱在当前 Windows 会话/安全软件组合下初始化失败，必须 `--no-sandbox`；② 启动器必须清除 `ELECTRON_RUN_AS_NODE`。极域不是直接原因。
- 处理：改为 `WordMemo.exe`（本地编译的 WinExe 启动器）直接拉起 `electron.exe` 并带 `--no-sandbox`，不再经过 VBS/CMD；浏览器版只用于排查期临时验证，已在收尾时移除。

### 16.3 已验证

- `npm run typecheck` 通过。
- `npm test`：10 项集成测试通过（解析、去重、三向卡、判分、FSRS、计划器、统计）。
- 真实 Electron 窗口端到端验证（通过调试端口执行）：导入 `samples/demo.txt` → 14 条词条 → 20 张卡 → 精确/本地判分 → FSRS 写回 → 7 天听写计划 → 有道发音 → 删除清理。
- 界面截图：复习、笔记库、导入、听写冲刺、统计、设置六个页面均正常渲染。

### 16.4 尚未做

- 未接真实 DeepSeek Key 做 OCR/校验的线上验证（接口、提示词、缓存逻辑已实现，等待 Key）。
- 未打 Windows 安装包（`npm run dist` 可打；安装后的快捷方式需要自行补 `--no-sandbox`）。

### 16.5 收尾：移除浏览器版（2026-11-02）

按用户要求只保留 Electron，删除：

- `src/server/`（本地 HTTP 服务）
- `src/renderer/src/http-api.ts`、`mock-api.ts`
- `vite.renderer.config.ts`、`out/web`、`out/server`
- `启动 WordMemo（浏览器版）.vbs/.bat`
- `package.json` 里的 `build:web` / `start:web` 与 `esbuild` 直接依赖
- Web 专用的 `parseUpload` IPC 与导入页上传分支

数据目录仍为 `.data/`（开发）或 `%APPDATA%/WordMemo/`（打包），不影响已有词库。

### 16.6 今日任务改为「先学习、再复习」（2026-11-02）

原实现把新卡直接混进复习队列，用户一进今日复习就是测验，不符合“学习新笔记 + 复习旧笔记”的定位。调整：

- `items.learned_at`：词条是否已经过学习阶段；新导入为 NULL。
- `cards.needs_check` / `cards.learn_mark`：学完后卡片进入“待首次检测”，`learn_mark` 记录用户选的是“记住了”还是“还不熟”（不熟的排前面）。
- 每日上限 `newPerDay` 改为按**词条**计数，不再按卡片；学习阶段先展示词义、例句和发音，用户点按钮后只写 `learned_at`，不伪造 FSRS 评分。
- 复习队列改为：`needs_check = 1` 的卡优先，加上到期卡和学习步骤中的卡；第一次测验才真正写入 FSRS。
- 今日任务页新增总览（待学习 / 待复习）、学习卡片、学习完成页；导入成功后直接跳到今日任务，不再跳笔记库。
- 旧库迁移：已有 `reps > 0` 的词条标记为已学，没复习过的词条进入学习队列。

### 16.7 启动方式改为本地 exe 启动器（2026-11-02）

VBS → CMD → Electron 的脚本链启动慢，`.lnk` 还会触发“来自 Internet 的文件”安全警告。最终改为：

- `scripts/Launcher.cs` 编译成 `WordMemo.exe`（.NET WinExe，无控制台），直接启动 `electron.exe`，参数 `"<项目目录>" --no-sandbox`，并清除 `ELECTRON_RUN_AS_NODE`。
- 图标使用 `build/icon.ico`；`scripts/build-launcher.cmd` 可重新编译。
- 删除 VBS、BAT 启动链、`WordMemo.lnk` 和 `scripts/launch-electron.cmd`。
- 保留 `调试启动（控制台）.bat`，用于排查启动错误（清环境变量、保留输出并暂停）。
- `scripts/gen-icon.mjs` 额外生成 `build/icon.ico`（256 + 32 两张 PNG 打包）。

### 16.8 搜索、卡片信息与建议采纳（2026-11-02）

- 笔记库搜索：后端本来就会搜 `items.headword/meanings`，但界面只显示笔记卡片。现在搜索时增加“匹配的词条”区块，可直接看到命中的单词和释义。
- 词条新增 `collocations`：导入时由 AI 补充 2~3 个常用搭配和 1 个例句（分批 20 条）；已有笔记可在详情里点「AI 补充搭配」补全。
- 卡片信息：学习页和测验答案页展示固定搭配与例句；测验题目仍然只考单词/释义。
- 多词性：`pos` 支持 `"n. / v."` 形式，解析器、AI 结构化提示词和展示均已适配。
- AI 校验建议：提示词要求 `suggestion` 只给最终值；界面再用 `cleanSuggestion()` 去掉“补充：/改为：”等前缀，并按词性重新归一化，避免把“补充”写进词性。

### 16.9 中文语义搜索（2026-11-02）

本地搜索只能命中字面相同的释义。补充一层轻量 AI 扩展：

- 先按原词搜 `items` / `notes`；只有“中文查询且没有命中任何词条”时才调用 AI。
- 只把查询词发给 AI，让它返回 3~5 个最常见英文对应词（如“允许” → allow / permit / let / authorize），不发送词库内容。
- 再用这些英文词在本地检索并合并结果；命中则返回，AI 不参与遍历。
- 不设置 `cacheKey`，不写 `ai_cache`，避免用户换一个同义表达后拿到过期结果。
- 界面显示「AI 语义扩展：...」，并注明只发送了查询词。
- 已验证：搜“允许” → AI 扩展并找到 permit；搜“评估” → 本地命中，`aiUsed=false`。

### 16.10 参考 Anki / Word_Memorizer 优化复习队列（2026-11-02）

参考 `D:\soft\Word_Memorizer`（Python + PyQt6 + py-fsrs）和 Anki 的做法，调整：

- **同词条卡片 bury**：`oneCardPerItem()` 对每个词条只随机抽一张方向卡；其余方向仍保留在库里，下次会话再抽，避免一个词连续刷三种题型。
- **队列排序**：刚学完待检测的新卡优先，其余按 `retrievabilityNow()` 预测遗忘概率从高到低排；学习阶段选「还不熟」的词排在同组前面。
- **计数去重**：今日到期/托盘角标按词条 `COUNT(DISTINCT item_id)` 统计，不再把三张卡算成三个任务。
- **学习步骤**：保留 ts-fsrs 的学习步骤；参考项目用「轮内巩固」替代分钟级步骤，这一点暂未照搬，后续可加“答错后隔 4 个词重现”。
- 没有引入 Anki 本体或 py-fsrs：调度仍用 `ts-fsrs`（与 Anki 同一套 FSRS），只借鉴 sibling bury、遗忘概率排序等成熟交互策略。

### 16.11 按 Anki 的 learn ahead / sibling bury 重做复习批次（2026-11-04）

FSRS 的分钟级学习步骤会让答错的卡在 1 分钟后再次到期。之前用“当天过滤 + 固定隔 4 张补练”的临时方案，能消除第二批，但不符合 Anki 的调度模型。现在改为：

- **learn ahead**：`dueQueue()` 只纳入两类卡：复习卡 `state=2` 且已到期；学习卡 `state=1/3` 且 `due_at <= now + learnAheadMinutes`（默认 20 分钟）。更久以后到期的学习卡不再进入今天的队列。
- **本轮内提前学习**：`Review.finishCard()` 收到 `state=1/3` 且 `dueAt` 在 learn ahead 窗口内时，把同一张卡追加到本轮队列末尾；不再固定隔 4 张，也不设固定补练次数。答对后毕业，答错会在 1 分钟后再次出现。
- **sibling bury**：`cards.buried_until` 新增字段。一个词条的一张卡复习后，其他方向写入 `buried_until = 今天`，今天不再出现；第二天自动恢复。`cardsInScope`、统计和队列都排除当天 buried 的卡。
- **设置**：新增 `learnAheadMinutes`，设置页可调，默认 20 分钟，对应 Anki 的 Learn ahead limit。
- 这套模型和之前 `Word_Memorizer` 的“轮内巩固”相比，保留了 FSRS/Anki 的 1m/10m 学习步骤，同时用 learn ahead 解决“做完一轮又出现第二批”的问题。
- 参考：[Anki Deck Options](https://docs.ankiweb.net/deck-options.html)、[Anki Studying](https://docs.ankiweb.net/studying.html)。

### 16.12 学习阶段显示音标并提前预取（2026-11-04）

- 学习卡片在单词下方显示音标，帮助建立正确的发音习惯。
- 加载今日任务后，后台用 3 个并发调用 `items:ensurePhonetic`，把当天新词的音标提前查好并写回 `items.phonetic`；学习时通常已就绪。
- 当前卡片优先查一次，避免用户快速点到后面的词时一直显示“查询中”。
- 查不到时显示“暂无音标”；短语（`pave the way for`）通常没有单词级音标，属于正常情况。
- 音标来源仍是 Free Dictionary API → 有道 JSON 回退，成功才缓存。

### 16.13 音标显示把 ɹ 换成 r（2026-11-04）

- IPA 里表示英语 r 的符号是 `ɹ`（turned r），不是乱码；但很多学习词典直接写 `r`。
- 新增 `displayPhonetic()`，只在展示时把 `ɹ` 换成 `r`，底层数据库仍保存规范 IPA。
- 学习卡、复习提示、词条详情统一使用这个展示函数；`clarify` 显示为 `/ˈklærɪfaɪ/`。

### 16.14 AI 判分区分“另一义项”和拼写错误（2026-11-04）

用户答 `clear → 清澈的`，词条只存了“清醒的”，旧逻辑会判错。现在：

- `JUDGE_SYSTEM` 改为三分类：`same` / `alternative` / `different`。
  - `alternative`：单词本身确实有学生写的这个常见义项，但词条没收录。
- `JudgeResult.alternative`：黄色反馈「这个意思也对 / 跳出舒适圈」，不是红色错误；显示“本词条记的是……”，建议补充释义。
- 交互：黄色状态下可「意思对，继续（Hard）」或「算错（Again）」，不会直接判错。
- 缓存 key 升级为 `judge-v2`，避免复用旧的二分类结果。
- 「中→英」「听→写」删除 `nearEnglish` 二次确认：拼写错误直接红色判错，只留一个“下一张”，不再打断节奏。
- 实测：`clear / 清澈的` → `correct=false, alternative=true, confidence=0.9`；`A controdicts B` → 直接 `correct=false`。

### 16.15 单词级去重与旧数据合并（2026-11-05）

问题：`ux_items` 唯一键是 `(headword_norm, pos, kind)`，`resemble` 被两份笔记识别成 `phrase` 和 `word`，`nudge` 被识别成 `v.` 和 `n.`，于是同一个词建了两条，学习队列出现两次。

- `upsertItem` / `findExistingItemId` 改为只按 `headword_norm` 查重；合并词性（`v. / n.`）、释义、搭配、例句、accepted_zh、音标。
- 导入阶段 `heuristicExtract` / `mergeItems` 也按 headword 合并，同一份笔记里的不同词性不会生成两行。
- 新增 `dedupeItems()` 启动迁移：按 headword 合并旧数据，迁移 `note_items`，合并同方向卡片并迁移 reviews，保留学习进度。
- 删除旧的三元唯一索引 `ux_items`，新增 `ux_items_headword_norm` 唯一索引。
- 真实库迁移验证：`resemble` 合并为一条（`v.`, `word`, 释义三项），`nudge` 合并为 `v. / n.`；重复数归零，卡片 3 张、两条笔记关联都在。
- 迁移前已备份到 `.data-manual-backup-20261105-083215`。

### 16.16 下一阶段：四个新功能的独立计划（2026-11-17 起草，11-18 增补）

开源前要补的四个能力，已各自拆成独立计划，按「一次只做一个、做完即冻结」推进：

| 顺序 | 功能 | 文档 | 工期 | 风险 |
|---|---|---|---|---|
| 1 | 多供应商（DeepSeek / OpenAI / Gemini / GLM；模型名与价格自动刷新） | [PLAN-PROVIDERS.md](PLAN-PROVIDERS.md) | 3~4 天 | 低（不改数据结构） |
| 2 | 多个库（Deck + 批量移动/复制） | [PLAN-DECKS.md](PLAN-DECKS.md) | 3~4 天 | 中（改 schema 与查询作用域） |
| 3 | 便携版 + 启动器自更新（不签名） | [PLAN-UPDATE.md](PLAN-UPDATE.md) | 4~5 天 | 中（换目录与 `--no-sandbox` 兼容） |
| 4 | 云端同步（GitHub 私有仓库 + 端到端加密） | [PLAN-SYNC.md](PLAN-SYNC.md) | 8~12 天 | 高（唯一改数据模型） |

排序、共同约束、交叉影响与需要拍板的事项见 [PLAN-NEXT.md](PLAN-NEXT.md)；四个功能能借的开源项目（含 DSH 拆包结论）见 [RESEARCH-REUSE.md](RESEARCH-REUSE.md)。

其中一条已确认的实现缺陷，做这四个功能时顺手修掉：`openDb()`（`src/main/db/connection.ts:17`）内部就会执行迁移，而 `dailyBackup()`（`src/main/index.ts:308`）在其之后才跑，导致「升级后首次启动迁移失败」时手边没有迁移前备份。改为迁移前先复制 `backups/wordmemo-pre-migrate-v<N>-<时间>.db`。





