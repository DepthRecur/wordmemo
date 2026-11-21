# 计划 C：自动更新（走 GitHub Releases）

> 目标版本：v0.4　预计 **4~5** 个工作日　风险：中
> 前置：仓库已开源 + 打包链路已跑通 + 迁移前备份的坑已修（见总览 §3）
> 相关：[总览](PLAN-NEXT.md) · [复用调研](RESEARCH-REUSE.md)
> **2026-11-18 定稿**：走**便携版**（§3.11），不做安装包、**不做代码签名**（连免费 OSS 签名也不申请）。路线 C 与 B 一起交付：同一个 zip，C 是自动换目录，B 是用户手动覆盖。
> 因此 `electron-updater` / NSIS / `latest.yml` / 差分下载**全部不需要**；§3.1~§3.10 保留为「以后想回到安装包」的参考。

---

## 1. 目标与红线

**目标**：用户拿到一个文件夹（解压即用），之后你发一个 GitHub Release，程序能自己换到新版，**数据不丢**；网络不通时，用户可以手动下载新 zip 覆盖。不搭网站、不租服务器、不买签名。

**红线**：
1. 不搭网站、不做自建更新服务；更新源只有 GitHub Releases。
2. 不做遥测、不做强制更新、不静默重启。
3. 更新源只认 GitHub Releases + HTTPS；不接受"远程下发的配置/脚本"。
4. **不做代码签名**（已知代价：SmartScreen 会提示"未知发布者"，用文档缓解，不用钱解决）。
5. 不因为发版把用户数据搞坏：**升级前备份、迁移只加不删、旧版本遇到新库要拒绝而不是硬跑**。

---

## 2. 现状盘点

| 位置 | 现状 | 需要做什么 |
|---|---|---|
| `package.json:3` | `version: 0.1.0` | 建立版本纪律，首个可更新版本定 0.1.1 或 0.2.0 |
| `package.json:8` | `private: true` | 开源时改 `false`，否则 npm/工具链会别扭 |
| `package.json:42-70` | 有 `build`（appId / NSIS / icon），**没有 `publish`** | 加 `publish: [{ provider: "github", owner, repo }]`；electron-builder 据此生成 `app-update.yml` 与 `latest.yml` |
| `package.json` | 没有 `repository` / `homepage` / `bugs` | 补上（README 徽章、Issue 链接也依赖它） |
| 依赖 | 没有 `electron-updater` | 加为 **dependencies**（运行时需要，不是 devDependencies） |
| `src/main/index.ts:34-94` | 手工建窗口，无任何更新逻辑 | 加 `updater.ts` 与启动后检查 |
| `scripts/Launcher.cs` + `WordMemo.exe` | 开发形态：启动器拉起 `node_modules/electron/dist/electron.exe`，参数带 `--no-sandbox` | 打包后不再需要启动器（NSIS 生成的 `WordMemo.exe` 就是入口），但 **`--no-sandbox` 的兼容问题会跟着进安装包**，必须解掉 |
| `src/main/index.ts:295/308` | `openDb()` 内部先迁移，`dailyBackup()` 后执行 | 升级后首次启动若迁移失败，只有昨天的备份 → 改成"迁移前备份" |
| 仓库 | 还没有 `.github/workflows` | 加 release 工作流 |
| 签名 | 无 | 决定要不要买（见 §8） |

