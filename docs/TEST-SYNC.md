# 同步手动测试指南（S2 + S3）

> 适用版本：`feat/sync` 分支（S3 完成后）　测试仓库：`DepthRecur/wordmemo-sync-test`
> 代码现状：**S0–S3 的代码已写完**，S4 只剩文档/发布准备；本指南做功能验收。
> 预计：主流程 10 分钟；双设备 15 分钟；设备管理/换密码 10 分钟；错误场景可选。

---

## 0. 这次测什么、不测什么

**测**（S2 + S3 范围）：

- 连接私有 GitHub 仓库（PAT、仓库校验、密码校验）；
- 首次同步把本机数据加密上传；
- 改数据后自动/手动推送，另一台设备拉到；
- `.wmsync` 加密快照导出、换一台「设备」导入合并；
- 设备列表、移除其它设备、更换同步密码；
- 错误场景：密码错、PAT 失效、文件损坏、公开仓库、设备被移除。

**不测**（还没做/产品边界）：

- 冲突弹窗（S3 只做自动合并，冲突按字段 LWW / 并集 / 删除优先静默处理）；
- 同步日志只展示最近 20 次，没有导出/筛选；
- 附件/图片同步（永久不做）；
- Gitee / 自建 Git 托管（结构上留了口子，界面只支持 GitHub）。

---

## 1. 准备

### 1.1 建 PAT（约 2 分钟）

GitHub → 右上头像 → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**：

- **Repository access**：Only select repositories → `DepthRecur/wordmemo-sync-test`
- **Permissions** → Repository permissions → **Contents: Read and write**
- 有效期按需（测试给 7 天即可）
- 生成后复制 `github_pat_...`（只显示一次）

> 用带 `repo` scope 的 classic token 也能跑，但界面按 fine-grained 写的；优先用 fine-grained。

### 1.2 选一个同步密码

- 至少 10 个字符；推荐点界面上的「帮我生成」，得到 5 个单词（如 `cobalt-tiger-lantern-vivid-otter`）。
- **抄下来**。忘了它，云上的数据谁也解不开（没有恢复密钥，这是产品决定）。

### 1.3 测试仓库当前是空的

`DepthRecur/wordmemo-sync-test` 已被清空。第一次连接会写入 `meta.json`（只含 salt 与口令校验值）。
如果之前自己连过、想换密码：去 GitHub 网页删掉仓库里的 `meta.json`（以及 `devices/` 目录）再连。

### 1.4 备份真实库（建议）

设置 → 高级与诊断 →「立即备份」，或先复制一份 `%APPDATA%\WordMemo\wordmemo.db`。
更稳妥的做法：**先用临时数据目录跑通主流程**（见 §4），再拿真实库测。

---

## 2. 主流程（10 分钟）

1. 启动应用：
   ```powershell
   cd D:\ymh\Code\tools\wordmemo
   npm run dev
   ```
2. 打开 **设置 → 同步**，填：
   - GitHub 仓库：`DepthRecur` / `wordmemo-sync-test`
   - PAT：§1.1 复制的
   - 同步密码：§1.2 的
   - 自动同步：先用「每 10 分钟」
3. 点 **「测试并首次同步」**。

   **预期**：
   - 提示「已连接，并完成第一次同步」；
   - 面板显示「已连接」、上次成功时间、待上传 `0 条`、本机设备名 + id 前 8 位；
   - GitHub 仓库里出现：
     - `meta.json`（**明文**，只有 `formatVersion / salt / kdfVerifier / createdAt / app`，没有单词/笔记）
     - `devices/<设备 id>/info.json.age`
     - `devices/<设备 id>/checkpoint.json.age`（**密文**）

   > 在 GitHub 网页上点开 `.age` 文件只会看到乱码——这是对的。验证「不给密码解不开」可以顺手看一下。

4. 回「笔记库」改一条笔记（比如改标题），等 30 秒左右（或回设置点「立即同步」）。

   **预期**：GitHub 里出现/更新 `devices/<id>/ops/<今天>.jsonl.age`；设置页待上传回 `0 条`；
   「上次成功」时间更新。

5. **导出加密快照**：设置 → 同步 →「导出加密快照」→ 存成 `测试.wmsync`。
   用记事本打开它：应该只有一行 `WORDMEMO-SYNC 1` 开头 + 乱码，**看不到标题/单词**。

6. **导入**（换一台「设备」）：关掉应用，用另一个数据目录启动（见 §3 的单机双实例），
   设置 → 同步 →「导入加密快照」→ 选刚才的 `.wmsync`。

   **预期**：提示「已导入并合并：笔记 N、词条 N、复习 N」；笔记库里能看到导进来的内容；
   若这台也连了同步，导入的数据会在 30 秒内被推上去。

---

## 3. 两台设备

### 3.1 单机双实例（不需要 VM，最快）

先 `npm run build`，然后开两个 PowerShell 窗口，各用一个数据目录：

```powershell
cd D:\ymh\Code\tools\wordmemo
$env:ELECTRON_RUN_AS_NODE = $null
$env:WORDMEMO_DATA_DIR = "$env:TEMP\wordmemo-device-a"
.\node_modules\electron\dist\electron.exe . --no-sandbox
```

```powershell
cd D:\ymh\Code\tools\wordmemo
$env:ELECTRON_RUN_AS_NODE = $null
$env:WORDMEMO_DATA_DIR = "$env:TEMP\wordmemo-device-b"
.\node_modules\electron\dist\electron.exe . --no-sandbox
```

两个实例都连 **同一仓库、同一密码**。然后：

