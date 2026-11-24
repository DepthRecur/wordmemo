# WordMemo 同步测试包（0.6.0）

这个包用来验收 **0.6.0 的同步功能**（S2 + S3）：连接私有 GitHub 仓库、加密上传、两台设备合并、
设备管理、换密码、以及错误提示。**不连接同步时，应用行为和 0.5.1 一样。**

## 包里有什么

| 文件 | 用途 |
|---|---|
| `README.md` | 本文件：怎么用这个包 |
| `TEST-SYNC.md` | 完整体验步骤、预期结果、错误场景（主文档） |
| `checklist.md` | 可勾选的验收清单（建议边测边填） |
| `report-template.md` | 发现问题时按这个模板回报 |
| `start-two-devices.ps1` | 本机开两个实例（各用一个临时数据目录），不用 VM |
| `launch-device.ps1` | 单个实例的启动器（被上面那个脚本调用） |
| `run-checks.ps1` | 一键跑 typecheck / test / build，结果写文件 |
| `reset-local-test-data.ps1` | 清掉本机两个测试实例的数据 |
| `WordMemo-0.6.0-portable.zip` | 便携版应用（VM / 另一台机器用） |

> 包里**不含** PAT、同步密码或任何用户数据。

## 开始前准备

1. **备份真实数据**：设置 → 高级与诊断 →「立即备份」。第一次测建议用临时数据目录（见下）。
2. **建 PAT**：GitHub → Settings → Developer settings → Fine-grained tokens →
   只授权 `DepthRecur/wordmemo-sync-test`，权限 `Contents: Read and write`。
3. **想一个同步密码**（≥10 字符，界面可以「帮我生成」），抄下来。
4. 测试仓库目前是空的；第一次连接会写入 `meta.json`。

## 两种测法

### A. 本机双实例（推荐，先做这个）

前提：本机有本仓库源码，并已 `npm install`。

```powershell
# 在仓库根目录（不是本包目录）
npm run build
powershell -ExecutionPolicy Bypass -File test-package\start-two-devices.ps1
```

脚本会在 `%TEMP%\wordmemo-test\device-a` 和 `device-b` 各开一个实例（数据互不影响，
也不会碰你的真实 `%APPDATA%\WordMemo`）。两个实例都连**同一仓库、同一密码**。
测完运行 `reset-local-test-data.ps1` 清理。

### B. VM / 另一台机器（便携版）

把 `WordMemo-0.6.0-portable.zip` 复制到 VM，解压，双击 `WordMemo.exe`。
注意：便携版的数据固定在 VM 的 `%APPDATA%\WordMemo`，和本机互不影响。
VM 里按 `TEST-SYNC.md` 走一遍双设备流程（本机 + VM 连同一仓库）。

## 怎么测

打开 `TEST-SYNC.md`，按顺序做：

1. 连接与首次同步；
2. 改数据 → 推送 → 另一台拉取；
3. 导出/导入 `.wmsync`；
4. 两台设备双向修改（并集 / 字段级 LWW / 删除）；
5. 设备列表、移除设备、换密码；
6. 错误场景（密码错、PAT 失效、文件损坏、断网）。

每做完一项在 `checklist.md` 里打勾；失败的项按 `report-template.md` 记录。

## 自动检查（不用手动点）

```powershell
powershell -ExecutionPolicy Bypass -File test-package\run-checks.ps1
```

结果写到本目录的 `checks-<时间>.txt`：typecheck、全部测试、构建。预期：

- typecheck 0 错误
- 32 文件 / 274 项通过（另 2 份手动测试跳过）
- build 通过

## 发现问题怎么回报

按 `report-template.md` 填，附上：

- 哪一步、期望什么、实际什么（截图最好）；
- 设置页同步面板的红色错误文字；
- 日志：本机测试实例在 `%TEMP%\wordmemo-test\device-a\diagnostics.log`（VM 在 `%APPDATA%\WordMemo\diagnostics.log`）；
- GitHub 仓库 `devices/<id>/` 的文件列表（不用发内容）。

**不要**在报告里贴 PAT 或同步密码。

## 安全提醒

- 同步密码忘记无法恢复；测试用的密码可以随便设，但别用你真实想长期用的那个。
- 测试仓库里只有密文；`meta.json` 明文只有格式版本、salt、口令校验值、创建时间。
- 测完可以把仓库里的 `meta.json` 与 `devices/` 删掉，恢复空仓库。