**一个关键判断**：自动更新不只是"加个 updater"。它把一个从没被认真对待过的问题推到面前——**安装包形态**。今天你双击 `WordMemo.exe` 跑的是项目目录里的 Electron；打包后是 `%LOCALAPPDATA%\Programs\WordMemo\` 下的独立程序。这两者的路径、权限、快捷方式、`--no-sandbox` 行为都不同。这个计划里有一半工作量在打包与兼容，而不是更新本身。

---

## 3. 方案

### 3.0 先选分发形态（这一节决定后面写什么）

「自动更新」不是一个独立问题——它由**分发形态**决定。四种路线：

| 路线 | 用户要做什么 | 更新怎么发生 | 你要维护什么 | 失败面 | 评价 |
|---|---|---|---|---|---|
| **A. NSIS 安装包 + electron-updater** | 跑一次安装包 | 后台下载、退出时静默安装 | 打包链、updater、签名、SmartScreen、CI | 中 | 最"标准"，但最重；未签名时静默安装有静默失败风险 |
| **B. 便携版 zip，手动替换** | 解压到一个文件夹，双击启动 | 下载新 zip → 覆盖 `app/` 目录 | 只需要 CI 打 zip | **低**（失败就是没更新） | 与 C 共用同一个 zip，作为兜底 |
| **C. 便携版 + 启动器自更新** | 解压，双击启动 | 应用下载 → 启动器换目录 → 启动 | ~250 行启动器 + 回滚逻辑 | 中 | **已定：走这条**（B 顺带就有） |
| **D. git clone 源码 + npm install** | 装 Node、npm，clone，install，build | `git pull` + `npm install` + `npm run build` | Node 版本、构建失败、依赖供应链 | **高** | 只适合开发者，不适合学生 |
| E. clone「预构建分支」 | 装 git | `git pull` | 200 MB 二进制进 git | 高 | 不建议（git 不适合存二进制） |

**为什么 D 不能当用户侧更新（三个硬伤，都在代码里能指出来）**：

1. **数据会被放进仓库目录**。`src/main/index.ts:22-26`：`if (!app.isPackaged)` 时把 `userData` 设成 `app.getAppPath()/.data`。源码运行 = `isPackaged === false` = 词库落在 clone 出来的文件夹里。用户"删掉重 clone 一次"就把一学期进度删了；`git clean -xdf` 也一样。
2. **用户机器要能构建**。`npm install`（含 Electron 二进制，几百 MB）+ `npm run build`（TypeScript 在当前 Node 版本上必须过）。构建失败 = 应用打不开，而用户没有回滚手段。若启用 pi-ai，还要求 Node ≥ 22.19。
3. **`git pull` 不是原子更新**。用户改过任何文件就冲突；拉到一半断电就是半个源码树；没有版本校验、没有回滚。

**D 唯一值得保留的部分**：源码可审计、不需要签名、不需要服务器。这三条 B/C 也都有。

> **已定（2026-11-18）**：走 C，同一个 zip 顺带覆盖 B；A 以后可选，D 只写进 README 的开发章节。

下面 §3.1~§3.10 是路线 A 的资料（**本版不实施**，留作以后想回到安装包时参考）；§3.11 是定稿方案。

### 3.1 打包：NSIS 每用户安装（不需要管理员）

沿用现有 `nsis` 配置，补几个关键项：

```jsonc
"build": {
  "appId": "com.ymh.wordmemo",
  "productName": "WordMemo",
  "publish": [{ "provider": "github", "owner": "<你的账号>", "repo": "wordmemo" }],
  "win": {
    "target": [{ "target": "nsis", "arch": ["x64"] }],
    "icon": "build/icon.ico",
    "artifactName": "WordMemo-Setup-${version}.${ext}"
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,                    // 每用户安装，不触发 UAC；开了它更新要提权，自动安装会被跳过
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "deleteAppDataOnUninstall": false,      // 卸载保留数据，避免用户重装丢词库
    "shortcutName": "WordMemo",
    "include": "build/installer.nsh",       // 见 §3.3：重建带 --no-sandbox 的快捷方式
    "differentialPackage": "store-asar"     // 差分才真的小（一行改动 ~9 KB）
  },
  "asar": { "contentAlignment": 512 }
}
```

- **只出 NSIS**，不做 MSI（不需要企业部署）。
- **便携版 zip 可选**（离线分享用），但它**不参与自动更新**——zip 解压的目录没有安装信息，`electron-updater` 会报错。如果要发，README 必须写清"便携版需手动下载新版"。
- 目标架构先只 x64。你机器是 x64，学生机器也是 x64 为主；arm64 等有人提再加。
- `artifactName` 必须含 `${version}`（当前默认就带）。去掉它 → **每次更新都退回整包**，官方 PR #10463 的原话是 "the test app's artifact name has no version" 导致首更全量。
- **顺手把 `electron-builder` 从 25 升到 26**：2026-10 之后与 GitHub 差分有关的一批修复（302 跳转后 Range、blockmap 缓存、非法 range 卡死）都在 26 线；本项目无原生模块，升级风险低。
- `electron-updater` 放 **dependencies**（运行时需要），版本 **≥ 6.8.11**（`latest` 实读 6.8.11，26 线有 6.8.12）。**低于 6.8.10 在 GitHub 上会静默退化成整包**，日志里只有一行 `fallback to full download`。

### 3.2 更新客户端：`electron-updater`

新增 `src/main/updater.ts`，职责单一：

```ts
export function initUpdater(ctx: { window(): BrowserWindow | null; onBeforeInstall(): void })
export async function checkNow(manual: boolean): Promise<UpdateCheckResult>
export function quitAndInstall(): void
```

行为约定：

| 项 | 决定 | 理由 |
|---|---|---|
| 检查时机 | 启动后 **60 秒**（等窗口与数据库就绪），之后每 **24 小时** | 不与启动抢资源；一天一次足够 |
| 检查节流 | 失败退避 **1h → 2h → 4h → 6h**；时钟回拨时用 `Math.min` 兜底（不会永久停摆） | 直接抄 Rocket.Chat 的 `updateCheckSchedule.ts`（36 行，MIT，零依赖） |
| 只读 stable | v1 不启用 beta 通道 | 少一个变量，符合"不频繁更新" |
| **默认模式** | **只探测不代装**：发现新版本 → 托盘/设置页提示 → 「打开发布页」让用户自己下载 | 未签名 NSIS 的静默安装可能**既不报错也装不上**（Rocket.Chat 要专门用 `downloadedUpdateHelper.file` + `fs.existsSync` 补洞）；MarkText 那种下载完强杀重启会丢未保存内容 |
| 高级选项（默认关） | 「下载并在退出时安装」：`autoDownload=false`，用户点「下载」才下；装前先 `app.removeAllListeners('window-all-closed')`，装后启 **20 秒退出看门狗**（到点 `app.exit(0)`） | 只有明确选择才承担静默安装的风险；看门狗解决"主进程挂住导致装不上" |
| 下载完成 | 托盘气泡 + 设置页徽标 + 「立即重启安装」 | 不打断学习 |
| 安装时机 | 用户点「立即」；或（仅高级选项）下次退出时 `autoInstallOnAppQuit = true` | 绝不静默重启 |
| 安装前 | WAL checkpoint + 备份 DB 为 `wordmemo-pre-update-<from>-<to>.db`（保留 3 份） | 出事能退 |
| 跳过版本 | 存**数组** `settings.updates.skippedVersions`；**手动检查时无视跳过** | 抄 Mattermost：用户主动问就必须回答，比"永久关更新"温和 |
| 失败 | 自动检查失败完全静默（`autoUpdater.logger` 的 error 降级成 warn）；手动检查失败也只落到"无更新"+ 人话原因 | 抄 Rocket.Chat：别让日志里全是红色 error，也别用弹窗惩罚用户 |
| 手动检查 | 设置页「检查更新」按钮，永远可用；加 45s 超时 + 一次重试 | GitHub 的 release metadata 偶发空 body，会报 `ERR_UPDATER_NO_PUBLISHED_VERSIONS` |
| 开发模式 | `!app.isPackaged` 时整个模块不初始化 | `electron-updater` 在 dev 下会抛错 |

`electron-updater` 依赖 electron-builder 生成的 `app-update.yml`（打包时写进 `resources/`），所以**不要手工 setFeedURL**；只在需要指向镜像时才用（见 §3.6）。

**关于差分更新**：`.blockmap` 是真实可用的，官方文档明确 `Windows: NSIS` 支持、用 HTTP `Range` 只下变化块。但它**依赖客户端版本**：6.8.10 之前，GitHub 资产 302 跳到 `objects.githubusercontent.com` 后 Range 会丢，结果是**静默退回整包**；blockmap 缓存过期还会报一个笼统的 `sha512 mismatch`。2026-10 之后这批问题才系统性修好（#10419 / #10427 / #10312 等）。

所以：**按「多数时候能差分、偶尔退整包」写预期**，不要向用户承诺增量；日志里看到 `Full: X, To download: Y` 才算真的差分生效。另外**全新安装后的第一次更新必然是整包**（没有旧 blockmap 缓存），这不是 bug。

### 3.3 `--no-sandbox` 这个坑（本项目特有，必须单独设计）

背景（`docs/PLAN.md:815-821`）：这台机器上 Chromium 沙箱初始化失败，Electron 不带 `--no-sandbox` 会在窗口出现前直接退出（`0xc0000005`）。开发形态靠 `WordMemo.exe` 启动器传参绕过。打包后没有启动器了，这个问题会原样进安装包——**对陌生人来说就是"装完打不开"**，这是开源后最容易被一星差评的死法。

**方案：三保险，不是单选**。官方文档明确 `--no-sandbox`「只应在测试时使用」，所以目标是**只在需要的机器上降级，并且降级后不会因为更新/快捷方式变化而失效**。

| 保险 | 做法 | 覆盖什么 |
|---|---|---|
| ① 代码侧（主力） | 主进程模块顶层读 `sandbox-state.json`；`compatMode` 为真时 `appendSwitch('no-sandbox')` + `appendSwitch('disable-gpu-sandbox')` | 与安装包/快捷方式**完全解耦**，更新后天然保留。参考 [electron#49167](https://github.com/electron/electron/issues/49167)：某些机器上只加 `--no-sandbox` 不够，要配 GPU 那个 |
| ② 快捷方式（兜底） | `build/installer.nsh` 的 `customInstall` 宏里重建 `.lnk` 带参数 | 覆盖「从开始菜单/桌面点」；也覆盖「exe 启动早期就崩、代码还没跑」的情况 |
| ③ 崩溃自愈 | `userData/launch-ok` 打点；连续 3 次没打点 → 强制 `compatMode=true` | 那些只在特定 GPU 配置下崩的机器 |

```
userData/
  sandbox-state.json   { "compatMode": false, "probe": { "pid", "startedAt", "ok": false }, "failStreak": 0 }
