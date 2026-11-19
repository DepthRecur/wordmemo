using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

/// <summary>
/// WordMemo 便携版启动器（v0）。
///
/// 只做一件事：把 app\WordMemo.exe 拉起来。目录约定见 docs/PLAN-UPDATE.md §3.11：
///   WordMemo-Portable\
///     WordMemo.exe    ← 这个启动器
///     app\            ← 打包产物（可整体替换）
///     update\         ← 下载暂存（U2 起使用）
///
/// v0 不做换目录：自更新（下载 → 校验 → app-new → 换目录 → 回滚）在 U2 加。
/// 这里用 .NET Framework 4.x 自带编译器即可构建（scripts/build-launcher.mjs），
/// 不引入任何运行时依赖。
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

        var psi = new ProcessStartInfo(exe)
        {
            WorkingDirectory = appDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            // 这台机器（以及部分 Chromium 沙箱初始化失败的机器）必须带 --no-sandbox；
            // U1 会按 sandbox-state.json 的探测结果决定是否降级，v0 先统一带上。
            Arguments = "--no-sandbox"
        };
        // 环境里若残留 ELECTRON_RUN_AS_NODE，Electron 会以 Node 模式运行，
        // 报 "Cannot read properties of undefined (reading 'isPackaged')"。
        psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");

        try
        {
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            Fail("启动失败：" + ex.Message + "\r\n\r\n"
                + "可以试试直接双击 " + Path.Combine(AppFolderName, AppExeName) + " 看是否报错。");
        }
    }

    private static void Fail(string message)
    {
        MessageBox.Show(message, "WordMemo", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
