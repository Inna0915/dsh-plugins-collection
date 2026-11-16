#Requires -Version 7.5
[CmdletBinding()]
param(
    [ValidateSet('status', 'order')][string]$Action = 'status',
    [string]$Date = 'today',
    [ValidateSet('LUNCH', 'DINNER', 'BOTH')][string]$Meal = 'BOTH',
    [ValidateRange(1, 65535)][int]$Port,
    [switch]$Apply,
    [string]$ExpectedUsername
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Invoke-MealApi([int]$HostPort, [string]$Route, [hashtable]$Body) {
    $parameters = @{
        Uri = "http://127.0.0.1:$HostPort/meal/api/$Route"
        TimeoutSec = 15
        NoProxy = $true
        MaximumRedirection = 0
        SkipHttpErrorCheck = $true
    }
    if ($null -ne $Body) {
        $parameters.Method = 'Post'
        $parameters.ContentType = 'application/json; charset=utf-8'
        $parameters.Body = ConvertTo-Json -Compress -InputObject $Body
    }
    $response = Invoke-WebRequest @parameters
    $payload = ConvertFrom-Json -InputObject $response.Content -DateKind String
    if ($response.StatusCode -ne 200 -or $payload.ok -ne $true) {
        throw ($payload.error.message ?? "饭否午晚请求失败（HTTP $($response.StatusCode)）")
    }
    $payload.value
}

function Find-MealPort {
    $processIds = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if (!$processIds.Count) { throw '请先启动 DeepSeek Harness Desktop' }
    $listeners = Get-NetTCPConnection -LocalAddress '127.0.0.1' -State Listen -OwningProcess $processIds -ErrorAction SilentlyContinue
    $candidates = @(foreach ($listener in $listeners | Sort-Object LocalPort -Unique) {
        try {
            $health = Invoke-MealApi $listener.LocalPort 'health'
            if ($health.batchAccountGuard -eq $true) { $listener.LocalPort }
        } catch { continue }
    })
    if ($candidates.Count -ne 1) { throw '未找到唯一的饭否午晚接口，请核对 DSH 插件是否已启用，或指定已核实的本机端口' }
    $candidates[0]
}

function Test-MealDate([string]$Value) {
    $parsed = [DateOnly]::MinValue
    [DateOnly]::TryParseExact($Value, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsed)
}

function Get-MealCalendar([string]$Month) {
    $route = if ($Month) { "panel?month=$Month" } else { 'panel' }
    $calendar = Invoke-MealApi $Port $route
    if ($calendar.configured -ne $true -or $calendar.username -cne $identity.username -or
        $calendar.profile.username -cne $identity.username -or $calendar.baseUrl -cne $identity.baseUrl -or
        ($Month -and $calendar.month -cne $Month)) {
        throw '饭点账号、服务地址或日历月份已变化，请重新查询'
    }
    if (!(Test-MealDate $calendar.today) -or $calendar.days -isnot [array]) { throw '饭点返回的日历不完整' }
    $calendar
}

function Get-MealTime([string]$Value) {
    if ($Value -notmatch '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}') { throw '饭点返回的时间无法识别' }
    if ($Value -notmatch '(?:Z|[+-]\d{2}:?\d{2})$') { $Value += '+08:00' }
    [DateTimeOffset]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture)
}

function Get-MealState($Calendar, [string]$MealType) {
    $day = $Calendar.days | Where-Object date -CEQ $targetDate | Select-Object -First 1
    $entry = $day.meals | Where-Object meal -CEQ $MealType | Select-Object -First 1
    $result = [ordered]@{ meal = $MealType; choice = $entry.choice; deadline = $entry.deadline; status = 'skipped'; reason = '' }
    if ($entry.choice -ceq 'ORDERED') { $result.status = 'already_ordered'; $result.reason = '已订餐' }
    elseif ($targetDate -lt $Calendar.today) { $result.reason = '历史日期' }
    elseif (!$entry) { $result.reason = '日历没有该餐次' }
    elseif ($entry.choice -ceq 'DECLINED') { $result.reason = '已选择不订餐' }
    elseif ($Calendar.presence -cne 'IN_OFFICE' -or $day.presence -cne 'IN_OFFICE' -or
        ($null -ne $entry.presence -and $entry.presence -cne 'IN_OFFICE')) { $result.reason = '不在公司或无需登记' }
    elseif ($entry.choice -cne 'UNSELECTED' -or $entry.locked -isnot [bool]) { $result.reason = '餐次状态无法确认' }
    elseif ($entry.locked -or (Get-MealTime $Calendar.serverTime) -ge (Get-MealTime $entry.deadline)) { $result.reason = '已截止或锁定' }
    else { $result.status = 'eligible'; $result.reason = '可订餐' }
    $result
}

