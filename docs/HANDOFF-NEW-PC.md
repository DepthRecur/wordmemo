# 换电脑 / 重置系统时的交接清单

这份文档讲清楚：**哪些东西必须带走、哪些可以不要、新机器上怎么恢复**。
面向「这台电脑要重置，换一台继续开发」的场景。

---

## 1. 两个数据目录（别搞混）

| 场景 | 数据目录 | 说明 |
|---|---|---|
| 开发模式（`npm run dev`） | `<仓库>\.data\` | 项目内的 `.data`，已被 gitignore |
| 便携版（解压 zip 双击） | `%APPDATA%\WordMemo\` | 用户数据，删程序目录不影响它 |

同步、备份都是围绕这两个目录里的 `wordmemo.db`。

## 2. 必须带走的三样

1. **应用数据快照**：`wordmemo.db`（当前是数据库 **v5**）+ `settings.json` + `files\`
   （导入的原图/原件）+ `media\`（发音缓存，可不要）+ `backups\`。
2. **代码**：`git clone https://github.com/DepthRecur/wordmemo.git`（公开，历史完整，
   tag `v0.7.0` / `v0.7.1` 都在）。断网时用换机包里的 `wordmemo.bundle` 恢复。
3. **云端备份**：数据用应用的加密同步推到了私有仓库，新机器连同一个仓库 + 同步密码就能拉回。

**不用带**：`node_modules/`（`npm install` 重装）、`release/`（`npm run dist` 重新打）、
`out/`、`.cache/`、`.git/`（用 clone 或 bundle 代替）。

## 3. 换机后怎么恢复

两条路，任选一条：

- **从云端同步拉**（最省事）：装 0.7.1 → 设置 → 同步 → 填私有仓库 + 新 PAT + 同步密码 →
  「测试并首次同步」。会多出一个空的「默认库」，删掉即可。
- **从数据快照恢复**：把 `wordmemo.db` / `settings.json` / `files\` 放进
  `.data\`（开发）或 `%APPDATA%\WordMemo\`（便携版）。

## 4. 必须重新填的东西（换机器就失效）

`secrets.bin` / `secrets.v2.json` 是 **Windows DPAPI** 加密，只认「这台机器 + 这个用户」：

- AI 供应商的 API Key（设置 → AI 供应商）
- 同步用的 GitHub PAT 与同步密码
- 其它走 `safeStorage` 的凭据

`settings.json` 里的普通配置（模型、预算、提醒、复习参数）可以照用。

## 5. 两个容易踩的坑

- **数据库版本闸门**：v5 的库不能用 0.6.0 及更老的版本打开（会直接拒绝启动）。
  要回退就用 `backups\` 里的备份，或装回 0.7.1。
- **`--data-dir` 只对直接启动 `app\WordMemo.exe` 有效**：便携版启动器不转发参数，
  打包版也不认 `WORDMEMO_DATA_DIR`（只对开发模式生效）。详见 README「开发」一节。

## 6. 新机器上的自检

```powershell
npm install
npm run typecheck     # 0 错误
npm test              # 41 文件 / 324 项（313 通过 + 11 跳过），以实际输出为准
npm run dev           # 起来后确认笔记数、复习队列、设置都在
```

`npm test` 里真实仓库同步、真实库迁移两项按设计跳过，其余应当全绿。
