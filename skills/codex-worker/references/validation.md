# 2026-10-24 后续更新：全访问默认与 Fast

当前指派默认权限已按用户要求改为 yolo（danger-full-access），模型仍为 gpt-6.1-sol / max。显式 -Fast 的新建和 resume 均已实测：原生 thread_settings_applied 为 priority、permission_profile.type 为 disabled、approval_policy 为 never。续接同时完成实际文件创建、读取和删除。详情见 [Fast 与权限](fast-and-permissions.md) 和 [本次验证](live-verification-20261024.json)。

本轮 7 项离线回归通过；全局 config.toml 和原运行会话未改动。下文为此前安装/只读验证的历史记录，权限默认值以本节和当前 SKILL.md 为准。

补充切换验证：同一独立会话先明确应用 default，再通过 -Fast 续接，实际设置变为 priority，serviceTierVerified=true。测试工作目录在保留最小验证记录后清理；原生测试会话作为验证历史保留，其路径见 JSON 中的 appliedSettings.source。

# 验证范围

2026-10-24 在本机建立用户级安装。原脚本已完成七项离线回归：长中文输入与正常完成后的子进程清理、新建/续接参数、错误退出、超时清理、仅强杀调度器后的清理、并发续接锁、DryRun。全局安装拷贝相同脚本，并核对 SHA-256、技能格式及全局入口 DryRun。

用户在 FMS 项目完成两轮真实只读调用，本次再次读取对应状态、事件与 Codex 会话记录核对：

- 项目：`D:/dev/code/fms-p275/fms`。
- 会话：`01a16c4f-4572-75e3-bebe-dfb6dd0809e2`。
- 首轮运行：`codex-20261024-130815-210-7aead6`；约 107 秒。
- 续接运行：`codex-20261024-131103-139-0a10bb`；约 23 秒。
- 两轮 requestedModel/effort 为 `gpt-6.1-sol` / `max`，权限 read-only，finished/0，cleanupVerified=true，stderr 为空。
- Codex 本地会话两条 turn_context 同样记录 `model=gpt-6.1-sol`、`effort=max`。这是 CLI 会话层的记录，不是服务端独立证明。
- 用户已核验第二轮提示不含暗号，Codex 正确回答原暗号，说明原会话上下文成功续接。

## Token 统计修正

此会话的第二轮 `turn.completed.usage` 对应本地 token_count 的 `total_token_usage`，是会话累计数。

| 指标 | 第一轮累计 | 第二轮累计 | 第二轮新增 |
| --- | ---: | ---: | ---: |
| 输入 | 230379 | 286605 | 56226 |
| 缓存输入 | 189824 | 241920 | 52096 |
| 输出 | 4252 | 4577 | 325 |
| 推理输出 | 2191 | 2465 | 274 |

第二轮 `last_token_usage` 直接记录输入 56226、缓存输入 52096、输出 325，与累计差一致。不能将 286605 解释为第二轮独立输入，也不能用这些数值直接推算订阅额度或费用。

日志原位保留：`D:/dev/code/fms-p275/fms/work/alpha/logs/codex-smoke/`。
本地会话记录：`C:/Users/OMEN/.codex/sessions/2026/10/24/rollout-2026-10-24T13-08-21-01a16c4f-4572-75e3-bebe-dfb6dd0809e2.jsonl`。

后续真实写入任务发现了 Windows elevated 沙箱授权故障，已记录在 [待处理问题](windows-sandbox-issue-20261024.md)。只读冒烟结果仍有效，但不能据此判断源码写入和构建权限正常。完整业务修改、构建与测试、额外目录访问及数据库写入仍须分别验收。
