# List visible dsh-notify popup windows with their PHYSICAL rectangles and their
# extended window style.
#
# DPI awareness matters here: without it GetWindowRect reports the virtualised
# (scaled) rectangle while SetCursorPos works in physical pixels, so a click
# computed from one and applied to the other misses the card.
#
# The style matters for a different reason: WS_EX_TOOLWINDOW is what keeps a
# window out of the window switcher (Alt+Tab) and out of the taskbar, so a probe
# can assert the card is not listed there instead of trusting the popup's own
# claim.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class PopupWindows {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr handle, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);

  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }

  delegate bool EnumProc(IntPtr handle, IntPtr param);

  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_APPWINDOW = 0x00040000;

  public static List<IntPtr> Handles(string title) {
    var found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr handle, IntPtr param) {
      if (!IsWindowVisible(handle)) return true;
      var text = new StringBuilder(256);
      GetWindowText(handle, text, 256);
      if (text.ToString().IndexOf(title, StringComparison.Ordinal) >= 0) found.Add(handle);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static int ExStyle(IntPtr handle) {
    return GetWindowLong(handle, GWL_EXSTYLE);
  }

  public static string Describe(IntPtr handle) {
    Rect rect;
    GetWindowRect(handle, out rect);
    int style = ExStyle(handle);
    uint pid;
    GetWindowThreadProcessId(handle, out pid);
    return String.Format("hwnd={0} pid={1} rect=({2},{3})-({4},{5}) size={6}x{7} exstyle=0x{8:X8} toolwindow={9} appwindow={10}",
      handle, pid, rect.Left, rect.Top, rect.Right, rect.Bottom,
      rect.Right - rect.Left, rect.Bottom - rect.Top,
      style,
      (style & WS_EX_TOOLWINDOW) != 0,
      (style & WS_EX_APPWINDOW) != 0);
  }
}
'@

# Take over the process's DPI awareness before any rectangle is read.
[void][PopupWindows]::SetProcessDPIAware()

foreach ($handle in [PopupWindows]::Handles('dsh-notify')) {
  Write-Output ([PopupWindows]::Describe($handle))
}
