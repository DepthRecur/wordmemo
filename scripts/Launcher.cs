using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

/// <summary>
/// WordMemo 便携版启动器（U1 兼容模式 + U2 换目录）。
///
/// 职责（PLAN-UPDATE §3.11 / §11.3）：
/// 1. 还没启动 app 之前，先看 update/state.json 有没有「已下载、等下次启动生效」的新版本；
///    有就按七步换目录（app → app-old / app-new → app），失败回滚 + 写 update/error.log；
/// 2. 在 userData 的 sandbox-state.json 里维护「上一次启动是否成功」的 probe（U1）；
/// 3. 只有 compatMode === true 时才给 app 加 --no-sandbox / --disable-gpu-sandbox；
/// 4. 启动 app\WordMemo.exe，并把子进程 pid 写进 probe（成功由主进程 markReady 清掉）。
///
/// 应用（Electron）只负责下载/校验/解压，绝不替换自己；换目录只在这里做。
/// 这里没有任何网络代码：启动器永远不联网。
/// </summary>
internal static class Program
{
    private const string AppFolderName = "app";
    private const string AppExeName = "WordMemo.exe";

    [STAThread]
    private static void Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string appDir = Path.Combine(root, AppFolderName);
        string exe = Path.Combine(appDir, AppExeName);

        // 上次换目录中途断电：app 不在但 app-old 还在 → 先把旧版换回来，至少能启动
        string appOld = Path.Combine(root, PortableUpdate.AppOldFolderName);
        if (!Directory.Exists(appDir) && Directory.Exists(appOld))
        {
            try
            {
                Directory.Move(appOld, appDir);
            }
            catch
            {
                /* 恢复不了就按缺 app 处理 */
            }
        }

        if (!File.Exists(exe))
        {
            Fail("便携版不完整：找不到 " + Path.Combine(AppFolderName, AppExeName) + "。\r\n\r\n"
                + "请重新解压完整的 WordMemo 便携版 zip，不要只复制其中的一部分。");
            return;
        }

        // 已经有实例在跑：不要换目录（文件被占用），也不要写 probe（否则下一个真正启动会把它当成失败）
        bool alreadyRunning = AnotherInstanceRunning();
        UpdateOutcome update = UpdateOutcome.None;
        if (!alreadyRunning)
        {
            // 应用删不掉的旧暂存（杀软占着 app.asar 时会改名成 app-new-stale-*）；
            // 启动器在 app 之前跑，这时没人占着，顺手清掉
            PortableUpdate.SweepStale(root);
            update = PortableUpdate.Apply(root);
        }

        SandboxState state = SandboxState.Load();
        if (!alreadyRunning)
        {
            state.Evaluate();
            // 先写 probe（用启动器自己的 pid）再启动 app：
            // - app 能跑到 JS 就会用自己的 pid 覆盖它，ready 后清掉；
            // - app 连 JS 都没起来（U1 要覆盖的情况）就留下这条，下次启动由启动器算一次失败。
            state.probe = new SandboxProbe
            {
                pid = Process.GetCurrentProcess().Id,
                startedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                ok = false,
                source = "launcher"
            };
            state.Save();
        }

        bool started = false;
        try
        {
            Process child = StartApp(exe, appDir, state.compatMode);
            started = child != null;
            if (!started)
            {
                state.probe = null;
                state.Save();
            }
        }
        catch (Exception ex)
        {
            state.probe = null;
            state.Save();
            if (update == UpdateOutcome.Applied && PortableUpdate.RollbackAfterStartFailure(root))
            {
                // 新版本启动失败：旧版已经换回来了，再试一次旧版
                try
                {
                    started = StartApp(exe, appDir, state.compatMode) != null;
                }
                catch (Exception retry)
                {
                    Fail("启动失败：" + retry.Message + "\r\n\r\n"
                        + "可以试试直接双击 " + Path.Combine(AppFolderName, AppExeName) + " 看是否报错。");
                    return;
                }
            }
            else
            {
                Fail("启动失败：" + ex.Message + "\r\n\r\n"
                    + "可以试试直接双击 " + Path.Combine(AppFolderName, AppExeName) + " 看是否报错。");
                return;
            }
        }

