# GitHub 开源选型清单

> 调研时间：2026-11-02　数据来源：GitHub API / 项目文档
> 原则：**能用成熟库就不自己写**；GPL/AGPL 项目只做参考，不复制代码。

---

## 1. 直接依赖（写进 `package.json`）

| 类别 | 项目 | 许可证 | 采用方式 | 说明 |
|---|---|---|---|---|
| 记忆算法 | [open-spaced-repetition/ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) | MIT | **核心依赖** | 官方 TS 实现，v6 默认 FSRS-7；提供 `DefaultScheduler`、`review/preview/nextInterval/reschedule`，另有 WASM 参数优化器 |
| 桌面壳 | [electron/electron](https://github.com/electron/electron) | MIT | 核心依赖 | 采用 **v38.8.6**（Chromium 140 / Node 22.22）：本机 Chromium 沙箱初始化失败，启动时必须加 `--no-sandbox`；v38 更保守，`ts-fsrs` 在 Node 22.22 下实测可用。托盘/通知/自启/单实例齐全 |
| SQLite | Node 内置 [`node:sqlite`](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) | MIT | 首选 | Node 24 已 RC，零原生编译；支持事务、备份、序列化 |
| SQLite（备选） | [WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT | 备选 | 若内置版缺 FTS5 或 API 不够，切换此库；同步 API 与内置版接近 |
| 前端框架 | [facebook/react](https://github.com/facebook/react) | MIT | 核心依赖 | React 19 |
| 构建 | [vitejs/vite](https://github.com/vitejs/vite) | MIT | 核心依赖 | 配合 electron-vite |
| 样式 | [tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) | MIT | 核心依赖 | 原子化 CSS |
| 组件 | [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | MIT | 复制组件源码 | 基于 Radix，无运行时锁定 |
| docx 解析 | [mwilliamson/mammoth.js](https://github.com/mwilliamson/mammoth.js) | BSD-2-Clause | 核心依赖 | `.docx → HTML`，表格/加粗/列表保留完整 |
| xlsx 解析 | [exceljs/exceljs](https://github.com/exceljs/exceljs) | MIT | 核心依赖 | 读单元格、合并单元格、多 sheet |
| HTML → Markdown | [mixmark-io/turndown](https://github.com/mixmark-io/turndown) | MIT | 核心依赖 | 把 mammoth 的 HTML 转成可编辑 Markdown |
| 编码检测 | [runk/node-chardet](https://github.com/runk/node-chardet) | MIT | 核心依赖 | 识别 GBK/UTF-8，处理国内 txt |
| 编码转换 | [ashtuchkin/iconv-lite](https://github.com/ashtuchkin/iconv-lite) | MIT | 核心依赖 | GBK → UTF-8 |
| Markdown 编辑 | [uiwjs/react-md-editor](https://github.com/uiwjs/react-md-editor) | MIT | 核心依赖 | 分栏编辑 + 预览，省掉造编辑器 |
| Markdown 渲染 | [remarkjs/react-markdown](https://github.com/remarkjs/react-markdown) | MIT | 核心依赖 | 安全渲染笔记正文 |
| 图表 | [recharts/recharts](https://github.com/recharts/recharts) | MIT | 核心依赖 | 热力图/到期预测/保持率曲线 |
| 日期 | [iamkun/dayjs](https://github.com/iamkun/dayjs) | MIT | 核心依赖 | 轻量日期计算与格式化 |
| AI SDK | [openai/openai-node](https://github.com/openai/openai-node) | Apache-2.0 | 可选 | 指向 `https://api.deepseek.com` 即可；也可直接用 `fetch` 减依赖 |
| 测试 | [vitest-dev/vitest](https://github.com/vitest-dev/vitest) | MIT | 开发依赖 | 归一化/判分/计划器单测 |
| 打包 | [electron-userland/electron-builder](https://github.com/electron-userland/electron-builder) | MIT | 开发依赖 | NSIS 安装包 + 便携版 |

---

## 2. 备选 / 仅在需要时接入

| 类别 | 项目 | 许可证 | 什么时候用 |
|---|---|---|---|
| 本地 OCR | [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | Apache-2.0 | DeepSeek 视觉对某类图片效果差时，做第二意见（需 Python 环境，重） |
| 轻量 OCR | [RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR) | Apache-2.0 | 同上，但 ONNX 推理，部署更轻 |
| 文档 OCR 模型 | [deepseek-ai/DeepSeek-OCR](https://github.com/deepseek-ai/DeepSeek-OCR) | MIT | 想完全离线时；需 GPU/较大显存，第一版不用 |
| 文档 → Markdown | [microsoft/markitdown](https://github.com/microsoft/markitdown) | MIT | 未来支持 PDF/PPT 时的参考实现（Python，不直接依赖） |
| 旧版 Excel | [SheetJS/sheetjs](https://github.com/SheetJS/sheetjs) | Apache-2.0 | 需要 `.xls` 时；注意 npm 版本较旧，官方建议用其 CDN 包 |
| 词典音频 | [meetDeveloper/freeDictionaryAPI](https://github.com/meetDeveloper/freeDictionaryAPI) | GPL-3.0（服务端） | 仅通过 HTTP 调用其公开接口，不链接代码；作为第三发音源 |
| 参数优化 | [open-spaced-repetition/fsrs-optimizer](https://github.com/open-spaced-repetition/fsrs-optimizer) | BSD-3-Clause | 复习记录足够多后训练个人 FSRS 权重（Python） |
| 参数优化（TS） | `@open-spaced-repetition/binding`（ts-fsrs 文档内） | MIT | 同上，WASM，可在 Electron 内跑，无需 Python |
| 算法参考 | [open-spaced-repetition/fsrs-rs](https://github.com/open-spaced-repetition/fsrs-rs) | BSD-3-Clause | 读实现细节/边界条件，不直接调用 |

---

## 3. 只做参考、不采用（重要）

| 项目 | 许可证 | 为什么不用 |
|---|---|---|
| [ankitects/anki](https://github.com/ankitects/anki) | AGPL-3.0 | 功能极全但架构重（Rust + Python + Qt）；AGPL 不适合闭源分发。可参考其 FSRS 集成、学习步骤、4 点跨日逻辑 |
| [RealKai42/qwerty-learner](https://github.com/RealKai42/qwerty-learner) | GPL-3.0 | 主打键盘打字练习，没有 FSRS、没有笔记导入、没有听写日期规划；GPL 代码不能直接抄。可参考其打字交互与发音按钮 |
| [open-spaced-repetition/py-fsrs](https://github.com/open-spaced-repetition/py-fsrs) | MIT | 本项目全 TS，不引入 Python 运行时 |
| Anki 插件生态（如 FSRS Helper） | 各自不同 | 依赖 Anki 内部 API，无法复用 |

> **许可证纪律**：GPL/AGPL 项目只阅读思路；所有复制进项目的代码必须 MIT/BSD/Apache-2.0，并在 `NOTICE` 中列明。

---

## 4. 还需要自己写的“胶水”（无法直接找到现成轮子）

这些不是重复造轮子，而是本项目特有的业务逻辑，量都很小：

1. **导入编排**：把「图片/文档 → 文本 → 结构化」串起来，并保留原文对照。
2. **结构化的提示词与 JSON 校验**：约束模型不得扩写、不得脑补。
3. **校验问题模型**：issue → 黄色标记 → 采纳/忽略，这套 UI 协议。
4. **判分路由**：本地命中 → 词库同义 → AI；以及结果缓存键设计。
5. **听写计划器**：用 `nextInterval` 反查记忆率 + 每日预算贪心分配（约 200~300 行）。
6. **发音三级回退与缓存队列**（约 150 行）。
7. **中文/英文归一化与变体表**（约 100 行）。
8. **双轨道共存策略**：冲刺复习写回同一张 FSRS 卡。

---

## 5. 选型结论（一句话版）

- **算法**：`ts-fsrs`，一行公式都不自己写。
- **数据库**：SQLite，优先 Node 内置 `node:sqlite`，`better-sqlite3` 兜底。
- **识别**：DeepSeek `deepseek-flash` 视觉，不装本地模型。
- **解析**：mammoth + ExcelJS + chardet/iconv-lite + turndown。
- **发音**：有道 → 百度 → dictionaryapi.dev → 系统语音，全部本地缓存。
- **界面**：Electron + React + Tailwind + shadcn/ui + Recharts。
- **不碰**：Anki / qwerty-learner 的代码（许可证与架构都不合适），只借交互灵感。

---

## 6. 关键数据核对记录

| 项目 | 核对内容 | 结果 |
|---|---|---|
| ts-fsrs | v6 默认 FSRS-7、`DefaultScheduler` 选项、`review/preview/nextInterval` | 官方文档确认 |
| Electron | v38.8.6 → Node 22.22.0 / Chromium 140；v45.2.1 → Node 24.22.1 / Chromium 156 | 官方 release 页确认；最终选 38，启动需 `--no-sandbox` |
| DeepSeek | `deepseek-flash` 支持视觉；单图 ≤1024 tokens；JSON 输出；thinking 开关 | 官方 API 文档确认 |
| 有道发音 | `dict.youdao.com/dictvoice?audio=hello&type=2` 返回 `audio/mpeg` | 实测 200 |
| 百度发音 | `fanyi.baidu.com/gettts?...` 返回 `audio/mpeg` | 实测 200 |
| dictionaryapi.dev | 返回 JSON，含 `phonetics[].audio` | 实测 200 |
| node:sqlite | Node 24 为 Release Candidate，`DatabaseSync` 可用 | 官方文档确认 |
