# Click one element of a card, addressed as an offset inside that window.
#
# Two races have to be defeated to click reliably while somebody is using the
# machine:
#
#   * the person moves the pointer between placing it and pressing the button;
#   * the card MOVES between reading its geometry and clicking it, because the
#     corner re-stacks whenever a card below it disappears. A cached absolute
#     point then lands on another part of the same card (the body, which is
#     deliberately inert), which is indistinguishable from "the card ignored the
#     click".
#
# So the target is an offset from the window's top-left, and the absolute point
# is recomputed from the window's CURRENT rectangle immediately before every
# press. The press only happens once the pointer is confirmed to be on the point
# and the window under it is confirmed to be that card.
param(
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [Parameter(Mandatory = $true)][int]$OffsetX,
  [Parameter(Mandatory = $true)][int]$OffsetY,
  [int]$Attempts = 6
)

Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(POINT point);
[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr handle, uint flags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr handle, out RECT rect);
[DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr handle);
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@ -Name ClickNative -Namespace DshNotifyProbe

# Physical pixels, matching the rectangles list-windows.ps1 reports.
[void][DshNotifyProbe.ClickNative]::SetProcessDPIAware()

$target = [IntPtr][long]$Hwnd
$original = New-Object DshNotifyProbe.ClickNative+POINT
[void][DshNotifyProbe.ClickNative]::GetCursorPos([ref]$original)

$verified = $false
$reason = 'no attempt was made'
$attempt = 0
while ($attempt -lt $Attempts) {
  $attempt++

  if (-not [DshNotifyProbe.ClickNative]::IsWindow($target)) {
    $reason = 'the card is gone'
    break
  }
  $rect = New-Object DshNotifyProbe.ClickNative+RECT
  if (-not [DshNotifyProbe.ClickNative]::GetWindowRect($target, [ref]$rect)) {
    $reason = 'the card rectangle is unavailable'
    continue
  }
  $x = $rect.Left + $OffsetX
  $y = $rect.Top + $OffsetY

  [void][DshNotifyProbe.ClickNative]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 70

  $now = New-Object DshNotifyProbe.ClickNative+POINT
  [void][DshNotifyProbe.ClickNative]::GetCursorPos([ref]$now)
  if ([Math]::Abs($now.X - $x) -gt 1 -or [Math]::Abs($now.Y - $y) -gt 1) {
    $reason = "pointer was moved to $($now.X),$($now.Y) before the press"
    continue
  }

  $under = [DshNotifyProbe.ClickNative]::GetAncestor([DshNotifyProbe.ClickNative]::WindowFromPoint($now), 2)
  if ($under -ne $target) {
    $reason = "the window under the point was $under, expected $target"
    Start-Sleep -Milliseconds 120
    continue
  }

  # MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004
  [DshNotifyProbe.ClickNative]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [DshNotifyProbe.ClickNative]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
  $verified = $true
  $reason = "landed on offset $OffsetX,$OffsetY of the card"
  break
}

Start-Sleep -Milliseconds 120
[void][DshNotifyProbe.ClickNative]::SetCursorPos($original.X, $original.Y)
Write-Output ("clicked hwnd={0} offset={1},{2} verified={3} attempt={4} ({5})" -f $Hwnd, $OffsetX, $OffsetY, $verified, $attempt, $reason)
if (-not $verified) { exit 3 }
