# OCR 实验台

用来量化「图片 → 转录文本」这一步的准确率，避免凭感觉改提示词。

## 结论（2026-11 实测，样本：`D:\ymh\Code\output_images` 6 张手写笔记）

| 方案 | 1102-1（左右两栏） | 1102-2（单栏） | 稳定性 |
| --- | --- | --- | --- |
| 旧提示词（逐行 Markdown） | 82.1% 词条召回 | — | 同一提示词 3 次：82% / 80% / 80%，左右栏经常被拼成一行 |
| 新提示词，不给栏号 | 80~98% | 100% | 同一提示词 3 次：96% / 98% / 82%，会随机退回「左右串行」 |
| **新提示词 + 行首栏号 + 客户端按栏重排** | **94.6%~98.2%** | **100%** | 3 次结果一致，阅读顺序由代码保证 |

另外实测：整页 1440×2035 的图片在模型侧只占 **约 1010 个视觉 token**（单图上限约 1024），
一张 A4 手写页被压到 1000 token 左右，是字迹很淡时认错的硬上限；分成 2 栏各占 1/2 面积时单栏约 600 token。

把整页裁成左右两栏再识别确实还能再高一点（96.4% 对 94.6%），但那只对「这次恰好是左右两栏」成立：
单栏、上下分块、三栏都会被裁坏，所以最终没有采用裁图方案，改为「模型标栏号 + 客户端排序」。
（`prep.py` 里的 `--mode col/cols/halves` 仍保留，供以后确认真实版面后再启用。）

## 目录

- `prep.py`：纸张裁边、找栏间空白、切片、增强放大（实验用，当前产品代码不依赖它）
- `label.mjs`：**当前采用的方案**——行首栏号 → `normalizeOcrText` 重排
- `verify-layout.mjs`：`src/shared/ocrLayout.ts` 的单元验证（7 项）
- `verify-extract.mjs`：真实 `extract.ts` 的端到端验证（重排 + 一行双词条拆分）
- `verify-e2e.mjs`：真实 OCR 结果 → 重排 → 抽词条 → 对真值打分
- `eval.mjs`：词条召回 / 释义准确率打分（真值在 `gt/*.tsv`）
- `ocr.mjs` / `multi.mjs` / `cols.mjs` / `ab.mjs`：历史 A/B 方案（整页、多图、分栏裁图、提示词对比）
- `env.ps1`：从本机 `Local State` + `secrets.bin` 解出 Key 放进 `$env:DEEPSEEK_KEY`（不打印明文）
- `tokens.mjs`：量一张图占多少视觉 token

## 跑法

```powershell
# 1) 解出 Key（只在本机内存里）
Invoke-Expression (Get-Content .\scripts\ocr-lab\env.ps1 -Raw)

# 2) 真实图片 → 带栏号的转录，跑 3 次看稳定性
node scripts\ocr-lab\label.mjs scripts\ocr-lab\runs\1102-2\page scripts\ocr-lab\gt\1102-2.tsv --runs=3

# 3) 真实 OCR 结果 → 词条 → 打分
node scripts\ocr-lab\verify-e2e.mjs scripts\ocr-lab\runs\_v2page\label-raw-1.md scripts\ocr-lab\gt\1102-1.tsv

# 4) 纯逻辑验证（不需要 Key）
node scripts\ocr-lab\verify-layout.mjs
node scripts\ocr-lab\verify-extract.mjs
```

`runs/<名字>/page/manifest.json` 需要先用 `prep.py` 生成（`--mode page` 即整页增强图）。

## 真值

`gt/1102-1.tsv`、`gt/1102-2.tsv` 是人工逐行抄写的 `英文<TAB>中文`。
只有这两张图有真值；其余图片（1102-3、1104-1、1104-2）只做人工抽查，不参与打分。
