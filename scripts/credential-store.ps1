param([ValidateSet('protect','unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $inputValue = [Console]::In.ReadToEnd()
  if ($Mode -eq 'protect') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($inputValue)
    $protected = [Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($protected))
  } else {
    $bytes = [Convert]::FromBase64String($inputValue)
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
  }
} catch {
  [Console]::Error.Write('Windows 用户凭证保护操作失败')
  exit 1
}
