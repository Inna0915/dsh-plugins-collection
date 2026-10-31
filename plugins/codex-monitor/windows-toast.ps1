[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    # Notification text is data from stdin, never executable PowerShell or XML.
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.UI.Notifications.ToastNotifier, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.UI.Notifications.NotificationSetting, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
    $xml.LoadXml('<toast duration="short"><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')
    $textNodes = $xml.GetElementsByTagName('text')
    $textNodes.Item(0).InnerText = [string]$payload.title
    $textNodes.Item(1).InnerText = [string]$payload.body
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $toast.Tag = [string]$payload.tag
    $toast.Group = 'codex-monitor'
    $toast.ExpirationTime = [DateTimeOffset]::Now.AddDays(1)
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('com.deepseek.dsh')
    $setting = $null
    try {
        $setting = $notifier.get_Setting()
    }
    catch {
        # Windows may not create an app's notification settings until its first toast.
        if ($_.Exception.InnerException.HResult -ne -2147023728) {
            throw
        }
    }
    if ($null -ne $setting -and $setting.ToString() -ne 'Enabled') {
        throw ('Windows notification setting: ' + $setting.ToString())
    }
    $notifier.Show($toast)
    [Console]::Out.Write('{"accepted":true}')
    exit 0
}
catch {
    [Console]::Error.Write(('Windows toast line {0}: {1}' -f $_.InvocationInfo.ScriptLineNumber, $_.Exception.Message))
    exit 1
}
