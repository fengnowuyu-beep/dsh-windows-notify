# Ask every visible dsh-notify popup to close, the same way clicking one does.
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

foreach ($pidValue in [PopupCloser]::Pids('dsh-notify')) {
  try {
    # A borderless WPF window has no system menu, so WM_CLOSE cannot reach its
    # handler; ending the popup process is what a click achieves anyway (the
    # card is the whole process).
    Stop-Process -Id $pidValue -Force -ErrorAction Stop
    Write-Output "closed pid $pidValue"
  } catch {
    Write-Output "pid $pidValue already gone"
  }
}
