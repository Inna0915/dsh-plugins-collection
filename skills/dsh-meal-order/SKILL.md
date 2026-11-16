---
name: dsh-meal-order
description: 使用本机 DSH「饭否午晚」查询指定日期的午餐或晚餐状态，以及在用户明确要求报饭、报餐或订餐时提交指定餐次。
---

使用 PowerShell 7.5+ 运行本 Skill 的 `scripts/Meal.ps1`，通过正在运行的 DSH Desktop 访问饭否午晚。脚本默认发现本机 Desktop 监听端口，也可用 `-Port` 指定已经核实的本机 DSH Web 端口。饭点账号沿用插件设置。

日期以饭点服务的北京时间为准。`-Date` 接受 `today`、`tomorrow` 或 `YYYY-MM-DD`。其他相对日期先用查询返回的 `today` 换算。订餐需要明确午餐、晚餐或两餐，分别用 `LUNCH`、`DINNER`、`BOTH`。只说「报饭」而无法确定餐次时先询问。没有指定日期的单餐请求按当天处理。

```powershell
# 查今天午餐和晚餐
pwsh -NoProfile -File <Skill路径>/scripts/Meal.ps1 -Action status -Date today
# 预览明天的午餐
pwsh -NoProfile -File <Skill路径>/scripts/Meal.ps1 -Action order -Date tomorrow -Meal LUNCH
# 用户已明确要求订餐时，用预览返回的绝对日期、账号和端口提交
pwsh -NoProfile -File <Skill路径>/scripts/Meal.ps1 -Action order -Date <date> -Meal LUNCH -ExpectedUsername <username> -Port <port> -Apply
```

询问状态或预览时只运行相应的只读命令。用户已经明确要求订餐且预览有 `eligible` 项时，直接提交已授权的范围。提交会重新读取日历，跳过已订、主动选择不订、截止、锁定、没有餐次或不在公司的条目。保留现有账号、在公司状态和锁定状态。日期范围及按工作日批量订餐使用插件自己的批量界面。

按日期和餐次报告结果。`already_ordered` 表示原来已订，`ordered` 表示本次提交成功，`confirmed_after_error` 表示提交报错但日历核实已订，`unconfirmed` 表示需要核对。提交异常时脚本停止后续餐次并尝试查询一次，保留已确认结果，不重新发送 POST。