```

1. 主进程模块顶层（`app.whenReady()` 之前）：读 `sandbox-state.json`；`compatMode === true` 时追加两个开关。
2. 启动时写 `probe = { pid, startedAt, ok: false }`。
3. `ready` 之后（窗口 `ready-to-show`）把 `probe.ok = true`、`failStreak = 0`，并清掉。
4. 下次启动若发现 `probe.ok === false` 且进程已不存在、启动时间距今 < 30 秒 → `failStreak++`；到 3 次就置 `compatMode = true`，并以托盘气泡/首启提示告知："检测到你的系统不支持沙箱，已切到兼容模式（安全性略降，功能不变）"。
5. 设置页给「兼容模式」开关 + 一句解释 + 「重新检测」按钮（关掉后下次启动按正常模式试）。

**为什么②不能单独用**：只覆盖「通过快捷方式启动」。直接双击 exe、开机自启的 `Run` 项、文件关联、"任务栏固定"的旧副本都会绕过参数。**为什么①不能单独用**：如果崩溃发生在 `main.js` 执行之前的 GPU/utility 拉起阶段，`appendSwitch` 可能来不及。所以两条都要，③负责收尾。

**残余风险**：崩溃可能由别的原因引起 → 误判成沙箱问题。对策：只在"崩溃发生在 ready 之前且 < 30 秒"时判定；设置页可一键关掉兼容模式；日志记录判定依据，Issue 模板里让人贴这段日志。

### 3.4 版本与数据迁移纪律（比更新本身更重要）

自动更新一旦上线，**你的用户会跨版本运行**：A 在 v0.4，B 在 v0.7，数据格式差三个迁移。所以先把纪律立住：

1. **`schemaVersion`（= `PRAGMA user_version`）单调递增**，每个发版只在需要时 +1。
2. **迁移只加不删**：`ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX`。改名/删列要先加新列、双写一版、下个版本再删——跨两个版本。
3. **迁移前备份**（修总览里那个坑）：`openDb()` 之前比较 `user_version` 与代码里的目标版本，需要迁移就先把 `wordmemo.db`（含 WAL checkpoint）复制成 `backups/wordmemo-pre-migrate-v<N>-<时间>.db`。
4. **旧版本遇到新库**：启动时若 `user_version > 代码支持的最大版本` → 弹框"这份数据由更新版本的 WordMemo 创建，请升级后再打开"，并**拒绝启动到主界面**（只允许"打开数据目录/恢复备份/退出"）。绝不"尽力而为"地跑，那会静默写坏数据。
5. **Release Notes 必须写**：本次是否迁移数据（是/否）、迁移不可逆（是/否）、建议先备份（是/否）、影响面（修了什么 bug）。中文、人话、三行以内。
6. **同步格式版本**（为后续同步功能预留）：`syncFormatVersion` 与 `schemaVersion` 分开记，互不牵连。

### 3.5 CI：tag 触发，一条命令发版

> **本版不实施这一节**（它产出 `latest.yml` + NSIS，属于路线 A）。便携版的 CI 见 §5 U3：输出 `--dir` → zip → `latest.json` + `.sha256` → 发 Release。

`.github/workflows/release.yml`：

```yaml
name: release
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      dry_run: { type: boolean, default: true }

permissions:
  contents: write

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - name: publish
        if: ${{ !inputs.dry_run }}
        run: npx electron-builder --win --x64 --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

要点：
- **只由 tag 或手动触发**，不接受 PR 触发（防止别人提 PR 就能跑你的发布流程）。
- `npm ci` 必须过；`typecheck` + `test` 失败就不发布（**发布流程本身就是质量闸门**）。
- 本项目没有原生模块（`node:sqlite` 是 Node 内置），所以 CI 上不需要 `electron-rebuild`，这是当初选型的红利，别破坏它。
- 产物：`WordMemo-Setup-x.y.z.exe`、`.blockmap`、`latest.yml`、可选的便携 zip。`latest.yml` 必须和 exe 在**同一个 Release**里，否则客户端拿不到更新。
- Release body 从 `CHANGELOG.md` 对应段落读，或至少手填 §3.4 那三行。
- `workflow_dispatch` 的 dry-run 允许你先跑一遍不发布（CI 上多验证一次打包）。

### 3.6 更新源与"国内下载慢"

- 唯一更新源：`https://github.com/<owner>/wordmemo/releases/latest/download/latest.yml`。
- **不维护镜像**（那需要另一份基础设施，违背前提）。README 里给一句实用建议："如果下载慢，可以到 Releases 页手动下载安装包，覆盖安装即可，数据不受影响。"
- `apiBase` 不做成可配置（更新源可配置 = 给钓鱼留口子）。**唯一例外**：如果以后真要接镜像，用 `electron-updater` 的 `generic` provider 指向静态地址，并且仍然校验 `latest.yml` 里的 sha512。

### 3.7 回滚

- Releases 里**永久保留最近 3 个版本的安装包**，不删。
- 「覆盖安装旧版」是可行的（NSIS 允许降级安装），但**数据可能已经被新版本迁移过**：所以文档写明"回滚前先从 `backups/` 恢复对应备份"。
- `allowDowngrade = false`：自动更新不会把用户降级（避免来回弹）。
- 如果某个版本出了数据事故：立刻发一个修复版本（哪怕只改一行），并在 Release 标题里写明"请升级，修复 XX"，这比让用户手动回滚现实得多。

### 3.8 界面

设置页新增「关于与更新」区块：

```
WordMemo v0.4.0        [检查更新]
状态：已是最新 / 正在下载 42% / 已下载，重启后安装
☑ 后台自动下载更新
☐ 跳过此版本（v0.5.0）
上次检查：2026-11-17 20:31（成功）
[打开发布页] [导出诊断日志]
☐ 兼容模式（关闭 Chromium 沙箱；仅在无法启动时使用）
```

侧边栏底部已经有"退出"，把版本号也放一份在侧边栏（现在有构建时间/启动时间/权限/托盘状态，`src/main/diagnostics.ts` 那套可以复用）。

### 3.9 复用调研落地（2026-11-18 补）

