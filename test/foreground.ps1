# Print the current foreground window, so a probe can tell whether a click had to
# activate the target first (the first click on an inactive window is the one
# Windows may consume to raise it).
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class ForegroundWindow {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);

  public static string Describe() {
    IntPtr handle = GetForegroundWindow();
    var text = new StringBuilder(256);
    GetWindowText(handle, text, 256);
    uint pid;
    GetWindowThreadProcessId(handle, out pid);
    string name = "";
    try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
    return String.Format("hwnd={0} pid={1} process={2} title={3}", handle, pid, name, text.ToString());
  }
}
'@

Write-Output ([ForegroundWindow]::Describe())
