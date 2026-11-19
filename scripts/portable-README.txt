WordMemo 便携版 v{{VERSION}}
================================

怎么用
1. 把整个文件夹放在你喜欢的位置（例如 D:\WordMemo-Portable），以后别在运行时移动它。
2. 双击 WordMemo.exe 启动。第一次运行 Windows 可能提示"未知发布者"，点"更多信息 → 仍要运行"。

数据在哪
词库、复习进度、设置、API Key 都在 %APPDATA%\WordMemo，不在这个文件夹里。
所以：删掉这个文件夹不会删词库；换新版本覆盖 app 文件夹也不影响数据。
想彻底卸载：删掉这个文件夹，再按需删除 %APPDATA%\WordMemo。

手动更新（现在唯一的方式；自动更新会在后续版本加入）
1. 退出 WordMemo（托盘图标右键 → 退出）。
2. 下载新版 zip。
3. 把新版 zip 里的 app 文件夹解压覆盖到这里的 app（如果覆盖不了，先把旧 app 改名为 app-old，再解压）。
4. 重新打开 WordMemo。数据不会丢。

注意
- 覆盖 app 前一定要先退出 WordMemo，否则文件被占用会覆盖失败。
- 不要只复制 WordMemo.exe 或只复制 app 的一部分，启动器需要完整的 app 目录。