        if (!started)
        {
            Fail("启动失败：无法创建 WordMemo 进程。");
            return;
        }

        // 换目录失败时旧版已经在跑，给用户一句人话（详情在 update\error.log）
        if (update == UpdateOutcome.Failed)
        {
            MessageBox.Show(
                "更新失败，已用回旧版。\r\n\r\n详情见程序目录下的 update\\error.log。",
                "WordMemo",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private static Process StartApp(string exe, string appDir, bool compatMode)
    {
        var psi = new ProcessStartInfo(exe)
        {
            WorkingDirectory = appDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            Arguments = compatMode ? "--no-sandbox --disable-gpu-sandbox" : string.Empty
        };
        // 环境里若残留 ELECTRON_RUN_AS_NODE，Electron 会以 Node 模式运行
        psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        return Process.Start(psi);
    }

    private static bool AnotherInstanceRunning()
    {
        int self = Process.GetCurrentProcess().Id;
        try
        {
            foreach (Process p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(AppExeName)))
            {
                try
                {
                    if (p.Id != self) return true;
                }
                finally
                {
                    p.Dispose();
                }
            }
        }
        catch
        {
            /* 查询失败就当成没有别的实例，至少不阻塞启动 */
        }
        return false;
    }

    private static void Fail(string message)
    {
        MessageBox.Show(message, "WordMemo", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}

internal enum UpdateOutcome
{
    /** 没有待装更新（或已经换完） */
    None,
    /** 已成功换到新版本 */
    Applied,
    /** 换目录失败，已回到旧版 */
    Failed
}

/// <summary>
/// U2 换目录（PLAN-UPDATE §3.11 的七步）：
/// 1. 读 app/version.json 与 update/state.json；版本不新于当前 → 删 app-new，直接启动
/// 2. 校验 app-new 完整（存在 WordMemo.exe + version.json 版本对得上）
/// 3. 上次的 app-old 存在 → 删（说明上次换成功后启动过）
/// 4. app → app-old（同盘 rename，原子）
/// 5. app-new → app
/// 6. 启动 app/WordMemo.exe（由调用方做，参数与 U1 共用）
/// 7. state.json 置 ready=false；app-old 保留到下次启动再删
/// 任一步失败：回滚 app-old → app，写 update/error.log，启动旧版。
/// </summary>
internal static class PortableUpdate
{
    public const string AppFolderName = "app";
    public const string AppNewFolderName = "app-new";
    public const string AppOldFolderName = "app-old";
    public const string AppExeName = "WordMemo.exe";
    public const string UpdateFolderName = "update";
    public const string StateFileName = "state.json";
    public const string ErrorLogFileName = "error.log";
    /** 正常的 app.asar 是 60~100 MB；小于 1 MB 必然是半截包 */
    private const long MinAsarBytes = 1024 * 1024;

    public static void SweepStale(string root)
    {
        try
        {
            foreach (string dir in Directory.GetDirectories(root, AppNewFolderName + "-stale-*"))
            {
                DeleteDirectory(dir);
            }
        }
        catch
        {
            /* 删不掉就留着，不影响启动 */
        }
        try
        {
            string updateDir = Path.Combine(root, UpdateFolderName);
            if (Directory.Exists(updateDir))
            {
                foreach (string dir in Directory.GetDirectories(updateDir, "staging-stale-*"))
                {
                    DeleteDirectory(dir);
                }
            }
        }
        catch
        {
            /* 同上 */
        }
    }

    public static UpdateOutcome Apply(string root)
    {
        string appDir = Path.Combine(root, AppFolderName);
        string appNew = Path.Combine(root, AppNewFolderName);
        string appOld = Path.Combine(root, AppOldFolderName);
        string updateDir = Path.Combine(root, UpdateFolderName);
        string stateFile = Path.Combine(updateDir, StateFileName);

        UpdateState state = UpdateState.Load(stateFile);
        if (state == null || !state.ready || string.IsNullOrEmpty(state.version))
        {
            // 没有待装更新：顺手清掉上一次残留的 app-new（半截/校验失败）
            DeleteDirectory(appNew);
            return UpdateOutcome.None;
        }

        string currentVersion = ReadVersion(appDir);

        // 1. 版本不新于当前（例如换完目录后又启动了一次）→ 删 app-new，直接启动
        if (VersionNumber.Compare(state.version, currentVersion) <= 0)
        {
            DeleteDirectory(appNew);
            WriteState(stateFile, false, null);
            return UpdateOutcome.None;
        }

        // 2. 校验 app-new：缺 exe / app.asar 半截 / version.json 对不上 / 不比当前新 → 不换，删掉
        //    杀软刚扫过解压出来的文件时会短暂拒绝访问，所以这里带几次重试
        bool appNewPresent = false;
        for (int attempt = 0; attempt < 4 && !appNewPresent; attempt++)
        {
            appNewPresent = Directory.Exists(appNew) && File.Exists(Path.Combine(appNew, AppExeName));
            if (!appNewPresent && attempt < 3) System.Threading.Thread.Sleep(250);
        }
        if (!appNewPresent)
        {
            Log(updateDir, "ERROR", "app-new 不存在或不完整（state.version=" + state.version + "），本次不更新");
            DeleteDirectory(appNew);
            WriteState(stateFile, false, state.version);
            return UpdateOutcome.Failed;
        }
        // 半截解压最常见的形态：exe/version.json 都在，app.asar 没解完
        bool asarOk = false;
        for (int attempt = 0; attempt < 4 && !asarOk; attempt++)
        {
            try
            {
                string asarPath = Path.Combine(appNew, "resources", "app.asar");
                asarOk = File.Exists(asarPath) && new FileInfo(asarPath).Length >= MinAsarBytes;
            }
            catch
            {
                asarOk = false;
            }
            if (!asarOk && attempt < 3) System.Threading.Thread.Sleep(250);
        }
        if (!asarOk)
        {
            Log(updateDir, "ERROR", "app-new 不完整：resources\\app.asar 缺失或过小，本次不更新");
            DeleteDirectory(appNew);
            WriteState(stateFile, false, state.version);
            return UpdateOutcome.Failed;
        }
        string newVersion = null;
        for (int attempt = 0; attempt < 4; attempt++)
        {
            newVersion = ReadVersion(appNew);
            if (VersionNumber.Parse(newVersion) != null) break;
            if (attempt < 3) System.Threading.Thread.Sleep(250);
        }
        if (VersionNumber.Compare(newVersion, state.version) != 0
            || VersionNumber.Compare(newVersion, currentVersion) <= 0)
        {
            Log(updateDir, "ERROR",
                "app-new 版本校验失败：version.json=" + (newVersion == null ? "<缺失>" : newVersion)
                + "，state.version=" + state.version + "，当前版本=" + (currentVersion == null ? "<未知>" : currentVersion));
            DeleteDirectory(appNew);
            WriteState(stateFile, false, state.version);
            return UpdateOutcome.Failed;
        }

        // 3. 上次的 app-old 删掉（说明上次换成功后启动过）；删不掉就不换，免得没法回滚
        if (Directory.Exists(appOld) && !DeleteDirectory(appOld))
        {
            Log(updateDir, "ERROR", "无法删除上次的 app-old（可能被占用），本次不更新");
            DeleteDirectory(appNew);
            WriteState(stateFile, false, state.version);
            return UpdateOutcome.Failed;
        }

        // 4. app → app-old（同一盘符，rename 是原子的）
        try
        {
            Directory.Move(appDir, appOld);
        }
        catch (Exception ex)
        {
            Log(updateDir, "ERROR", "无法把 app 改名为 app-old：" + ex.Message);
            DeleteDirectory(appNew);
            WriteState(stateFile, false, state.version);
            return UpdateOutcome.Failed;
        }

        // 5. app-new → app
        try
        {
            Directory.Move(appNew, appDir);
        }
        catch (Exception ex)
        {
            Log(updateDir, "ERROR", "无法把 app-new 改名为 app：" + ex.Message);
            try
            {
                Directory.Move(appOld, appDir);
            }
            catch (Exception rollback)
            {
                Log(updateDir, "ERROR", "回滚失败（app-old 还在，可以手动改名）：" + rollback.Message);
            }
            DeleteDirectory(appNew);
            WriteState(stateFile, false, state.version);
            return UpdateOutcome.Failed;
        }

        // 7. 换成新版了：ready 置 false，app-old 保留到下一次启动再删
        WriteState(stateFile, false, newVersion);
        Log(updateDir, "INFO", "已换到 " + newVersion + "（旧版保留在 app-old，下次启动删除）");
        return UpdateOutcome.Applied;
    }

    /// <summary>
    /// 新版本启动失败时回滚：把刚换上的版本挪到 app-new，app-old 换回 app。
    /// 返回 true = 已经恢复到旧版，调用方可以再启动一次。
    /// </summary>
    public static bool RollbackAfterStartFailure(string root)
    {
        string appDir = Path.Combine(root, AppFolderName);
        string appNew = Path.Combine(root, AppNewFolderName);
        string appOld = Path.Combine(root, AppOldFolderName);
        string updateDir = Path.Combine(root, UpdateFolderName);
        if (!Directory.Exists(appOld))
        {
            Log(updateDir, "ERROR", "新版本启动失败，但 app-old 不在，无法回滚");
            return false;
        }
        try
        {
            DeleteDirectory(appNew);
            Directory.Move(appDir, appNew);
        }
        catch (Exception ex)
        {
            Log(updateDir, "ERROR", "新版本启动失败后无法挪开 app：" + ex.Message);
            return false;
        }
        try
        {
            Directory.Move(appOld, appDir);
        }
        catch (Exception ex)
        {
            Log(updateDir, "ERROR", "新版本启动失败后回滚失败：" + ex.Message);
            try
            {
                Directory.Move(appNew, appDir);
            }
            catch
            {
                /* 两个都动不了就只能让用户手动处理 */
            }
            return false;
        }
        Log(updateDir, "ERROR", "新版本启动失败，已回滚到旧版（新版本留在 app-new，下次启动会删）");
        return true;
    }

    public static string ReadVersion(string appDir)
    {
        try
        {
            string file = Path.Combine(appDir, "version.json");
            if (!File.Exists(file)) return null;
            var serializer = new JavaScriptSerializer();
            VersionFile parsed = serializer.Deserialize<VersionFile>(File.ReadAllText(file));
            if (parsed == null || string.IsNullOrEmpty(parsed.version)) return null;
            return parsed.version.Trim();
        }
        catch
        {
            return null;
        }
    }

    private static void WriteState(string stateFile, bool ready, string version)
    {
        try
        {
            var next = new UpdateState
            {
                ready = ready,
                version = version,
                downloadedAt = null,
                sha256 = null
            };
            string dir = Path.GetDirectoryName(stateFile);
            Directory.CreateDirectory(dir);
            string tmp = stateFile + ".tmp";
            var serializer = new JavaScriptSerializer();
            // 不带 BOM：应用主进程用 JSON.parse 读这份文件，BOM 会让它解析失败
            File.WriteAllText(tmp, serializer.Serialize(next));
            if (File.Exists(stateFile))
            {
                File.Replace(tmp, stateFile, null, true);
            }
            else
            {
                File.Move(tmp, stateFile);
            }
        }
        catch (Exception ex)
        {
            // 写不了 state.json 不能让启动挂掉；下次启动会按旧状态再试
            Log(Path.GetDirectoryName(stateFile), "ERROR", "写 state.json 失败：" + ex.Message);
        }
    }

    private static void Log(string updateDir, string level, string message)
    {
        try
        {
            Directory.CreateDirectory(updateDir);
            string file = Path.Combine(updateDir, ErrorLogFileName);
            try
            {
                if (File.Exists(file) && new FileInfo(file).Length > 512 * 1024) File.Delete(file);
            }
            catch
            {
                /* 删不掉就继续追加 */
            }
            string line = "[" + DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + "] "
                + level + " " + message + "\r\n";
            File.AppendAllText(file, line, Encoding.UTF8);
        }
        catch
        {
            /* 日志失败不影响启动 */
        }
    }

    private static bool DeleteDirectory(string dir)
    {
        if (!Directory.Exists(dir)) return true;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                Directory.Delete(dir, true);
                return true;
            }
            catch
            {
                System.Threading.Thread.Sleep(200);
            }
        }
        return !Directory.Exists(dir);
    }
}

/// <summary>update/state.json：应用写 ready=true，启动器换完目录后写 ready=false</summary>
internal sealed class UpdateState
{
    public bool ready { get; set; }
    public string version { get; set; }
    public string downloadedAt { get; set; }
    public string sha256 { get; set; }