if ($Action -eq 'order' -and !$PSBoundParameters.ContainsKey('Meal')) { throw '订餐时请明确指定餐次' }
if ($Date -notin 'today', 'tomorrow' -and !(Test-MealDate $Date)) { throw '日期必须为 today、tomorrow 或有效的 YYYY-MM-DD' }
if ($Apply -and ($Action -ne 'order' -or !$Port -or !$ExpectedUsername -or !(Test-MealDate $Date))) {
    throw '提交订餐需提供 order、预览确认的绝对日期、账号和端口'
}

if (!$Port) { $Port = Find-MealPort }
$identity = Invoke-MealApi $Port 'health'
if ($identity.batchAccountGuard -ne $true -or !$identity.username -or !$identity.baseUrl) { throw '请先在饭否午晚连接账号并启用支持账号校验的版本' }
if ($Apply -and $ExpectedUsername -cne $identity.username) { throw '饭点账号已变化，请重新预览' }

$calendar = if ($Date -in 'today', 'tomorrow') { Get-MealCalendar } else { Get-MealCalendar $Date.Substring(0, 7) }
$targetDate = switch ($Date) {
    'today' { $calendar.today }
    'tomorrow' { [DateOnly]::ParseExact($calendar.today, 'yyyy-MM-dd').AddDays(1).ToString('yyyy-MM-dd') }
    default { $Date }
}
$month = $targetDate.Substring(0, 7)
if ($calendar.month -cne $month) { $calendar = Get-MealCalendar $month }
$mealTypes = if ($Meal -eq 'BOTH') { 'LUNCH', 'DINNER' } else { $Meal.ToUpperInvariant() }
$results = @(foreach ($mealType in $mealTypes) { Get-MealState $calendar $mealType })
$failure = ''
if ($Apply) {
    foreach ($result in $results) {
        if ($result.status -ne 'eligible') { continue }
        if ($failure) { $result.status = 'not_attempted'; $result.reason = '前一餐异常，已停止'; continue }

        try {
            $fresh = Get-MealState (Get-MealCalendar $month) $result.meal
        } catch {
            $failure = $_.Exception.Message
            $result.status = 'not_attempted'; $result.reason = $failure
            continue
        }
        if ($fresh.status -ne 'eligible') {
            $result.choice = $fresh.choice; $result.status = $fresh.status; $result.reason = $fresh.reason
            continue
        }
        try {
            $receipt = Invoke-MealApi $Port 'selection' @{
                date = $targetDate; meal = $result.meal; choice = 'ORDERED'; expectedUsername = $ExpectedUsername
            }
            $confirmed = $receipt.day.meals | Where-Object { $_.meal -ceq $result.meal -and $_.choice -ceq 'ORDERED' }
            if ($receipt.day.date -cne $targetDate -or !$confirmed) { throw '提交回执未确认订餐' }
            $result.choice = 'ORDERED'; $result.status = 'ordered'; $result.reason = '提交成功'
        } catch {
            $failure = $_.Exception.Message
            $result.status = 'unconfirmed'; $result.reason = $failure
            try {
                $verified = Get-MealState (Get-MealCalendar $month) $result.meal
                if ($verified.choice -ceq 'ORDERED') {
                    $result.choice = 'ORDERED'; $result.status = 'confirmed_after_error'; $result.reason = '已通过日历核实订餐'
                }
            } catch { $result.reason = "$failure，日历核对失败" }
        }
    }
}

[ordered]@{
    action = $Action; apply = [bool]$Apply; port = $Port; username = $identity.username
    today = $calendar.today; date = $targetDate; meals = $results; error = $failure
} | ConvertTo-Json -Depth 4
if ($failure) { exit 1 }
