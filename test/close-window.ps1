# Close exactly one card by window handle, the way a hard kill would: the popup
# process ends without running its release path, which is the case the stack
# collapse has to survive (a stale slot file with no live process behind it).
param([Parameter(Mandatory = $true)][string]$Hwnd)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OneWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
}
'@

$pidValue = 0
[void][OneWindow]::GetWindowThreadProcessId([IntPtr][long]$Hwnd, [ref]$pidValue)
if ($pidValue -le 0) { Write-Output "window $Hwnd has no process"; exit 1 }
try {
  Stop-Process -Id $pidValue -Force -ErrorAction Stop
  Write-Output "closed hwnd=$Hwnd pid=$pidValue"
} catch {
  Write-Output "hwnd=$Hwnd pid=$pidValue already gone"
}
