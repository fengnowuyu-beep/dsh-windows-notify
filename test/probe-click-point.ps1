# Diagnose whether the physical click point really lands on the popup card.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class ClickProbe {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);

  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr handle, IntPtr param);

  public static IntPtr FindCard() {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr handle, IntPtr param) {
      if (!IsWindowVisible(handle)) return true;
      var text = new StringBuilder(256);
      GetWindowText(handle, text, 256);
      if (text.ToString().IndexOf("dsh-notify", StringComparison.Ordinal) >= 0) { found = handle; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string Describe(string label, IntPtr handle) {
    Rect rect;
    GetWindowRect(handle, out rect);
    var text = new StringBuilder(256);
    GetWindowText(handle, text, 256);
    return String.Format("{0}: hwnd={1} title='{2}' rect=({3},{4})-({5},{6})",
      label, handle, text.ToString(), rect.Left, rect.Top, rect.Right, rect.Bottom);
  }
}
'@

Write-Output ("before DPI aware: screen=" + [ClickProbe]::GetSystemMetrics(0) + "x" + [ClickProbe]::GetSystemMetrics(1))
$card = [ClickProbe]::FindCard()
if ($card -eq [IntPtr]::Zero) { Write-Output 'no card window found'; exit 1 }
Write-Output ([ClickProbe]::Describe('unaware ', $card))

[void][ClickProbe]::SetProcessDPIAware()
Write-Output ("after DPI aware:  screen=" + [ClickProbe]::GetSystemMetrics(0) + "x" + [ClickProbe]::GetSystemMetrics(1))
Write-Output ([ClickProbe]::Describe('physical', $card))

$rect = New-Object ClickProbe+Rect
[void][ClickProbe]::GetWindowRect($card, [ref]$rect)
$x = [int](($rect.Left + $rect.Right) / 2)
$y = [int](($rect.Top + $rect.Bottom) / 2)
Write-Output ("targeting physical centre: $x,$y")
[void][ClickProbe]::SetCursorPos($x, $y)

$now = New-Object ClickProbe+Point
[void][ClickProbe]::GetCursorPos([ref]$now)
Write-Output ("cursor now reports: " + $now.X + "," + $now.Y)

$under = [ClickProbe]::WindowFromPoint($now)
$top = [ClickProbe]::GetAncestor($under, 2)
Write-Output ([ClickProbe]::Describe('under cursor', $top))
Write-Output ("same window: " + ($top -eq $card))