    public static UpdateState Load(string file)
    {
        try
        {
            if (!File.Exists(file)) return null;
            string text = File.ReadAllText(file);
            if (string.IsNullOrWhiteSpace(text)) return null;
            var serializer = new JavaScriptSerializer();
            return serializer.Deserialize<UpdateState>(text);
        }
        catch
        {
            return null;
        }
    }
}

internal sealed class VersionFile
{
    public string version { get; set; }
    public string builtAt { get; set; }
}

/// <summary>
/// semver 风格的版本比较：0.1.10 > 0.1.9；预发布号小于同版本正式版。
/// 与 src/main/updater.ts 的 compareVersions 保持同一套规则（两边都是纯字符串，不依赖 Packaged app）。
/// </summary>
internal sealed class VersionNumber
{
    private static readonly Regex Pattern = new Regex(
        @"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$",
        RegexOptions.CultureInvariant);

    public int major { get; set; }
    public int minor { get; set; }
    public int patch { get; set; }
    public List<string> prerelease { get; set; }

    private VersionNumber()
    {
        prerelease = new List<string>();
    }

    public static VersionNumber Parse(string text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        Match match = Pattern.Match(text.Trim());
        if (!match.Success) return null;
        var value = new VersionNumber();
        value.major = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
        value.minor = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
        value.patch = int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
        if (match.Groups[4].Success)
        {
            foreach (string part in match.Groups[4].Value.Split(
                new char[] { '.' }, StringSplitOptions.RemoveEmptyEntries))
            {
                value.prerelease.Add(part);
            }
        }
        return value;
    }

