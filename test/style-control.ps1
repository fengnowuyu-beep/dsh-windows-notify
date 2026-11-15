# Prove the switcher check is sensitive: take a live card, remove its
# WS_EX_TOOLWINDOW style, and show that the same check then lists it.
#
# A check that never reports "listed" would pass even if the card really were in
# Alt+Tab, so this control experiment is what makes the other result meaningful.
#
#   -Hold  leave the style removed instead of restoring it, so another probe can
#          adopt the card and prove the adoption path end to end.
param(
  [string]$TitleContains = 'dsh-notify',
  [switch]$Hold
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class StyleControl {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr handle, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr handle, int index, int value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr handle, uint command);

  delegate bool EnumProc(IntPtr handle, IntPtr param);

  public const int GWL_EXSTYLE = -20;
  public const uint GW_OWNER = 4;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_APPWINDOW = 0x00040000;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOZORDER = 0x0004;

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

  public static bool Listed(IntPtr card) {
    // What the Windows 11 switcher offers: a visible, titled window that does
    // NOT carry WS_EX_TOOLWINDOW. Owned windows are still listed there - WPF
    // gives every ShowInTaskbar=false window a hidden owner, and the cards that
    // did show up in Alt+Tab all had one - so ownership is reported but not used
    // as a criterion.
    if (!IsWindowVisible(card)) return false;
    int style = GetWindowLong(card, GWL_EXSTYLE);
    if ((style & WS_EX_TOOLWINDOW) != 0) return false;
    var text = new StringBuilder(256);
    GetWindowText(card, text, 256);
    return text.Length > 0;
  }

  public static int ClearToolWindow(IntPtr card) {
    int style = GetWindowLong(card, GWL_EXSTYLE);
    int wanted = (style & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW;
    SetWindowLong(card, GWL_EXSTYLE, wanted);
    SetWindowPos(card, IntPtr.Zero, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
    return GetWindowLong(card, GWL_EXSTYLE);
  }

  public static int RestoreToolWindow(IntPtr card) {
    int style = GetWindowLong(card, GWL_EXSTYLE);
    int wanted = (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
    SetWindowLong(card, GWL_EXSTYLE, wanted);
    SetWindowPos(card, IntPtr.Zero, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
    return GetWindowLong(card, GWL_EXSTYLE);
  }
}
'@

[void][StyleControl]::SetProcessDPIAware()

$card = [StyleControl]::Find($TitleContains)
if ($card -eq [IntPtr]::Zero) { Write-Output "no card matching '$TitleContains'"; exit 2 }

Write-Output ("with WS_EX_TOOLWINDOW    : listed={0}  owner={1}" -f ([StyleControl]::Listed($card)), ([StyleControl]::GetWindow($card, [StyleControl]::GW_OWNER)))
$stripped = [StyleControl]::ClearToolWindow($card)
Start-Sleep -Milliseconds 400
Write-Output ("without WS_EX_TOOLWINDOW : listed={0}  exstyle=0x{1:X8}" -f ([StyleControl]::Listed($card)), $stripped)
if ($Hold) {
  Write-Output 'holding the stripped style (so another probe can adopt this card)'
  exit 0
}
$restored = [StyleControl]::RestoreToolWindow($card)
Start-Sleep -Milliseconds 400
Write-Output ("restored                 : listed={0}  exstyle=0x{1:X8}" -f ([StyleControl]::Listed($card)), $restored)
