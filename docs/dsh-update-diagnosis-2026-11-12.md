# DSH Desktop 更新失败诊断（2026-11-12）

诊断范围：本机从 0.2.2-rc.1 更新到 0.2.2-rc.2 后未恢复运行。时间均为北京时间（UTC+08:00）。

## 结论

本次更新的直接失败点是安装器无法重命名旧安装目录：MoveFileExW 返回 Windows 错误 32，提示另一个进程正在使用文件。两次更新均在备份安装目录时失败；新版本没有替换成功。现有 rc.1 经限时启动检查可以进入工作区。因此现有证据支持“更新安装失败，重启流程没有完成”，不支持“rc.2 安装成功后启动崩溃”。

## 已核实证据

| 时间/检查项 | 结果 |
| --- | --- |
| 17:05:12 更新缓存 | pending/update-info.json 指向 deepseek-harness-0.2.2-rc.2-win-x64.exe |
| 17:06:11 首次安装失败 | MoveFileExW，Windows error 32；备份目录重试 10 次均失败 |
| 18:15:02 再次安装失败 | 同一操作、同一错误；再次重试 10 次均失败 |
| 安装版本 | EXE FileVersion、app.asar/package.json、卸载注册表均为 0.2.2-rc.1 |
| 安装包完整性 | pending 安装包 SHA-512 与 update-info.json 一致 |
| 桌面快捷方式 | 指向仍存在的原安装目录和 DeepSeek Harness.exe |
| 18:21:03 启动检查 | 原安装位置的 rc.1 启动 |
| 18:21:14 启动检查 | 客户端自身 journal 记录 workspace-ready；从 started 起约 11.5 秒 |
| 探测结束 | 达到预设 45 秒观测时限后结束；Windows Job 清理报告 0 active processes。124 是探测时限退出码，不是客户端崩溃码 |

安装器失败日志：

- C:/Users/OMEN/AppData/Local/@deepseek-aidsh-desktop-updater/installer-logs/directory-failure-20261112-170611.log
- C:/Users/OMEN/AppData/Local/@deepseek-aidsh-desktop-updater/installer-logs/directory-failure-20261112-181502.log

共同关键字段：

```text
Operation: MoveFileExW
Windows error: 32 (另一个程序正在使用此文件，进程无法访问。)
Source: C:\Users\OMEN\AppData\Local\Programs\DeepSeek Harness
Destination: C:\Users\OMEN\AppData\Local\Programs\DeepSeek Harness.old-{随机 GUID}
Restoration error: 0
```

限时启动的最小原始验证记录：

```jsonl
{"schemaVersion":1,"sequence":0,"time":"2026-11-12T10:21:03.352Z","pid":48276,"version":"0.2.2-rc.1","event":"started"}
{"schemaVersion":1,"sequence":1,"time":"2026-11-12T10:21:04.892Z","pid":48276,"version":"0.2.2-rc.1","event":"state","phase":"available","targetVersion":"0.2.2-rc.2"}
{"schemaVersion":1,"sequence":2,"time":"2026-11-12T10:21:14.868Z","pid":48276,"version":"0.2.2-rc.1","event":"workspace-ready"}
```

## 因果解释与边界

客户端已安装代码在更新准备完成后调用 quitAndInstall(true, true)，将退出与重启交给外部安装器。结合上述日志，可推断此次表现为：客户端退出准备更新 → 安装器备份旧目录时遇到文件占用 → 更新中止 → 未完成更新后的重启。

日志没有记录占用者 PID。事后只读句柄扫描检查了 9533 个可访问的磁盘句柄，没有发现指向该安装目录的句柄；有 174 个进程无法访问。因此不能确认当时具体占用进程，也不能排除已经退出的进程、短暂占用或不可访问的进程。没有据此认定某个插件、杀毒软件或系统进程为责任方。

检查前桌面 logs 目录没有 11 月 12 日的新崩溃报告；最新一份是 11 月 9 日小说插件导入错误，不能作为本次更新失败的原因。此次 workspace-ready 仅证明旧版本能够完成启动，不代表完成所有插件业务验收，也未验证 rc.2 的运行兼容性。

## 建议处理顺序

1. 完全退出 DSH，并释放安装目录占用。若占用来源不明，重启 Windows 后、首次启动 DSH 前进行安装，可避免遗留进程继续占用。
2. 使用已下载且校验通过的安装包重新安装：C:/Users/OMEN/AppData/Local/@deepseek-aidsh-desktop-updater/pending/deepseek-harness-0.2.2-rc.2-win-x64.exe。
3. 安装完成后确认 EXE、应用内部版本都变成 0.2.2-rc.2，再验证启动。

本次仅诊断，没有执行更新安装、清空用户数据或修改插件代码。限时启动使用正常用户配置，可能按客户端正常行为更新缓存和运行状态。验证记录已归档到本文；临时诊断目录随后清理。
