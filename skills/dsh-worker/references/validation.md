# 安装验证 · 2026-10-24

## 后续权限复核

在独立目录重新调用当前全局脚本，保持 `magpie / clinepass/cline-pass/deepseek-v4.1-flash-1017 / max`。真实创建、读取、删除文件均成功；原生会话记录再次确认 `sandbox/mode=danger-full-access`、`approval/policy=never`，退出和进程清理正常。详见 [permission-verification.json](permission-verification.json)。默认值和桌面端配置均未改动。

当前脚本通过最后层 patch 同时设置 sandbox-policy、approval 和 permission.defaultPreset，并设置子进程环境 DSH_PERMISSION_MODE。续接使用自己的归属记录检查 Mode 一致，不会将一次更窄的权限参数误称为已改变旧会话权限。注意：这是本机 0.2.1-rc.2 的配置方式，不要追加该版本不支持的 --permission-mode 或 --yolo 参数。

已安装为 Claude Code 全局个人 skill `/dsh-worker`，适用于本机 VS Code Claude Code 插件及 CLI。

默认 `magpie / clinepass/cline-pass/deepseek-v4.1-flash-1017 / max`；权限 `danger-full-access`，审批 `never`。DSH npm 包 0.2.1-rc.2，使用已有 Node 24.22.1。

## 实际模型验证

完成了两组新建与续接，共 4 次真实调用，全部 finished / exitCode 0，completed 事件、非空最终结果和进程清理均通过。

- 第一组新会话实际创建、读取并删除 probe.txt；续接在不提供暗号、不调用工具的情况下正确回答 AMBER-64。
- 加入会话权限一致性检查后，第二组重新验证新建及续接；续接正确回答 CEDAR-52。
- 原生 DSH 会话的 request/header 记录 provider、model、reasoningEffort，与默认配置一致；sandbox/mode 和 approval/policy 分别为 danger-full-access 和 never。这是客户端会话证据，不是网关后端独立的模型身份证明。
- 原桌面端配置及 codex-worker 文件共 15 份 SHA256 校验一致，未操作原 Codex 执行进程。

详细结果、耗时和最小会话证据：[live-verification.json](live-verification.json)。测试中产生的 DSH 原生会话保留为验证历史，文件路径记录在该 JSON 的 sessionEvidence 中；不编辑 DSH 内部数据库清除历史。测试工作目录及中间交接文件在归档后删除，不能再从已删除的测试项目目录续接。

## 离线验证

7 组验证通过：长中文 stdin 和默认参数、模型/effort 覆盖及权限不一致拒绝、失败退出码、拒绝缺少 completed 的假成功、超时清理、同会话互斥及强制结束父进程后的后代清理、非法模型提前失败。结果：[offline-verification.json](offline-verification.json)。

离线测试没有调用模型，临时目录在 finally 中清理。正常、失败及超时路径均检查进程作业为空、临时配置覆盖文件已删除；强制终止后的文件由测试调用方按本任务路径清理。

## 使用边界

模型连接依赖已配置的本地 Magpie 网关。未验证所有其他模型组合，也未在 FMS 业务仓库执行构建或修改。后续每项业务任务仍需由 Claude Code 检查 diff 和实际测试结果。

DSH 原生会话会保留权限，所以续接要求 Mode 与首次调用一致；需要改权限时新建会话。模型和 effort 可以在续接时覆盖。桌面模型连接会按 provider 读取，默认模型选择则固定在 [defaults.json](../config/defaults.json)。