| 方案 | 许可证 | 结论 |
|---|---|---|
| [electron-updater](https://www.electron.build/docs/features/auto-update) + [electron-builder](https://github.com/electron-userland/electron-builder) | MIT（npm 6.8.11 **实读**） | **采用**。唯一同时满足「GitHub Releases + Windows NSIS + 未签名可用」的组合；与现有构建链零迁移成本 |
| [electron/update-electron-app](https://github.com/electron/update-electron-app) | MIT | **出局**：Windows 只吃 Squirrel 的 `.exe` + `.nupkg` + `RELEASES`，NSIS 产物没有这些；官方文档原文写明要用 electron-forge 或 electron-winstaller 打包 |
| [Velopack](https://github.com/velopack/velopack) | MIT | 备选。自带 Setup（不是 NSIS）、要 .NET 8、引入原生 `.node`；换安装器收益不抵成本 |
| Squirrel.Windows | MIT | 2024-07 后无提交、423 open issue，且 electron-builder 官方标注「not supported」 |
| electron-release-server | MIT | 要自建服务器，违背前提；已停更 |

**顺带确认的两件事**：
1. 公开仓库的 GitHub Releases **不需要 token、不吃 API 限额**；每次检查最多 3 个请求。
2. 未签名时 `electron-updater` 只靠 `latest.yml` 里的 sha512 校验；builder 25/26 没有签名清单（v27 才有）。所以「更新源可信」完全依赖仓库不被入侵——2FA + 分支保护 + Release 权限收紧是必须做的配套。

**一个同门产品的旁证**：这台机器上的 DeepSeek Harness 用的就是 `electron-updater` 的 `generic` provider（`resources/app-update.yml` 原文：`provider: generic` + 自建下载域名 + `channel: nightly` + `publisherName: CN=Hangzhou DeepSeek…`）。它说明这套东西支撑得起商业产品的更新链路；同时也说明「换自建源」在需要时只是改一份 `app-update.yml`，不需要改客户端代码——但我们 v1 不需要，GitHub Releases 就够。

### 3.10 产品级调研：八款应用的做法（2026-11-18 补）

看的是「已经做了自动更新的开源应用」，不是库。结论：**能整段抄的只有一个 36 行的文件**，其余抄模式。

| 产品 | 用什么 | 关键文件 | 许可证 | 我们抄什么 |
|---|---|---|---|---|
| [Rocket.Chat Desktop](https://github.com/RocketChat/Rocket.Chat.Electron) | electron-updater 6.x | `src/updates/updateCheckSchedule.ts`（36 行，零依赖）；`src/updates/main.ts` | **MIT** | **整段抄调度函数**（24h 间隔、1h→6h 退避、时钟回拨兜底）；抄 45s 超时 + `[2s,5s]` 重试；抄 20s 退出看门狗 |
| [Mattermost Desktop](https://github.com/mattermost/desktop) | 已放弃应用内更新，只通知 | `src/main/updateNotifier.ts` | Apache-2.0 | 抄「跳过版本数组 + 24h 重提醒 + 手动检查穿透跳过」 |
| [PicGo](https://github.com/Molunerfinn/PicGo) | 自研检查 | `src/main/utils/updateChecker.ts` | MIT | 抄「`NO_MORE_NOTICE` 复选框 + `shell.openExternal(发布页)`」 |
| [youtube-music](https://github.com/th-ch/youtube-music) | electron-updater 当版本探针 | `src/index.ts` | MIT | 抄「只探测、安装交给 GitHub 页面」——**这正是我们的默认模式** |
| [Etcher](https://github.com/balena-io/etcher) | electron-updater 6.1.8 | 内联在 `lib/gui/etcher.ts` | Apache-2.0 | 抄 `while (!done) { check; wait 5min }`（不叠加异步） |
| [MarkText](https://github.com/marktext/marktext) | electron-updater ^6.8.12 | `packages/desktop/src/main/menu/actions/marktext.ts` | MIT | 抄 IPC 薄胶水；**不抄它下载完就 `quitAndInstall`**（源码里自己留了 TODO 说会丢未保存内容） |
| [lx-music](https://github.com/lyswhut/lx-music-desktop) | electron-updater 6.8.9 | `src/renderer/utils/update.js`（内容未核实） | Apache-2.0 | 无（更新放渲染进程，参考价值有限） |
| VS Code | 自研 + Inno Setup | `src/vs/platform/update/electron-main/updateService.win32.ts` | MIT | 不抄（换生态等于重写） |

**由此改了 §3.2 的默认行为**：不默认自动下载+自动安装，改成「探测 + 打开发布页」。原因写在表里：未签名 NSIS 的静默安装在部分机器上会静默失败，而产品层的三种失败（安装器起不来、主进程挂住、强杀丢文档）都能把用户数据搞坏。

### 3.11 定稿方案：便携版 + 「应用下载 / 启动器换目录」

**已定**：不做安装包、不做签名。C（自动）与 B（手动）用**同一个 zip**交付，所以两条路一起实现，B 是 C 失败时的兜底，也是 GitHub 连不上时唯一的路。

**目录约定**（`app/` 与数据分离是全部安全性的前提）：

```
WordMemo-Portable/
  WordMemo.exe           启动器（扩展现有 scripts/Launcher.cs，C#，约 250 行）
  app/                   打包产物（electron-builder --dir 输出）
    WordMemo.exe
    resources/app.asar
    version.json         构建时写入 { version }
  update/                下载暂存：zip、解压后的 app-new、state.json、error.log
  README.txt             手动更新说明（路线 B）
```

**职责切分（这是关键设计，避免启动被下载拖慢）**：

| 谁 | 做什么 |
|---|---|
| **应用（Electron）** | 启动 60 秒后检查 `https://github.com/DepthRecur/wordmemo/releases/latest/download/latest.json`（**走静态资源，不吃 API 限额**）；有新版就下载 zip 到 `update/`，流式校验 sha256，解压到 `update/app-new`，写 `update/state.json = { ready: true, version }`；界面提示「下次启动生效」。**应用绝不自己替换自己**。 |
| **启动器（C#）** | 启动前 300 ms 内做两件事：① 发现 `update/app-new` 就校验 + 换目录；② 启动 `app/WordMemo.exe`。换目录失败就删 `app-new`、照常启动旧版。 |

**启动器换目录的顺序（必须严格按这个来）**：

```
1. 读 app/version.json 与 update/state.json；版本不新于当前 → 删 app-new，直接启动
2. 校验 app-new 完整（存在 app-new/WordMemo.exe + version.json 版本对得上）
3. 若存在上次的 app-old → 删除（说明上次启动成功过）
4. app → app-old        （同一盘符内 rename，原子）
5. app-new → app
6. 启动 app/WordMemo.exe（带 --no-sandbox / 清 ELECTRON_RUN_AS_NODE）
7. 写 update/state.json = { ready:false }；app-old 保留到下次启动再删
```

任一步失败：回滚成 `app-old → app`，写 `update/error.log`，启动旧版并显示一句「更新失败，已用回旧版」。

**必须遵守的五条纪律**：

| 纪律 | 原因 |
|---|---|
| **数据永不放在程序目录** | 便携版整个 `app/` 会被替换；`userData` 必须固定在 `%APPDATA%\WordMemo`。打包版默认如此（`isPackaged === true`），但要确认 `index.ts:22-26` 那段"开发模式塞 `.data`"的逻辑**不会**在便携版生效 |
| **应用只下载、启动器只换目录** | Windows 上运行中的文件被锁，应用无法替换自己；反过来让启动器等下载会拖慢每次启动 |
| **先解压、再 rename** | 不能边下边覆盖 `app/` |
| **sha256 + 保留 app-old** | 校验防损坏；`app-old` 是唯一回滚手段 |
| **更新源只认 GitHub Releases** | `latest.json` 只提供版本号、zip 名、sha256；不做远程配置 |

**`latest.json`（自己定义，不用 `latest.yml`）**：

```json
{ "version": "0.4.0", "zip": "WordMemo-0.4.0-portable.zip", "sha256": "…", "notes": "修复…" }
```

**代价（如实接受）**：

- **每次都全量下载**（zip 约 80~120 MB），没有差分。
- 更新在**下一次启动**才生效（应用不能替换自己）；提示文案要写清，别让用户以为没更新。
- 便携版没有安装/卸载概念：**卸载 = 删文件夹**；README 要写「数据在 `%APPDATA%\WordMemo`，删软件不删词库」。
- **不签名的代价**：解压后的 exe 首次运行会带 SmartScreen「未知发布者」——这是明确接受的成本。缓解手段（不花钱）：README 放一张"更多信息 → 仍要运行"的截图；发布页附 sha256 与 VirusTotal 链接；把源码公开可审计。
- 开机自启记的是当前路径，用户挪文件夹后失效 → 设置页给「重新设置自启」。
- 杀软误报（Electron 应用常见）：准备一份「被拦截时怎么加白」的说明。

**路线 B（手动）就是同一份 zip**：README 写「下载 zip → 关掉程序 → 解压覆盖 `app/` → 重新打开」。这条不依赖 GitHub 连通性以外的任何东西，也是国内网络不好时的主要方案。

---

## 4. 数据与接口变更

| 变更 | 内容 |
|---|---|
| `settings.json` 新增 `updates` | `{ autoCheck: boolean, skippedVersions: string[], lastCheckAt, pendingVersion }`（都不含敏感信息） |
| 新文件（程序目录） | `app/version.json`（构建写入）、`update/state.json`、`update/error.log` |
| 新文件（userData） | `userData/sandbox-state.json`（兼容模式与崩溃探针） |
| 新 IPC | `updates:status`、`updates:check`、`updates:download`、`updates:skipVersion`、`updates:setCompatMode`；**没有 `updates:install`**（替换由启动器做） |
| 新类型 | `UpdateStatus`、`UpdateCheckResult`、`UpdateProgress` |
| 事件 | `updates:progress`、`updates:downloaded`、`updates:error` 推给渲染层 |
| 构建 | `electron-builder --dir` + zip + `latest.json`；**不需要** `publish`、`nsis`、`electron-updater`、`latest.yml` |

---

## 5. 分阶段实施

### U0 便携版打包跑通（1 天）

- `electron-builder --dir` 输出 `win-unpacked`，把里面的内容放进 `app/`；构建时写 `app/version.json`。
- 启动器 v0：双击 `WordMemo.exe` → 启动 `app/WordMemo.exe`（带 `--no-sandbox`、清 `ELECTRON_RUN_AS_NODE`）。
- 干净机器/虚拟机解压到 `D:\WordMemo` 试跑：能启动、能建库、托盘正常。
- **没有 Windows 虚拟机时的替代办法**（按优先级）：① **Windows 沙盒**（Win10/11 Pro 自带）：把 zip 拖进去，等于全新机器；② 新建一个**本地 Windows 用户**，用那个账户跑一遍（`%APPDATA%` 干净）；③ CI 的 `windows-latest` 只做打包 + 启动冒烟。
- **验收**：`%APPDATA%\WordMemo` 里有 `wordmemo.db`；**程序目录里没有数据**；把整个文件夹复制到另一台机器能直接用。

### U1 兼容模式（0.5~1 天，必须先于自更新）

- `sandbox-state.json` 探针 + `appendSwitch('no-sandbox'/'disable-gpu-sandbox')` + 设置页开关 + 首启提示 + `failStreak` 自愈。
- 启动器也带 `--no-sandbox` 兜底（双保险，因为启动器在 app 之前跑）。
- **验收**：在你这台"必须 no-sandbox"的机器上，**解压后首次双击就能开**；正常机器 `compatMode=false`；三种入口（启动器、直接点 `app/WordMemo.exe`、快捷方式）都能开。

### U2 自更新（1.5~2 天）

- 应用侧：检查 `latest.json` → 下载 zip → 流式 sha256 → 解压 `update/app-new` → 写 `state.json` → 提示「下次启动生效」。
- 启动器侧：按 §3.11 的 7 步换目录 + 失败回滚 + `error.log`；`app-old` 保留一次启动。
- **验收**：
  1. 装 `0.4.0` → 发 `0.4.1` → 应用提示有新版 → 下载完成 → 重启 → 启动器换目录 → 版本号变、**词库/复习进度/设置全在**。
  2. 把 zip 的 sha256 改坏 → 应用提示"校验失败"，不产生 `app-new`。
  3. 手动把 `app-new` 弄成半截 → 启动器回滚到旧版并写日志，**能正常启动**。
  4. 断网 → 不报错、不卡启动。

### U3 CI 发版 + 手动路径 B（1 天）

- workflow（tag 触发）：build → 打包 `--dir` → zip → 生成 `latest.json` 与 `.sha256` → 发 Release。
- README 写清两条路：自动（正常情况）、手动（下载 zip 覆盖 `app/`）。
- **验收**：Release 里有 `WordMemo-x.y.z-portable.zip` + `latest.json` + `.sha256`；从零解压能用；按 README 手动覆盖也能用。

---

## 6. 测试计划

自动更新天生难做自动化（要真发布、真下载、真安装），所以分层：

- **单元测试**（`tests/updater.test.ts`）：
  - 版本比较（含 `0.1.10 > 0.1.9`、预发布号）；
  - 跳过版本逻辑；手动/自动检查的节流（24 小时内不重复）；
  - 兼容模式判定函数（给定 `sandbox-state.json` 内容 → 是否降级）；
  - 迁移前备份函数（给定 `user_version` 差异 → 是否备份、备份命名）。
- **构建冒烟**（CI 里跑）：`npm run dist` 成功 + 产物清单断言（exe / blockmap / latest.yml 存在）。
- **手动端到端清单**（每次发版照着做，5 分钟）：
  1. 装上一版 → 等待/手动检查 → 更新 → 数据完整
  2. 断网时检查更新 → 不崩、提示合理
  3. 把 `latest.yml` 改成坏地址 → 提示"检查失败"，不影响使用
  4. 跳过版本 → 不再提示该版本
  5. 卸载重装 → 数据还在
  6. 旧版本打开新库 → 拒绝启动且能打开数据目录

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **SmartScreen 警告**（明确不签名） | 陌生人首次运行被吓到 | 接受这个成本；README 放"更多信息 → 仍要运行"截图；附 sha256 与 VirusTotal 链接；源码可审计 |
| **`--no-sandbox` 兼容** | 部分机器解压后打不开 | U1 的自动探测 + 启动器兜底；Issue 模板要求贴诊断日志 |
| **换目录时文件被占用** | 更新失败 | 应用只下载、启动器只换；失败回滚 `app-old` 并照常启动 |
| **`app-new` 半截/损坏** | 换完打不开 | 先解压到临时目录 + 校验 `version.json` 与 `app/WordMemo.exe` 存在；不完整就删掉重下 |
| **更新要下次启动才生效** | 用户以为没更新 | 界面明确写「已下载，下次启动生效」；设置页显示 `pendingVersion` |
| 国内下载 GitHub 慢/断 | 更新失败 | 不打扰式失败 + README 的手动路径 B（同一份 zip） |
| 更新把库迁移坏 | 数据事故 | 迁移前备份、只加不删、旧版本拒绝新库、Release Notes 标注是否迁移 |
| CI 被滥用/误发 | 发错版本 | 只 tag 触发 + `permissions: contents: write` + dry-run + 发布前 test 闸门 |
| 便携版自启路径失效 | 开机不启动 | 设置页「重新设置自启」；README 提示别挪文件夹 |

---

## 8. 已定 / 待定

| 项 | 状态 |
|---|---|
| 分发形态 | **已定**：便携版 zip；自动（启动器换目录）+ 手动（覆盖 `app/`）一起交付 |
| 代码签名 | **已定**：不做，连免费 OSS 签名也不申请；SmartScreen 警告通过文档缓解 |
| 更新组件 | **已定**：不用 `electron-updater`、不用 NSIS、不用 `latest.yml`；自己写 ~250 行启动器 |
| 全量下载 | **已定**：接受每次 ~100 MB，不做差分 |
| 首个可更新版本号 | **已定 `v0.3.0`**（2026-11-19，随便携版 U0 落进 `package.json`） |
| 是否保留「安装包」路线 | 留作以后可选；本版不发

## 9. 明确不做

- 不做 beta/灰度通道（v1）。
- 不做自建更新服务器 / 镜像 / CDN。
- 不做强制更新、不做静默重启、不做开机自动升级。
- 不做遥测、不做崩溃上报（本地日志 + Issue 模板足够）。
- 不做 Linux / macOS 打包（Windows 用户是目标人群；跨平台等有人真的需要）。

---

## 10. 实现记录

### U0 便携版打包 + 启动器 v0（2026-11-19，`feat/portable`，已并入主线）

**状态：完成。** `npm run dist` → `release/WordMemo-0.3.0-portable.zip`（141.5 MB；解压后约 408 MB）。U1 已完成（见下方 U1 小节）；U2 / U3 未做，起点见 §11。

> **2026-11-20 复核**：U0 之后主线又进了多供应商修复、多个库第二轮修复（`BUGS-DECKS` 全部关闭）和自定义下拉的 portal 改造，`release/` 里的 zip 是这些修复**之前**打的。做 U1 验收前先重新 `npm run dist`，不要拿旧 zip 当基线。

**落地内容**

| 文件 | 作用 |
|---|---|
| `package.json` | version `0.3.0`；`win.target` 从 nsis 改为 `zip`；`electronDist` 指向本地；`dist` = 组装脚本，`dist:app` 只出 win-unpacked，`launcher` 只编译启动器 |
| `scripts/make-portable.mjs` | build → electron-builder `--dir` → 组装 `WordMemo-Portable/`（`WordMemo.exe` + `app/` + `update/` + `README.txt`）→ 写 `app/version.json` → zip + sha256 |
| `scripts/build-launcher.mjs` | 用 Windows 自带 .NET Framework 4.x `csc.exe` 编译 `Launcher.cs`（含图标与版本属性），无新增依赖 |
| `scripts/Launcher.cs` | v0：清 `ELECTRON_RUN_AS_NODE` → `app\WordMemo.exe --no-sandbox`；缺 `app/` 时弹中文错误框 |
| `scripts/portable-README.txt` | zip 内说明：用法、数据位置、手动更新（路线 B）；构建时替换版本号 |
| `src/main/index.ts` | 打包版显式 `app.setPath('userData', %APPDATA%\WordMemo)`；开发版仍用 `.data` |
| `build/icon.ico` | 启动器图标（`/win32icon`），应用内图标不变 |

**必须记住的四个坑**

1. **electron-builder 25 的依赖树 bug（会打不开）**：hoisted 的 `call-bind-apply-helpers` 被误判成 `call-bind` 的 nested 依赖，只复制到 `node_modules/call-bind/node_modules/`；exceljs → unzipper 链在启动时直接 `Cannot find module 'call-bind-apply-helpers'`。**升到 `26.18.0` 后解决**（v26 换成纯 JS 依赖收集，asar 里 190 个顶层模块，`call-bind-apply-helpers` 回顶层）。不要退回 25；临时加直接依赖也不管用（仍被标 conflict）。
2. **GitHub 被墙也能打包**：electron-builder 默认从 GitHub 下 Electron zip，本项目用 `electronDist: "node_modules/electron/dist"` 复用已安装的 Electron。v26 不再需要 winCodeSign/rcedit 下载（旧版 25 的 7z 解压还会因符号链接权限失败）。builder 缓存放 `.cache/electron-builder`（本机 `%LOCALAPPDATA%` 曾被拒写）。
3. **zip 用 Windows 自带 `tar.exe -a -c`**（bsdtar）。v26 已没有 `7zip-bin` 依赖，不要再用 `7za`。
4. **首次运行的数据位置**：源码模式的数据在仓库 `.data/`，便携版按设计读 `%APPDATA%\WordMemo`，两者**不会自动迁移**。从源码切到便携版前，要复制 `.data` 里的 `wordmemo.db`、`settings.json`、`secrets.v2.json`、`Local State`（最后一个是 safeStorage 密钥）。反过来，便携版跑过之后 `.data` 仍是开发数据，互不影响。

**验收（本机 2026-11-19）**

- 解压到 `D:\WordMemo-Portable-Test` → 双击启动器 → 进程起来；托盘 `tray-state ok`（`diagnostics.log`）。
- `%APPDATA%\WordMemo\wordmemo.db` 创建；程序目录里 `*.db` / `settings.json` / `secrets*.json` / `diagnostics.log` 均为空。
- CDP：`window.api.system.appVersion() = 0.3.0`，UI 正常（截图 `.data/shots/portable-0.3.0.png`）。
- 导入 `samples/demo.txt` → 1 笔记 / 14 词；退出 → 启动器重开 → 数据仍在（1 笔记 / 14 词）。
- `npm run typecheck` 0 错误；`npm test` 12 文件 118 项全绿。
- **2026-11-20：一台全新 Win10 虚拟机复测通过**（解压即用；全程无弹窗、无报错、无 SmartScreen）。
- **2026-11-20：无 Key 回归**（zip 在修复后重建）：启动后正文不再出现「尚未配置 API Key」红条；导入 `samples/demo.txt` 后 `importer.draftIssues().unresolved = 0`，提示只在「解析提示」里且跟随默认模型那家（`DeepSeek`）；无 Key 时启动不再请求 models.dev 价格目录。

**下一步**

- **2026-11-20 用户指示**：U0 已完成，U1 → U2 → U3 现在恢复，交接清单见 §11。
- **U1 兼容模式**：**已完成**（2026-11-21），实现记录见下方 U1 小节；U2 是下一步。
- **U2 自更新**：应用侧检查 `latest.json` → 下载 → 流式 sha256 → 解压 `update/app-new` → 写 `state.json`；启动器按 §3.11 七步换目录 + 回滚 + `error.log`。`update/` 目录已预留、`app/version.json` 已写。
- **U3 CI 发版 + README 两条更新路径**：构建脚本已具备出 zip + sha256 的能力，`latest.json` 留给 U2/U3。

---

### U1 兼容模式（2026-11-21，`feat/portable-u1`，完成）

**状态：完成。** `npm run typecheck` 0 错误、`npm test` 16 文件 163 项全绿、`npm run build` / `npm run dist` 通过。版本仍是 `0.3.0`（按 §11.1，U1 不升版本）。

**落地内容**

| 文件 | 作用 |
|---|---|
| `src/main/sandbox.ts`（新） | 读写 `userData/sandbox-state.json`；`decideSandboxState` 纯判定、`evaluateSandboxOnStart` / `beginProbe` / `markReady` / `setCompatMode` / `sandboxInfo` / `ackSandboxNotice`；tmp+rename；坏文件按默认值 |
| `src/main/index.ts` | 模块顶层（`app.whenReady()` 之前）`evaluateSandboxOnStart`；`compatMode` 为真时 `appendSwitch('no-sandbox')` + `appendSwitch('disable-gpu-sandbox')`；单实例锁之后 `beginProbe`；窗口 `ready-to-show` → `markReady`；`--ai-smoke` 也 `markReady`；`diagnostics.log` 写 `sandbox-start` |
| `scripts/Launcher.cs` | 按 `%APPDATA%\WordMemo\sandbox-state.json` 的 `compatMode` decide 参数；**同时维护 probe/失败计数**（见下）；probe 写 `source=launcher`（主进程看到会忽略，由启动器自己结算）；保留 `ELECTRON_RUN_AS_NODE` 清理和缺失 app 的提示 |
| `src/shared/types.ts` / `src/preload/index.ts` / `src/main/ipc.ts` | 新增 `SandboxInfo` 与 `sandbox:get` / `sandbox:setCompat` / `sandbox:ackNotice` |
| `src/renderer/src/pages/SettingsPage.tsx` | 「高级与诊断」加兼容模式开关、自动开启提示、失败计数、「重新检测」 |
| `src/renderer/src/App.tsx` | 首次自动降级时推一条 `warn`（黄色常驻）：检测到系统不支持沙箱，已切兼容模式；展示后 ack，之后不再提示 |
| `scripts/portable-README.txt` | 写清「双击没反应就再试，连续 3 次失败后第 4 次自动切兼容模式」 |

**判定规则（实现）**

- `probe.ok === false` + `probe.pid > 0` + 进程不存在 + `startedAt` 距今 `>= 0 && < 30s` → `failStreak++`。
- 另外要求 `probe.startedAt > lastReadyAt`：如果应用已经 `ready-to-show`，启动器随后才写的 probe 不算失败（竞态保护）。
- `failStreak >= 3` → `compatMode = true`、`autoEnabled = true`、`noticeSeen = false`（下次成功启动后提示一次）。
- 成功 `ready-to-show` → `probe = null`、`failStreak = 0`、记 `lastReadyAt`。
- `setCompatMode`（开关/重新检测）清零计数、清 probe、`autoEnabled=false`、`noticeSeen=true`；改完下次启动生效。

**与原计划的差异（重要）**

计划里启动器「只读 compatMode」，失败计数在主进程。但 **有些机器 Electron 在加载主进程 JS 之前就退出**，主进程根本没法写 probe；这样启动器永远看不到失败，也就永远不会降级。所以实现里让启动器也参与：

- 启动器启动前先 `Evaluate()` 上一次 probe（同样 30s/pid/lastReady 规则），必要时把 `compatMode` 置 true；然后用**自己的 pid** 写一条 `source=launcher` 的 `ok=false` probe，再启动 app；app 能跑到 JS 就用 `source=app` 的 probe 覆盖它，ready 后清掉。这样 app 连 JS 都没起来时 probe 仍在，下一次启动由启动器结算；
- 主进程 `evaluateSandboxOnStart` **忽略 `source=launcher` 的 probe**，避免把「启动器还没退出、app 已经在跑」的同一次启动重复算失败；
- 为了不重复计数：启动器先判断已有实例（有就不碰状态）；主进程在单实例锁之后才 `beginProbe`；两边都忽略 `startedAt <= lastReadyAt` 的旧 probe。

这是 §3.3「崩溃探针」在「JS 根本没起来」场景下的唯一可行实现；计划正文的「启动器只读」需要在 U2/U3 文档里同步更新。

**验收（2026-11-21，本机）**

- **正常模式**：解压新 zip → 双击启动器 → 主进程命令行**没有** `--no-sandbox`；renderer 命令行是 `--enable-sandbox`、没有 `--no-sandbox`；`sandbox-state.json` 为 `compatMode=false / failStreak=0 / probe=null / lastReadyAt=<时间>`；`wordmemo.db` 创建。
- **兼容模式**：把 state 置 `compatMode=true` 后双击启动器 → 主进程命令行带 `--no-sandbox --disable-gpu-sandbox`；直接双击 `app\WordMemo.exe`（不经启动器）→ renderer 命令行出现 `--no-sandbox`（主进程 `appendSwitch` 生效）。
- **自动降级（启动器路径）**：用「启动即退出」的 dummy exe 替换 `app\WordMemo.exe`，连续 4 次双击启动器：`failStreak` 0→1→2→3，第 4 次 `compatMode=true`、`autoEnabled=true`、`noticeSeen=false`。
- **自动降级（主进程路径）**：把 state 置 `failStreak=2` + 一个已死 pid 的 probe，直接启动 `app\WordMemo.exe`：`sandbox-start` 日志 `justEnabled=true`，状态在窗口 ready 后清成 `failStreak=0 / probe=null / autoEnabled=true`，renderer 带 `--no-sandbox`。
- **首次自动提示**：自动降级后启动，UI 正文出现「检测到系统不支持 Chromium 沙箱，已自动切到兼容模式…」，`sandbox.get().noticePending=false`、`noticeSeen=true`（ack 生效）。
- **设置页**：CDP 打开「设置 → 高级与诊断」，能看到「兼容模式（关闭 Chromium 沙箱）」和「重新检测」；`sandbox.setCompat(false)` 后 state 变 false，下次启动 renderer 无 `--no-sandbox`。
- **三种入口**：启动器、直接 `app\WordMemo.exe`、以及从 `.lnk` 快捷方式启动都实际验证过（快捷方式指向启动器）。

**注意**

- 本机当前环境（Electron 38）**实际能带沙箱启动**（renderer 有 `--enable-sandbox`），所以「机器沙箱不可用」是用 dummy exe 和状态文件模拟的；真实失败场景请在有问题的 Windows 上复测。启动器的失败计数逻辑不依赖 app 是否能跑 JS，模拟覆盖了这一路径。
- 前 3 次启动失败时启动器会立即退出，没有 UI 提示；README 已写「再双击，连续 3 次失败后第 4 次自动兼容」。如果以后觉得体验太差，可在 U2/U3 的 README 或启动器里补提示，但不改判定阈值。
- `sandbox-state.json` 在 `%APPDATA%\WordMemo`，与数据库同处；不随 `app/` 更新丢失。
- 不改 schema、不动数据格式。

## 11. 交接：U1–U3 起点（2026-11-20）

> 给接手的会话：先读 [HANDOFF.md](HANDOFF.md) 的 §1（命令）、§8（坑）、§9（开场提示词），再读本节。§3.11 是定稿方案，本节只写**从哪里下手、验收什么、别碰什么**。

### 11.1 当前基线

- 分支：`master`（= 之前的 `fix/decks-ui`，已包含 U0 + 多供应商修复 + 多库修复）。工作区应干净；`npm run typecheck` 0 错误、`npm test` 15 文件 / 150 项全绿、`npm run build` 通过。
- **U1 完成后**：分支 `feat/portable-u1`，`npm test` 16 文件 / 163 项；实现记录见 §10 的 U1 小节。
- 开始新分支：`git checkout -b feat/portable-u1`（U2 再 `feat/portable-u2`，U3 `feat/portable-u3`）。
- 版本纪律：`package.json` 现在是 `0.3.0`。U1 可以不升版本（用户不可见的行为修复）；**U2 发版前升到 `0.4.0`**，并让 `app/version.json` 由构建脚本写入（`scripts/make-portable.mjs` 已这么做，别手改）。
- 构建：`npm run dist`（约 1~2 分钟，产出 `release/WordMemo-<ver>-portable.zip` + `.sha256`）。`npm run dist:app` 只出 `win-unpacked`；`npm run launcher` 只重编启动器。
- 测试数据：源码模式在 `.data/`，便携版在 `%APPDATA%\WordMemo`，两者不互通。做 U1/U2 验收前先确认 `%APPDATA%\WordMemo` 有可识别的数据（或先备份/改名），程序目录里不应该有 `*.db` / `settings.json` / `secrets*`。

### 11.2 U1 兼容模式（先做，0.5~1 天）

> **2026-11-21 已完成**，实现记录、与原计划的差异（启动器也维护 probe）、验收均见 §10 的 U1 小节。下面是原计划，保留作背景。

**目标**：这台必须 `--no-sandbox` 的机器解压即用；正常机器保持沙箱；启动器不再无条件降级。

**落地建议**

| 文件 | 改动 |
|---|---|
| `src/main/sandbox.ts`（新） | 读写 `userData/sandbox-state.json`：`{ compatMode, failStreak, probe: { pid, startedAt, ok } }`；`shouldDisableSandbox()`、`beginProbe()`、`markReady()`、`setCompatMode()`。用 tmp+rename 写，坏文件按默认值处理 |
| `src/main/index.ts` | **模块顶层、`app.whenReady()` 之前**：`shouldDisableSandbox()` 为真时 `app.commandLine.appendSwitch('no-sandbox')` + `appendSwitch('disable-gpu-sandbox')`；`beginProbe()` 写 pid/startedAt/ok=false；窗口 `ready-to-show` 后 `markReady()`（ok=true、failStreak=0、清 probe） |
| `scripts/Launcher.cs` | 读 `%APPDATA%\\WordMemo\\sandbox-state.json`（与数据同处；启动器没有 Electron 的 `app.getPath`，用 `Environment.GetFolderPath(SpecialFolder.ApplicationData)` 拼）。只有 `compatMode === true` 才加 `--no-sandbox`；否则不加 |
| 设置页「高级与诊断」 | 「兼容模式」开关 + 一句解释 + 「重新检测」（关掉后下次启动按正常模式试）；IPC：`sandbox:get` / `sandbox:setCompat` |
| 首启提示 | 首次自动降级时给一条 `warn`（常驻铃铛）："检测到系统不支持沙箱，已切到兼容模式（功能不变，安全性略降）" |

**关键判断**

- 探针只在「`probe.ok === false` 且 pid 已不存在且 startedAt 距今 < 30 秒」时算一次失败，避免把正常退出/长时间运行算进去。
- 连续 3 次失败才 `compatMode = true`；正常启动一次就清零。这个「先崩 3 次再自愈」是已知代价，写进 README/Issue 模板。
- **启动器无条件传 `--no-sandbox` 会让 U1 失去意义**，必须改成按文件判断。第一次在新机器上崩 3 次后才切兼容模式，是 §3.3 三保险里的第 ③ 条在兜底。
- 直接双击 `app/WordMemo.exe` 时启动器不参与：靠主进程的 `appendSwitch`（①）+ 探针（③）。

**验收**

1. 本机（沙箱不可用）：删掉 `%APPDATA%\WordMemo\sandbox-state.json` → 连续启动 3 次（前几次允许失败）→ 第 4 次双击启动器能开；文件里 `compatMode: true`；设置页能看到开关。
2. 正常机器（或把 compatMode 手动置 false 后）：应用带沙箱启动，`process.argv` 里没有 `--no-sandbox`，`sandbox-state.json` 的 `failStreak = 0`。
3. 三种入口都能开：启动器、直接双击 `app/WordMemo.exe`、开始菜单/快捷方式。
4. `npm test` 覆盖 `sandbox.ts` 的判定函数（见 §6 的单元测试清单）。

### 11.3 U2 自更新（1.5~2 天）

**目标**：应用只下载+校验+解压；启动器换目录；失败回滚；数据不丢。

**应用侧（`src/main/updater.ts` 新）**

- 启动 60 秒后检查 `https://github.com/DepthRecur/wordmemo/releases/latest/download/latest.json`（静态资源，不吃 API 限额）；24h 一次；失败退避 1h→2h→4h→6h（可直接抄 Rocket.Chat 的 `updateCheckSchedule.ts`，MIT，36 行）。
- `!app.isPackaged` 时整个模块不初始化（dev 下也没有 `app/version.json`）。
- 流程：GET `latest.json` → 版本比较 → 下载 zip 到 `<程序目录>/update/<name>.zip`（**流式**算 sha256）→ 与 `latest.json.sha256` 比对 → 解压到 `update/app-new` → 校验 `app-new/WordMemo.exe` 和 `app-new/version.json` 的版本 → 写 `update/state.json = { ready: true, version, downloadedAt }` → 托盘/设置页提示「已下载，下次启动生效」。
- **不要**在应用里替换 `app/`、不要 `quitAndInstall`、不要静默重启。
- 解压优先用系统 `tar.exe -xf`（与 `make-portable.mjs` 一致，零依赖）；失败再评估 `adm-zip`（MIT）。下载中途失败要删半截文件。
- 网络/403/404/JSON 坏掉：自动检查静默，手动检查给人话原因；45s 超时 + 一次重试。

**启动器侧（`scripts/Launcher.cs` 扩到 ~250 行）**

严格按 §3.11 的 7 步：
1. 读 `app/version.json` 与 `update/state.json`；`state.version` 不新于当前 → 删 `app-new`，直接启动。
2. 校验 `app-new`（exe + version.json 版本一致）。
3. 上次的 `app-old` 存在 → 删（说明上次换成功后启动过）。
4. `app` → `app-old`（同盘 rename）。
5. `app-new` → `app`。
6. 启动 `app/WordMemo.exe`（清 `ELECTRON_RUN_AS_NODE`；是否带 `--no-sandbox` 看 U1 的 compatMode）。
7. 写 `update/state.json = { ready:false }`；`app-old` 保留到下次启动再删。

任一步失败：回滚 `app-old → app`，写 `update/error.log`，启动旧版并提示「更新失败，已用回旧版」。

**`latest.json` 格式（我们自定义，不用 `latest.yml`）**

```json
{ "version": "0.4.0", "zip": "WordMemo-0.4.0-portable.zip", "sha256": "…", "notes": "修复…" }
```

**验收**（对应 §5 U2 的四条）：0.4.0 解压 → 发 0.4.1 → 提示 → 下载 → 重启 → 启动器换目录 → 版本号变、词库/进度/设置全在；sha256 改坏 → 不产生 `app-new`；`app-new` 半截 → 启动器回滚且能开；断网 → 不报错不卡启动。

**坑**

- `update/` 在**程序目录**里，便携版可能被解压到只读位置（`Program Files`、只读 U 盘）→ 下载前先探测可写，失败就只提示「手动下载」。
- 版本比较用 semver 风格（`0.1.10 > 0.1.9`），不要字符串比较；预发布号按「比同版本正式版小」处理。
- 下载/解压期间不要让用户退出后留下半截 `app-new`：启动器第 2 步校验不过就删。
- `app-old` 必须保留到**下一次启动成功后**再删，否则换完第一次启动崩溃就没有回滚副本。

### 11.4 U3 CI 发版 + 路线 B（1 天）

- `.github/workflows/release.yml`：只 `tag v*` 触发（+ 手动 dry-run）；`npm ci` → `typecheck` → `test` → `build` → `npm run dist` → 生成 `latest.json`（版本、zip 名、sha256、notes）→ 上传 `WordMemo-x.y.z-portable.zip`、`.sha256`、`latest.json` 到 Release。
- `permissions: contents: write`；**不要** PR 触发；dry-run 不发布。
- README：写清自动（正常）与手动（关程序 → 解压覆盖 `app/`）两条路；数据在 `%APPDATA%\WordMemo`，删程序目录不删词库；SmartScreen「更多信息 → 仍要运行」截图；sha256/VirusTotal。
- Release Notes 三行：是否迁移数据（U1/U2 不改 schema，U3 发版时确认）、是否不可逆、修了什么。
- 验收：Release 三件套齐全；从零解压能用；按 README 手动覆盖也能用；CI 在 test 失败时不发布。

### 11.5 单元测试清单（`tests/updater.test.ts` 新）

- 版本比较（`0.1.10 > 0.1.9`、预发布号、相等）。
- 跳过版本（`skippedVersions` 数组；手动检查穿透跳过）。
- 检查节流（24h 内不重复；失败退避 1h→6h；时钟回拨）。
- 兼容模式判定（给定 `sandbox-state.json` 内容与 pid 状态 → 是否 `compatMode`）。
- 备份命名/触发（复用 `backupBeforeMigrate` 的思路，U2 不需要新迁移）。
- 不测：真实下载、真实换目录（放手动验收清单）。

### 11.6 明确不要做

- 不要引入 `electron-updater` / NSIS / `latest.yml` / 差分下载（§3.1~3.10 只是资料）。
- 不要签名、不要自建更新服务器/镜像、不要遥测、不要强制更新、不要静默重启。
- 不要动 `userData` 位置（`%APPDATA%\WordMemo`）；不要让数据落进程序目录。
- 不要把 `app/` 的替换放进 Electron 进程里做。
- 不要在 U1 里顺手改其它功能（本版只做兼容模式）。

