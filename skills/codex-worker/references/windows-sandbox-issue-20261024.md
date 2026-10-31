# Windows elevated 沙箱授权故障（待处理）

记录日期：2026-10-24。状态：底层 Windows ACL 尚未修复；后续已按用户授权将指派脚本默认权限调整为全访问，独立会话验证通过。下文保留当时诊断，诊断时未续接或停止业务任务。当前操作方式以 [Fast 与权限](fast-and-permissions.md) 为准。

## 现象与证据

- `report-s1` 首轮以 `gpt-6.1-sol / max / workspace-write` 在 `D:/dev/code/fms-p275` 执行，读取正常，但 apply_patch 与 PowerShell 写入 `fms/fms-platform/.../FtsProcedureService.java` 均失败，返回 Access denied。任务正常生成报告，但业务实现未完成。
- `report-probe` 改以 `D:/dev/code/fms-p275/fms` 为 cwd，仍为 workspace-write，命令启动前即报 `helper_unknown_error: setup refresh had errors`。
- `C:/Users/OMEN/.codex/config.toml` 的 `[windows] sandbox` 为 `elevated`。
- 父目录 `D:/dev/code/fms-p275` 有 CodexSandboxUsers 的可继承 Modify 授权；`fms` 和 `fms-front` 的 `AreAccessRulesProtected=true`，关闭了权限继承，且没有对应沙箱授权条目。
- 沙箱初始化日志明确记录：给 `D:/dev/code/fms-p275/fms` 授予写 ACE 时，`READ_CONTROL | WRITE_DAC` 被拒绝，Windows 错误码 5；更新 `.git` 的保护权限也失败。
- `C:/Program Files/nodejs/node.exe` 的 ACL 仅列出 SYSTEM、Administrators、当前用户 OMEN，没有沙箱账户/组的读取条目；先前沙箱命令也报告访问该路径被拒绝。

这说明直接阻塞发生在本机 Windows 沙箱和文件权限层，不能称为 Sol/max 模型权限问题。更深层的 ACL 管理或企业文件保护因素未经进一步验证，不猜测其来源。

## 当前任务与边界

2026-10-24 14:06（UTC+8）检查时，Claude 已将原会话 `01a16c78-8cda-7af1-9d76-2ef371fb089a` 的 `report-s1` 第二轮改为 `-Mode yolo`，状态 running，已有命令成功执行。切换由原调度任务执行，本诊断没有切换权限。

YOLO 关闭沙箱，不要求沙箱用户具备同样的访问权限，因此可能避开此次故障；不代表所有项目必须全访问，也不保证全部业务验证通过。`auto` 仍使用工作区沙箱，不能保证修复初始化失败。

诊断当时脚本默认保持 workspace-write；后续用户要求更新权限问题后，默认已改为 yolo。此前两轮只读冒烟未覆盖源码写入、Node 使用或构建，因此与本次故障并不矛盾。

## 后续处理

若后续需要恢复受限沙箱，应另开隔离验证任务，确认项目目录与 Node 目录的授权方式，检查 elevated 沙箱初始化，必要时按官方支持方式修复沙箱。不要在原任务运行中修改其 ACL、重启运行时或更改会话模式，也不要修改整个磁盘权限。当前全访问默认值来自用户后续授权。

完成后验证：项目内临时文件创建/删除、Node 与 Maven 启动、带超时的最小编译，以及正常/失败时所属进程清理。验证结果需实际记录，再将此问题标记为已解决。

## 日志位置

- 沙箱诊断：`C:/Users/OMEN/.codex/.sandbox/sandbox.2026-10-24.log`，约第 373、389 行。
- 沙箱错误：`C:/Users/OMEN/.codex/.sandbox/setup_error.json`。
- 首轮报告：`D:/dev/code/fms-p275/work/alpha/logs/report-s1/codex-20261024-135320-253-8cf2d2.final.md`。
- 独立探针：`D:/dev/code/fms-p275/fms/work/alpha/logs/report-probe/codex-20261024-140022-818-f66036.final.md`。
- 原任务续接：`D:/dev/code/fms-p275/work/alpha/logs/report-s1/codex-20261024-140448-984-ac46d9.status.json`。
- [官方 Windows 沙箱说明](https://learn.chatgpt.com/docs/windows/windows-sandbox)。
