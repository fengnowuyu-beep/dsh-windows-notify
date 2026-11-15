# Enumerate top-level visible windows with their owning process, so the popup
# knows what to bring to the foreground.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class TopWindows {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }

  delegate bool EnumProc(IntPtr handle, IntPtr param);

  public static List<string> Enumerate() {
    var found = new List<string>();
    EnumWindows(delegate(IntPtr handle, IntPtr param) {
      if (!IsWindowVisible(handle)) return true;
      var text = new StringBuilder(512);
      GetWindowText(handle, text, 512);
      var title = text.ToString();
      if (title.Length == 0) return true;
      Rect rect;
      GetWindowRect(handle, out rect);
      uint pid;
      GetWindowThreadProcessId(handle, out pid);
      string name = "";
      try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
      found.Add(String.Format("{0}|{1}|{2}x{3}|hwnd={4}|pid={5}",
        name, title, rect.Right - rect.Left, rect.Bottom - rect.Top, handle, pid));
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string Foreground() {
    var handle = GetForegroundWindow();
    var text = new StringBuilder(512);
    GetWindowText(handle, text, 512);
    uint pid;
    GetWindowThreadProcessId(handle, out pid);
    string name = "";
    try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
    return name + " | " + text.ToString();
  }
}
'@

Write-Output ("foreground: " + [TopWindows]::Foreground())
Write-Output "--- windows of interest ---"
foreach ($row in [TopWindows]::Enumerate()) {
  if ($row -match '^(DeepSeek|chrome|msedge|firefox)' -or $row -match 'DeepSeek|Harness') {
    Write-Output ("  " + $row)
  }
}