    /// <summary>无效版本排在所有有效版本之前（两个无效 = 0）</summary>
    public static int Compare(string a, string b)
    {
        VersionNumber left = Parse(a);
        VersionNumber right = Parse(b);
        if (left == null && right == null) return 0;
        if (left == null) return -1;
        if (right == null) return 1;
        if (left.major != right.major) return left.major < right.major ? -1 : 1;
        if (left.minor != right.minor) return left.minor < right.minor ? -1 : 1;
        if (left.patch != right.patch) return left.patch < right.patch ? -1 : 1;

        if (left.prerelease.Count == 0 && right.prerelease.Count == 0) return 0;
        if (left.prerelease.Count == 0) return 1;
        if (right.prerelease.Count == 0) return -1;
        int size = Math.Max(left.prerelease.Count, right.prerelease.Count);
        for (int i = 0; i < size; i++)
        {
            if (i >= left.prerelease.Count) return -1;
            if (i >= right.prerelease.Count) return 1;
            string l = left.prerelease[i];
            string r = right.prerelease[i];
            long ln;
            long rn;
            bool leftNumeric = long.TryParse(l, NumberStyles.None, CultureInfo.InvariantCulture, out ln);
            bool rightNumeric = long.TryParse(r, NumberStyles.None, CultureInfo.InvariantCulture, out rn);
            if (leftNumeric && rightNumeric)
            {
                if (ln != rn) return ln < rn ? -1 : 1;
                continue;
            }
            if (leftNumeric) return -1;
            if (rightNumeric) return 1;
            int cmp = string.CompareOrdinal(l, r);
            if (cmp != 0) return cmp < 0 ? -1 : 1;
        }
        return 0;
    }
}

internal sealed class SandboxProbe
{
    // 属性名故意用小写：和 Electron 写的 JSON 字段一一对应，不需要再映射
    public int pid { get; set; }
    public string startedAt { get; set; }
    public bool ok { get; set; }
    /** app / launcher：主进程看到 launcher 的 probe 不会重复计数 */
    public string source { get; set; }
}

internal sealed class SandboxState
{
    private const string DataFolderName = "WordMemo";
    private const string StateFileName = "sandbox-state.json";
    private const int MaxFailStreak = 3;
    private const int ProbeWindowSeconds = 30;

