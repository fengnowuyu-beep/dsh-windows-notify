# List visible dsh-notify popup windows with their physical rectangles.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class PopupWindows {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);

  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }

  delegate bool EnumProc(IntPtr handle, IntPtr param);

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

  public static string Describe(IntPtr handle) {
    Rect rect;
    GetWindowRect(handle, out rect);
    return String.Format("hwnd={0} rect=({1},{2})-({3},{4}) size={5}x{6}",
      handle, rect.Left, rect.Top, rect.Right, rect.Bottom,
      rect.Right - rect.Left, rect.Bottom - rect.Top);
  }
}
'@

foreach ($handle in [PopupWindows]::Handles('dsh-notify')) {
  Write-Output ([PopupWindows]::Describe($handle))
}
