# Close every visible dsh-notify popup.
#
# A popup is a whole process, and a borderless WPF card has no system menu, so
# WM_CLOSE cannot reach its handler: ending the process is what clicking the
# card's own close glyph achieves anyway.
#
#   -Wait  poll until no card is left (a card whose launcher had only just
#          started appears a moment after the first sweep). Probes use it so
#          they start from a known-empty corner instead of counting somebody
#          else's leftover cards.
param(
  [switch]$Wait,
  [int]$TimeoutMs = 4000
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class PopupCloser {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);

  delegate bool EnumProc(IntPtr handle, IntPtr param);

  public static List<uint> Pids(string title) {
    var found = new List<uint>();
    EnumWindows(delegate(IntPtr handle, IntPtr param) {
      if (!IsWindowVisible(handle)) return true;
      var text = new StringBuilder(256);
      GetWindowText(handle, text, 256);
      if (text.ToString().IndexOf(title, StringComparison.Ordinal) >= 0) {
        uint pid;
        GetWindowThreadProcessId(handle, out pid);
        if (pid != 0) found.Add(pid);
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$closed = 0
do {
  $pids = [PopupCloser]::Pids('dsh-notify')
  foreach ($pidValue in $pids) {
    try {
      Stop-Process -Id $pidValue -Force -ErrorAction Stop
      $closed++
      Write-Output "closed pid $pidValue"
    } catch {
      Write-Output "pid $pidValue already gone"
    }
  }
  if (-not $Wait) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline -and [PopupCloser]::Pids('dsh-notify').Count -gt 0)

if ($Wait) {
  $left = [PopupCloser]::Pids('dsh-notify').Count
  Write-Output ("closed: {0}; still visible: {1}" -f $closed, $left)
}