1. A 里改一条笔记标题 → A 点「立即同步」；
2. B 点「立即同步」→ B 里看到 A 的改动；
3. B 里给同一个词条补一个释义 → B 同步；
4. A 同步 → A 里看到两个释义都在（并集）；
5. 各改各的字段（A 改标题、B 改标签）→ 都同步 → 两边的标题和标签都保留（字段级 LWW）。

> 单实例锁按 `WORDMEMO_DATA_DIR` 算，所以两个目录可以同时开；共用同一个目录会互相挡住。

### 3.2 VM（可选）

VM 里装同一个构建（或复制 `out/` + `node_modules` 后跑 `electron .`），数据目录独立，
连同一仓库同一密码。步骤同 §3.1。测完把结果/截图发我即可。

---

## 3.3 设备管理与换密码（S3，10 分钟）

在 §3.1 两个实例都连接成功的状态下：

1. **设备列表**：A 的设置 → 同步，应看到「本机」和另一台设备；B 里同样能看到 A。
2. **移除设备**：在 A 里点 B 那行的「移除」→ 确认。预期：
   - B 从列表消失（或标成「已移除」）；
   - GitHub 上 `devices/<B 的 id>/` 目录消失；
   - B 点「立即同步」→ 红色提示「这台设备已被移除同步，请重新连接一次」。
3. **换密码**：在 A 里展开「更换同步密码」→ 输入新密码两遍 → 确认。预期：
   - A 提示已更换；GitHub 上 `meta.json` 的 `salt/kdfVerifier` 变了；
   - A 的旧 op 分片被删（checkpoint 覆盖了历史，属正常压缩）；
   - B 用旧密码同步 → 「同步密码不对」；在 B 的设置里用**新密码**重新连接 → 能接上并继续同步。
4. **换回来**：再换回原来的密码（步骤同上），避免下次测试还要记新密码。

> 换密码会删除其它设备的旧密文（旧密码加密、换完谁也读不了），所以 B 必须重新连接一次；这是设计行为。

## 4. 错误场景（可选，但建议至少试 1、2）

| # | 操作 | 预期 |
|---|---|---|
| 1 | 连接时故意输错密码 | 红色提示「同步密码不对」，**不会**在仓库里新建数据 |
| 2 | 去 GitHub 撤销 PAT（或换一个没权限的 token）后点「立即同步」 | 红色提示「PAT 无效或已过期」/「没有权限访问这个仓库」；本地数据不动 |
| 3 | 把仓库里某个 `.age` 文件内容改坏，再同步 | 红色提示「同步密码不对，或者文件已经损坏」；不会崩 |
| 4 | 拔网线/断网后同步 | 提示网络错误；恢复后点「立即同步」能补上（自动模式会按 1/5/15/60 分钟退避重试） |
| 5 | 用一个公开仓库连接 | 直接拒绝：「这个仓库是公开的」 |
| 6 | 断开连接 → 再连同一仓库同一密码 | 能接上，数据还在；本机 PAT/密码被重新保存 |
| 7 | 在 A 移除 B 后，B 同步 | 「这台设备已被移除同步，请重新连接一次」 |
| 8 | A 换密码后 B 用旧密码同步 | 「同步密码不对」；用新密码重新连接可恢复 |

---

## 5. 自动测试（不用手动点）

```powershell
cd D:\ymh\Code\tools\wordmemo
npm run typecheck          # 0 错误
npm test                   # 32 文件 / 270 项通过（+2 份手动测试跳过）
npm run build              # 通过
```

真实仓库 e2e（会写入 `wordmemo-sync-test`，用固定测试口令 `wordmemo-sync-e2e-passphrase`）：

```powershell
# 需要本机凭据管理器里有 GitHub token；脚本不会打印 token
powershell -NoProfile -ExecutionPolicy Bypass -File .data\sync-e2e.ps1
```

> 跑完 e2e 后仓库里会有测试数据。要清空：GitHub 网页删除 `meta.json` 与 `devices/`，
> 或跑本机的 `.data\gh-clean-repo.ps1`（仅本机脚本，已 gitignore）。
> **注意**：e2e 用的密码和你手动测试的密码不同；混用会报「同步密码不对」。

---

## 6. 出问题怎么报

请带上：

1. 哪一步、期望什么、实际什么（截图最好）；
2. 设置页同步面板的状态文字（红色错误文案）；
3. 日志：
   - `npm run dev`：项目内 `.data\diagnostics.log`
   - 构建版：`%APPDATA%\WordMemo\diagnostics.log`
   - 自定义 `WORDMEMO_DATA_DIR`：该目录下的 `diagnostics.log`
4. GitHub 仓库里 `devices/<id>/` 的文件列表（不用发内容）。

**不要**把 PAT 或同步密码贴出来。

---

## 7. 验收清单（可勾选）

- [ ] 连接成功，仓库出现 `meta.json` + `devices/<id>/{info,checkpoint}.json.age`
- [ ] `meta.json` 里没有单词/笔记；`.age` 是密文
- [ ] 改笔记后自动/手动同步，`ops/<今天>.jsonl.age` 更新，待上传归零
- [ ] 导出 `.wmsync`，文件里看不到明文内容
- [ ] 另一台「设备」导入后数据出现，且重复导入不产生重复数据
- [ ] 两台设备双向改不同字段，内容都保留
- [ ] 设备列表能看到两台；移除 B 后 B 同步被拒绝
- [ ] A 换密码后 B 用新密码能重新连上；旧 op 分片被压缩
- [ ] 错误场景至少试过 1（密码错）和 2（PAT 失效），提示是红色且不崩
- [ ] 退出应用再启动：连接还在，能继续同步（`safeStorage` 记住了密钥）

全部通过 = S2 验收通过，可以进 S3（冲突与设备管理）。有失败项就把 §6 的信息发我。
