# Maintenance for cards that are already on screen.
#
# Two jobs, both about windows this process does not own:
#
#   -Action Adopt : give every existing dsh-notify card the tool-window style and
#                   drop its shell tab. A card raised by an older build of the
#                   popup host never got that style, so it is still offered by
#                   Alt+Tab; adopting it fixes the card the user is looking at
#                   instead of asking them to close it and wait for a new one.
#   -Action Close : end every existing card process (used by tests).
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 script as
# the system ANSI code page, so any non-ASCII literal here would arrive as
# mojibake. Sentences meant for the user live in the payload instead.
param(
  [ValidateSet('Adopt', 'Close')][string]$Action = 'Adopt',
  [string]$TitleContains = 'dsh-notify'
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
public class CardTaskbarListClass { }

[ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICardTaskbarList {
  void HrInit();
  void AddTab(IntPtr hwnd);
  void DeleteTab(IntPtr hwnd);
  void ActivateTab(IntPtr hwnd);
  void SetActiveAlt(IntPtr hwnd);
}

public static class CardWindows {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr handle, int index);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr handle, int index, int value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int cx, int cy, uint flags);

  delegate bool EnumProc(IntPtr handle, IntPtr param);

  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_APPWINDOW = 0x00040000;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOZORDER = 0x0004;

  public static List<IntPtr> Find(string needle) {
    var found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr handle, IntPtr param) {
      if (!IsWindowVisible(handle)) return true;
      var text = new StringBuilder(256);
      GetWindowText(handle, text, 256);
      if (text.ToString().IndexOf(needle, StringComparison.Ordinal) >= 0) found.Add(handle);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool ToolWindowed(IntPtr handle) {
    int style = GetWindowLong(handle, GWL_EXSTYLE);
    return (style & WS_EX_TOOLWINDOW) != 0 && (style & WS_EX_APPWINDOW) == 0;
  }

  public static bool Adopt(IntPtr handle) {
    int style = GetWindowLong(handle, GWL_EXSTYLE);
    int wanted = (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
    if (wanted != style) {
      SetWindowLong(handle, GWL_EXSTYLE, wanted);
      SetWindowPos(handle, IntPtr.Zero, 0, 0, 0, 0,
        SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
    }
    try {
      var list = (ICardTaskbarList)new CardTaskbarListClass();
      list.HrInit();
      list.DeleteTab(handle);
    } catch {
      // The shell is not always willing; the style is still the main mechanism.
    }
    return ToolWindowed(handle);
  }

  public static uint ProcessOf(IntPtr handle) {
    uint pid;
    GetWindowThreadProcessId(handle, out pid);
    return pid;
  }
}
'@

$cards = [CardWindows]::Find($TitleContains)
Write-Output ("cards found: " + $cards.Count)

if ($Action -eq 'Close') {
  foreach ($card in $cards) {
    $cardPid = [CardWindows]::ProcessOf($card)
    try {
      Stop-Process -Id $cardPid -Force -ErrorAction Stop
      Write-Output ("closed hwnd={0} pid={1}" -f $card, $cardPid)
    } catch {
      Write-Output ("hwnd={0} pid={1} already gone" -f $card, $cardPid)
    }
  }
  exit 0
}

$adopted = 0
foreach ($card in $cards) {
  if ([CardWindows]::Adopt($card)) { $adopted++ }
}
Write-Output ("adopted: " + $adopted)
