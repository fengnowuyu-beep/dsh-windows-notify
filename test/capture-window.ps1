# Capture one window's own pixels with PrintWindow.
#
# DPI awareness is mandatory here: the window is rendered at PHYSICAL size, so a
# DPI-unaware caller that sizes the bitmap from GetWindowRect's virtualised
# rectangle gets the top-left crop of the card (which silently hides the last
# row). SetProcessDPIAware makes the rectangle and the bitmap agree.
param(
  [Parameter(Mandatory = $true)][string]$TitleContains,
  [Parameter(Mandatory = $true)][string]$Out
)

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class WindowCapture {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr handle, IntPtr hdc, uint flags);

  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }

  delegate bool EnumProc(IntPtr handle, IntPtr param);

  public static IntPtr Find(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr handle, IntPtr param) {
      if (!IsWindowVisible(handle)) return true;
      var text = new StringBuilder(256);
      GetWindowText(handle, text, 256);
      if (text.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) { found = handle; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

[void][WindowCapture]::SetProcessDPIAware()

$handle = [WindowCapture]::Find($TitleContains)
if ($handle -eq [IntPtr]::Zero) { Write-Output "no window matching '$TitleContains'"; exit 2 }

$rect = New-Object WindowCapture+Rect
[void][WindowCapture]::GetWindowRect($handle, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
Write-Output "hwnd=$handle rect=$($rect.Left),$($rect.Top)-$($rect.Right),$($rect.Bottom) size=${width}x${height}"

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
# PW_RENDERFULLCONTENT = 0x2, required for composited windows.
$ok = [WindowCapture]::PrintWindow($handle, $hdc, 2)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output "printwindow=$ok saved -> $Out"
