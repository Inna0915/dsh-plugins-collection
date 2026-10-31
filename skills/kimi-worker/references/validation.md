# 安装验证 · 2026-10-24

本机 Kimi Code CLI 2.3.1，入口 `C:/Users/OMEN/.kimi-code/bin/kimi.exe`。使用既有配置，真实会话 profile.bind 为 `kimi-code/kimi-for-coding`、thinkingEffort=max，permission.set_mode 为 auto。没有改动全局 Kimi 配置或登录信息。

已完成独立目录中的真实新建与续接：新建读取完整交接文件，创建、读取并删除 probe.txt；续接正确回答上一轮暗号 MAPLE-39，第二轮交接不包含该暗号。两轮 finished/0，原生 lastTurnReason=completed，无本次进程残留。

9 项离线验证通过：长中文文件交接、精确续接/模型覆盖、失败清理、超时清理、强杀父进程后的后代清理、同会话互斥、DryRun、拒绝缺少结束提示的部分输出、拒绝接管外部会话。测试不调用模型。

详情保存在 [live-verification.json](live-verification.json) 和 [offline-verification.json](offline-verification.json)。原生测试会话保留为验证历史，位置记录在 JSON 中；本任务临时工作目录在归档后清理，不再用于续接。

本次没有测试所有其他模型或业务仓库构建，业务结果仍需由 Claude 根据实际 diff 与验证结果验收。全局配置中的 max_retries_per_step 弃用警告不影响本次验证，未为消除警告修改用户配置。
