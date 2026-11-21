using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Forms;

/// <summary>
/// WordMemo 便携版启动器（U1：按 sandbox-state.json 决定是否降级）。
///
/// 职责（PLAN-UPDATE §3.11 / §11.2）：
/// 1. 在 userData 的 sandbox-state.json 里维护「上一次启动是否成功」的 probe；
/// 2. 只有 compatMode === true 时才给 app 加 --no-sandbox / --disable-gpu-sandbox；
/// 3. 启动 app\WordMemo.exe，并把子进程 pid 写进 probe（成功由主进程 markReady 清掉）。
///
/// 为什么失败计数放在启动器：有些机器上 Electron 在加载 JS 之前就直接退出，
/// 主进程根本没机会写 probe；启动器是唯一在崩溃前一定跑过的代码。
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

        if (!File.Exists(exe))
        {
            Fail("便携版不完整：找不到 " + Path.Combine(AppFolderName, AppExeName) + "。\r\n\r\n"
                + "请重新解压完整的 WordMemo 便携版 zip，不要只复制其中的一部分。");
            return;
        }

        // 已经有实例在跑：不要再写 probe（否则下一个真正启动会把它当成失败）
        bool alreadyRunning = AnotherInstanceRunning();
        SandboxState state = SandboxState.Load();
        if (!alreadyRunning)
        {
            state.Evaluate();
            // 先写 probe（用启动器自己的 pid）再启动 app：
            // - app 能跑到 JS 就会用自己的 pid 覆盖它，ready 后清掉；
            // - app 连 JS 都没起来（本 U1 要覆盖的情况）就留下这条，下次启动由启动器算一次失败。
            // 不写子进程 pid 是因为 Process.Start 之后 app 可能已经 ready，避免和 markReady 竞态。
            state.probe = new SandboxProbe
            {
                pid = Process.GetCurrentProcess().Id,
                startedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                ok = false,
                source = "launcher"
            };
            state.Save();
        }

        var psi = new ProcessStartInfo(exe)
        {
            WorkingDirectory = appDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            Arguments = state.compatMode ? "--no-sandbox --disable-gpu-sandbox" : string.Empty
        };
        // 环境里若残留 ELECTRON_RUN_AS_NODE，Electron 会以 Node 模式运行
        psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");

        try
        {
            Process child = Process.Start(psi);
            if (child == null)
            {
                state.probe = null;
                state.Save();
                Fail("启动失败：无法创建 WordMemo 进程。");
            }
        }
        catch (Exception ex)
        {
            state.probe = null;
            state.Save();
            Fail("启动失败：" + ex.Message + "\r\n\r\n"
                + "可以试试直接双击 " + Path.Combine(AppFolderName, AppExeName) + " 看是否报错。");
        }
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
