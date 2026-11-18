using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string electron = Path.Combine(root, @"node_modules\electron\dist\electron.exe");

        if (!File.Exists(electron))
        {
            MessageBox.Show(
                "找不到 Electron 运行时。\r\n\r\n请先在项目目录执行：npm install",
                "WordMemo",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        var psi = new ProcessStartInfo(electron)
        {
            Arguments = "\"" + root + "\" --no-sandbox",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        // 避免环境里残留 ELECTRON_RUN_AS_NODE 导致 Electron 以 Node 模式运行
        psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");

        try
        {
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show("启动失败：" + ex.Message, "WordMemo", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