    public bool compatMode { get; set; }
    public int failStreak { get; set; }
    public SandboxProbe probe { get; set; }
    public bool autoEnabled { get; set; }
    public bool noticeSeen { get; set; }
    public string lastReadyAt { get; set; }

    private static bool TryParseUtc(string text, out DateTime parsed)
    {
        return DateTime.TryParse(
            text,
            CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind,
            out parsed);
    }

    private static string DataDir
    {
        get
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                DataFolderName);
        }
    }

    private static string StatePath
    {
        get { return Path.Combine(DataDir, StateFileName); }
    }

    public static SandboxState Load()
    {
        try
        {
            string file = StatePath;
            if (!File.Exists(file)) return new SandboxState();
            string text = File.ReadAllText(file);
            if (string.IsNullOrWhiteSpace(text)) return new SandboxState();
            var serializer = new JavaScriptSerializer();
            SandboxState state = serializer.Deserialize<SandboxState>(text);
            if (state == null) return new SandboxState();
            if (state.failStreak < 0) state.failStreak = 0;
            return state;
        }
        catch
        {
            // 坏文件按默认值处理；下一次 Save 会覆盖它
            return new SandboxState();
        }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(DataDir);
            var serializer = new JavaScriptSerializer();
            string json = serializer.Serialize(this);
            string file = StatePath;
            string tmp = file + ".tmp";
            File.WriteAllText(tmp, json);
            if (File.Exists(file))
            {
                File.Replace(tmp, file, null, true);
            }
            else
            {
                File.Move(tmp, file);
            }
        }
        catch
        {
            // 状态写不进去不能影响启动；应用主进程还会再写一次
        }
    }

    /// <summary>
    /// 只统计「上次 probe.ok=false，进程已不在，且启动后 30 秒内就没了」的失败。
    /// 连续 3 次才打开 compatMode；成功启动一次（主进程 markReady）会清零。
    /// </summary>
    public void Evaluate()
    {
        if (compatMode)
        {
            if (probe != null && probe.ok)
            {
                probe = null;
                failStreak = 0;
            }
            return;
        }

        if (probe == null) return;
        if (probe.ok)
        {
            probe = null;
            failStreak = 0;
            return;
        }
        if (probe.pid <= 0 || ProgramAlive(probe.pid)) return;

        DateTime started;
        if (!TryParseUtc(probe.startedAt, out started)) return;
        DateTime now = DateTime.UtcNow;
        TimeSpan age = now - started.ToUniversalTime();
        if (age < TimeSpan.Zero || age >= TimeSpan.FromSeconds(ProbeWindowSeconds)) return;

        DateTime ready;
        if (!string.IsNullOrEmpty(lastReadyAt)
            && TryParseUtc(lastReadyAt, out ready)
            && started.ToUniversalTime() <= ready.ToUniversalTime())
        {
            // 启动器在应用已经 ready 之后才写的 probe，不算失败
            return;
        }

        failStreak++;
        probe = null;
        if (failStreak >= MaxFailStreak)
        {
            failStreak = MaxFailStreak;
            compatMode = true;
            autoEnabled = true;
            noticeSeen = false;
        }
    }

    private static bool ProgramAlive(int pid)
    {
        if (pid <= 0) return false;
        try
        {
            using (Process p = Process.GetProcessById(pid))
            {
                return !p.HasExited;
            }
        }
        catch
        {
            return false;
        }
    }
}
