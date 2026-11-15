# Report whether a dsh-notify card is really out of the Alt+Tab / taskbar list.
#
# The switcher is built from visible top-level windows that carry neither
# WS_EX_TOOLWINDOW nor an owner, so this prints both facts: the card's extended
# style and every window the switcher would offer.
param([string]$TitleContains = 'dsh-notify')

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class SwitcherProbe {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr handle, int index);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr handle, uint command);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);

  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }

  delegate bool EnumProc(IntPtr handle, IntPtr param);

  public const int GWL_EXSTYLE = -20;
  public const uint GW_OWNER = 4;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_APPWINDOW = 0x00040000;
  public const int WS_EX_NOACTIVATE = 0x08000000;

  public static IntPtr Find(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr handle, IntPtr param) {
      if (!IsWindowVisible(handle)) return true;
      var text = new StringBuilder(256);
      GetWindowText(handle, text, 256);
      if (text.ToString().IndexOf(needle, StringComparison.Ordinal) >= 0) { found = handle; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /// Windows the Alt+Tab list is built from: visible, titled, and NOT a tool
  /// window. Ownership is reported but not used as a criterion: WPF gives every
  /// ShowInTaskbar=false window a hidden owner, and the cards that were showing
  /// up in Alt+Tab all had one.
  public static List<string> Switcher() {
    var rows = new List<string>();
    EnumWindows(delegate(IntPtr handle, IntPtr param) {
      if (!IsWindowVisible(handle)) return true;
      int style = GetWindowLong(handle, GWL_EXSTYLE);
      if ((style & WS_EX_TOOLWINDOW) != 0) return true;
      var text = new StringBuilder(256);
      GetWindowText(handle, text, 256);
      if (text.Length == 0) return true;
      Rect rect;
      GetWindowRect(handle, out rect);
      if (rect.Right - rect.Left <= 0) return true;
      rows.Add(String.Format("{0,-28} hwnd={1} ex=0x{2:X8}", text.ToString(), handle, style));
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@

[void][SwitcherProbe]::SetProcessDPIAware()

$card = [SwitcherProbe]::Find($TitleContains)
if ($card -eq [IntPtr]::Zero) { Write-Output "no card matching '$TitleContains'"; exit 2 }

$style = [SwitcherProbe]::GetWindowLong($card, [SwitcherProbe]::GWL_EXSTYLE)
$owner = [SwitcherProbe]::GetWindow($card, [SwitcherProbe]::GW_OWNER)
Write-Output ("card hwnd={0} exStyle=0x{1:X8}" -f $card, $style)
Write-Output ("  TOOLWINDOW  = {0}" -f ((($style -band [SwitcherProbe]::WS_EX_TOOLWINDOW) -ne 0)))
Write-Output ("  APPWINDOW   = {0}" -f ((($style -band [SwitcherProbe]::WS_EX_APPWINDOW) -ne 0)))
Write-Output ("  NOACTIVATE  = {0}" -f ((($style -band [SwitcherProbe]::WS_EX_NOACTIVATE) -ne 0)))
Write-Output ("  owner       = {0}" -f $owner)

$rows = [SwitcherProbe]::Switcher()
$offered = @($rows | Where-Object { $_ -match [regex]::Escape($TitleContains) })
Write-Output ("switcher candidates: {0}; card listed: {1}" -f $rows.Count, ($offered.Count -gt 0))
if ($offered.Count -gt 0) { $offered | ForEach-Object { Write-Output ("  LISTED -> " + $_) } }
