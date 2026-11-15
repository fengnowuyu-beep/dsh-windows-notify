# dsh-windows-notify - popup host
#
# Renders one Windows desktop notification as a non-activating popup in the
# bottom-right corner of the working area, plays one WAV cue for it, and exits.
# The Node half spawns one of these per notification through a silent VBS
# launcher, so no console window ever flashes.
#
# Two behaviours matter beyond drawing the card:
#
#  * `"duration": "always"` (the shipped default) means the card has NO
#    auto-dismiss timer: it stays until the user clicks it. A positive
#    `duration` is an auto-dismiss delay in seconds.
#  * Because cards can pile up, each one claims a slot in `slotDir` and stacks
#    above the previous one instead of covering it. A slot file holds
#    `ownerId|pid`; a stale one (dead process) is taken over, and opening a new
#    card in a slot the same owner still holds closes that older card, so one
#    DSH session never accumulates a column of stale notifications. `ownerId`
#    comes from the Host process, not from `$PID`, because every card is its own
#    process and only the Host knows which session it belongs to.
#
# Why not a WinRT toast: on this deployment Windows 10 accepts
# `ToastNotificationManager.Show()` (the notification platform even logs the
# delivery) but only renders toasts whose AppUserModelID it recognises, and an
# unpackaged plugin's own AUMID never reaches `Notifications\Settings`, so the
# toast is stored and never shown. A popup drawn by us is the reliable channel.
#
# Input is a UTF-8 JSON file so Chinese text never crosses a console encoding
# boundary, which PowerShell 5.1 mangles when arguments arrive as a stream. The
# path arrives through the command line from the silent VBS launcher.
param([string]$Payload = '')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($Payload -eq '') { $Payload = [string]$env:DSH_NOTIFY_PAYLOAD }
if ($Payload -eq '') { throw 'no payload path was supplied (-Payload or DSH_NOTIFY_PAYLOAD)' }

$raw = Get-Content -LiteralPath $Payload -Raw -Encoding UTF8
if ([string]::IsNullOrWhiteSpace($raw)) { throw "payload is empty: $Payload" }
$cfg = $raw | ConvertFrom-Json

function Get-Text($value, $fallback) {
  if ($null -eq $value) { return $fallback }
  $text = [string]$value
  if ($text.Trim() -eq '') { return $fallback }
  return $text
}

$title = Get-Text $cfg.title 'DSH'
$body = Get-Text $cfg.body ''
$accent = Get-Text $cfg.accent '#4C8DFF'
$glyph = Get-Text $cfg.glyph 'DSH'
$sound = Get-Text $cfg.sound ''
$slotDir = Get-Text $cfg.slotDir ''
$ownerId = Get-Text $cfg.ownerId ''
# `logFile` is what the current Host sends; `log` is the older name the script
# used to read, kept so a payload written by an older Host still reports.
$logPath = Get-Text $cfg.logFile (Get-Text $cfg.log '')

# Click-to-open: the Host names the conversation this card belongs to and the
# state directory the request file goes in. Without a session there is nothing
# to open, so the card stays a plain dismissable notice.
$sessionId = Get-Text $cfg.sessionId ''
$stateDir = Get-Text $cfg.stateDir ''
$focusApp = Get-Text $cfg.focusApp 'DeepSeek Harness'
$canOpen = ($sessionId -ne '' -and $stateDir -ne '')

# `always` (or 0, or a missing value) means "stay until dismissed".
$autoDismissSeconds = 0
if ($null -ne $cfg.duration) {
  $asNumber = 0
  if ([int]::TryParse([string]$cfg.duration, [ref]$asNumber) -and $asNumber -gt 0) {
    $autoDismissSeconds = [Math]::Min([Math]::Max($asNumber, 1), 600)
  }
}

$width = 384
if ($null -ne $cfg.width) { $width = [int]$cfg.width }
if ($width -lt 280) { $width = 280 }
if ($width -gt 640) { $width = 640 }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml

$bodyRow = if ($body -eq '') { '' } else {
  '<TextBlock x:Name="BodyText" Margin="0,7,0,0" TextWrapping="Wrap" FontSize="13" LineHeight="20" Foreground="#D3D7DE"/>'
}

# A card that can reopen its conversation offers ONE explicit line for it. The
# card surface itself is inert on purpose: a click that was meant to select some
# text, or that was not meant for the card at all, must not navigate anywhere.
#
# The sentence itself arrives in the payload: THIS FILE MUST STAY ASCII-ONLY.
# Windows PowerShell 5.1 decodes a BOM-less UTF-8 script as the system ANSI code
# page, so a literal such as a Chinese sentence would be read as mojibake whose
# glyphs the font renders as blank - the row would take space and show nothing.
$openHint = Get-Text $cfg.openHint ''
$hintRow = if ($canOpen -and $openHint -ne '') {
  $escaped = [System.Security.SecurityElement]::Escape($openHint)
  # A transparent Border is the hit target: a Border with a background is
  # hit-testable across its whole padded box, which a bare TextBlock is not.
  # Cursor and hover colours are attached in code, because only then do they
  # apply to the row when it exists at all.
  "<Border x:Name=`"HintHit`" Margin=`"12,6,0,0`" Padding=`"0,4,8,4`" Background=`"#00000000`" HorizontalAlignment=`"Left`" Cursor=`"Hand`">" +
  "<TextBlock x:Name=`"HintText`" FontSize=`"11.5`" Foreground=`"#8A9199`" Text=`"$escaped`"/></Border>"
} else { '' }

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="$width" SizeToContent="Height" WindowStyle="None" ResizeMode="NoResize"
        AllowsTransparency="True" Background="Transparent" ShowInTaskbar="False" Topmost="True"
        ShowActivated="False" Title="dsh-notify">
  <Border Background="#16181D" BorderBrush="#4A5058" BorderThickness="1" CornerRadius="10" Margin="14"
          Padding="0">
    <Border.Effect>
      <DropShadowEffect BlurRadius="22" ShadowDepth="3" Opacity="0.65" Color="#000000"/>
    </Border.Effect>
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>
      <Border Grid.Row="0" Height="3" Background="$accent" CornerRadius="9,9,0,0"/>
      <Grid Grid.Row="1" Margin="16,13,14,16">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <Border Grid.Column="0" MinWidth="46" Height="30" CornerRadius="15" Background="$accent" VerticalAlignment="Top" Padding="10,0">
          <TextBlock Text="$glyph" FontSize="13" FontWeight="Bold" Foreground="#0E1116"
                     HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <StackPanel Grid.Column="1" Margin="12,0,10,0">
          <TextBlock x:Name="TitleText" FontSize="14" FontWeight="SemiBold" TextWrapping="Wrap" Foreground="#F5F7FA"/>
          $bodyRow
          $hintRow
        </StackPanel>
        <Border Grid.Column="2" x:Name="CloseHit" Background="#00000000" Padding="6,2,2,6"
                VerticalAlignment="Top" Cursor="Hand">
          <TextBlock x:Name="CloseText" Text="&#x2715;" FontSize="13" Foreground="#9AA1AA"/>
        </Border>
      </Grid>
    </Grid>
  </Border>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
if ($env:DSH_NOTIFY_DUMP_XAML) { Set-Content -LiteralPath $env:DSH_NOTIFY_DUMP_XAML -Value $xaml -Encoding UTF8 }
$window = [Windows.Markup.XamlReader]::Load($reader)
$titleBlock = $window.FindName('TitleText')
$bodyBlock = $window.FindName('BodyText')
$closeBlock = $window.FindName('CloseText')
$closeHit = $window.FindName('CloseHit')
$hintBlock = $window.FindName('HintText')
$hintHit = $window.FindName('HintHit')
if ($null -eq $titleBlock -or $null -eq $closeBlock -or $null -eq $closeHit) {
  throw 'notification XAML is missing its named elements'
}

# Hover feedback: only the two live targets react, so the cursor and the colour
# together say which parts of the card actually do something.
function Get-Brush($hex) {
  try { return [System.Windows.Media.BrushConverter]::new().ConvertFromString($hex) } catch { return $null }
}
$hintIdleBrush = if ($null -ne $hintBlock) { $hintBlock.Foreground } else { $null }
$hintHoverBrush = Get-Brush '#E6E9EE'
$closeIdleBrush = $closeBlock.Foreground
$closeHoverBrush = Get-Brush '#FFFFFF'

$titleBlock.Text = $title
if ($body -ne '' -and $null -ne $bodyBlock) { $bodyBlock.Text = $body }

# ---------------------------------------------------------------------------
# Slot bookkeeping: several never-dismissing cards share the corner by stacking.
# ---------------------------------------------------------------------------
$myPid = $PID
$mySlot = -1
$heartbeat = $null

function Get-ProcId($file) {
  try {
    $parts = (Get-Content -LiteralPath $file -Raw -ErrorAction Stop).Trim() -split '\|'
    if ($parts.Count -lt 2) { return -1 }
    return [int]$parts[1]
  } catch { return -1 }
}

function Get-OwnerOf($file) {
  try {
    $parts = (Get-Content -LiteralPath $file -Raw -ErrorAction Stop).Trim() -split '\|'
    if ($parts.Count -lt 2) { return '' }
    return $parts[0]
  } catch { return '' }
}

function Test-ProcAlive($procId) {
  if ($procId -le 0) { return $false }
  try { return $null -ne (Get-Process -Id $procId -ErrorAction Stop) } catch { return $false }
}

function Close-SlotProcess($procId) {
  if ($procId -le 0 -or $procId -eq $myPid) { return }
  # A borderless WPF card has no system menu, so WM_CLOSE (CloseMainWindow) never
  # reaches its handler. The card IS the process, so ending it is the close.
  try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {}
}

function Get-SlotPath([int]$index) { Join-Path $slotDir "slot-$index.txt" }

function Claim-Slot {
  param([int]$Capacity = 12)
  if ($slotDir -eq '') { return -1 }
  try { [void](New-Item -ItemType Directory -Force -Path $slotDir -ErrorAction Stop) } catch { return -1 }

  $busy = New-Object 'System.Collections.Generic.HashSet[int]'
  for ($i = 0; $i -lt $Capacity; $i++) {
    $path = Get-SlotPath $i
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $filePid = Get-ProcId $path
    $fileOwner = Get-OwnerOf $path
    if (-not (Test-ProcAlive $filePid)) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      continue
    }
    if ($ownerId -ne '' -and $fileOwner -ne '' -and $fileOwner -eq $ownerId) {
      # Same DSH session already has a card here: replace it, so one session
      # never accumulates a column of stale notifications.
      Close-SlotProcess $filePid
      Start-Sleep -Milliseconds 250
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      continue
    }
    [void]$busy.Add($i)
  }

  for ($i = 0; $i -lt $Capacity; $i++) {
    if ($busy.Contains($i)) { continue }
    try {
      Set-Content -LiteralPath (Get-SlotPath $i) -Value "$ownerId|$myPid" -Encoding ASCII -ErrorAction Stop
      return $i
    } catch {
      # Lost a race for this slot; try the next one.
    }
  }
  Remove-Item -LiteralPath (Get-SlotPath ($Capacity - 1)) -Force -ErrorAction SilentlyContinue
  try {
    Set-Content -LiteralPath (Get-SlotPath ($Capacity - 1)) -Value "$ownerId|$myPid" -Encoding ASCII -ErrorAction Stop
    return ($Capacity - 1)
  } catch { return -1 }
}

function Release-Slot {
  if ($mySlot -lt 0 -or $slotDir -eq '') { return }
  $path = Get-SlotPath $mySlot
  if ((Get-ProcId $path) -eq $myPid) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
}

<#
    How many cards currently sit BELOW this one.

    A slot index says where a card was allowed to live, not where it has to be
    drawn: when a card lower down closes, everything above it has to come down,
    or the corner keeps a hole where a notification used to be. The count is
    taken from the slot files that are still owned by a live popup, so a card
    that was killed outright is counted out as well.
    @returns the number of occupied slots with a lower index.
#>
function Get-LiveStackIndex {
  if ($mySlot -le 0 -or $slotDir -eq '') { return 0 }
  $below = 0
  for ($i = 0; $i -lt $mySlot; $i++) {
    $path = Get-SlotPath $i
    if (-not (Test-Path -LiteralPath $path)) { continue }
    if (Test-ProcAlive (Get-ProcId $path)) { $below++ }
  }
  return $below
}

if ($slotDir -ne '' -and $ownerId -ne '') {
  $mySlot = Claim-Slot
  if ($mySlot -ge 0) {
    $heartbeat = New-Object System.Windows.Threading.DispatcherTimer
    $heartbeat.Interval = [TimeSpan]::FromSeconds(15)
    $heartbeat.Add_Tick({
      try { Set-Content -LiteralPath (Get-SlotPath $mySlot) -Value "$ownerId|$myPid" -Encoding ASCII } catch {}
    })
    $heartbeat.Start()
  }
}

# ---------------------------------------------------------------------------
# Window behaviour
# ---------------------------------------------------------------------------
$script:done = $false
$close = {
  if ($script:done) { return }
  $script:done = $true
  try { if ($null -ne $heartbeat) { $heartbeat.Stop() } } catch {}
  Release-Slot
  if ($null -ne $script:player) { try { $script:player.Stop(); $script:player.Close() } catch {} }
  try { $window.Close() } catch {}
}

# A borderless WPF window that is not in the taskbar can still be listed by the
# window switcher (Alt+Tab) as long as it carries the plain application style.
# WS_EX_TOOLWINDOW is what removes it from that list, and it has to be set while
# the handle exists but before the window is first shown, or the shell keeps the
# entry it already created.
if (-not ('DshNotifyStyle' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
public class TaskbarListClass { }

[ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITaskbarList {
  void HrInit();
  void AddTab(IntPtr hwnd);
  void DeleteTab(IntPtr hwnd);
  void ActivateTab(IntPtr hwnd);
  void SetActiveAlt(IntPtr hwnd);
}

public static class DshNotifyStyle {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern int SetWindowLong(IntPtr hWnd, int index, int value);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

  /// Tell the shell to drop this window's taskbar/switcher tab. The style above
  /// is what *makes* the window ineligible; this is what removes the entry the
  /// shell may already have registered for it (a window shown once is listed
  /// until the shell is told otherwise).
  public static bool RemoveFromSwitcher(IntPtr hWnd) {
    try {
      var list = (ITaskbarList)new TaskbarListClass();
      list.HrInit();
      list.DeleteTab(hWnd);
      return true;
    } catch {
      return false;
    }
  }
}
'@
}

$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x00000080
$WS_EX_APPWINDOW = 0x00040000
$SWP_FRAMECHANGED = 0x0020
$SWP_NOMOVE = 0x0002
$SWP_NOSIZE = 0x0001
$SWP_NOZORDER = 0x0004

<#
    Give the card the tool-window style: out of Alt+Tab, out of the taskbar.
    @returns whether the style is in force afterwards.
#>
function Set-ToolWindowStyle {
  param([IntPtr]$Handle)
  if ($Handle -eq [IntPtr]::Zero) { return $false }
  try {
    $style = [DshNotifyStyle]::GetWindowLong($Handle, $GWL_EXSTYLE)
    $wanted = ($style -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW)
    if ($wanted -ne $style) {
      [void][DshNotifyStyle]::SetWindowLong($Handle, $GWL_EXSTYLE, $wanted)
      # A style change only takes effect for the shell once the frame is
      # re-evaluated, which is what SWP_FRAMECHANGED asks for.
      [void][DshNotifyStyle]::SetWindowPos($Handle, [IntPtr]::Zero, 0, 0, 0, 0,
        ($SWP_FRAMECHANGED -bor $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOZORDER))
    }
    $applied = [DshNotifyStyle]::GetWindowLong($Handle, $GWL_EXSTYLE)
    return (($applied -band $WS_EX_TOOLWINDOW) -ne 0) -and (($applied -band $WS_EX_APPWINDOW) -eq 0)
  } catch {
    return $false
  }
}

<#
    Drop the window's shell tab. Called again once the card is on screen, because
    the shell registers a tab when a window is first shown: without this the
    style alone leaves the entry behind.
    @returns whether the shell accepted the request.
#>
function Remove-FromSwitcher {
  param([IntPtr]$Handle)
  if ($Handle -eq [IntPtr]::Zero) { return $false }
  try {
    return [DshNotifyStyle]::RemoveFromSwitcher($Handle)
  } catch {
    return $false
  }
}

# The desktop is 3840x2160 at 150% scaling on the reference machine while WPF
# lays out in device-independent units, so the visible bottom-right corner is
# only reachable through physical pixels.
if (-not ('DshNotifyPlacement' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshNotifyPlacement {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
}

# Clicking a card brings the DSH window forward and asks the open GUI page to
# show that conversation. Foreground rights are the reason the popup does this
# rather than the Host: a click on our own window is what Windows accepts as
# permission to activate somebody else's.
if (-not ('DshNotifyActivate' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DshNotifyActivate {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }

  delegate bool EnumProc(IntPtr handle, IntPtr param);

  /// Activate the largest visible window of the named application, or the one
  /// whose title carries the hint. Returns the activated window, or IntPtr.Zero.
  public static IntPtr Activate(string appName, string titleHint) {
    IntPtr best = IntPtr.Zero;
    long bestScore = -1;
    EnumWindows(delegate(IntPtr handle, IntPtr param) {
      if (!IsWindowVisible(handle)) return true;
      var text = new StringBuilder(512);
      GetWindowText(handle, text, 512);
      string title = text.ToString();
      if (title.Length == 0) return true;

      Rect rect;
      GetWindowRect(handle, out rect);
      long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
      if (area <= 0) return true;

      uint pid;
      GetWindowThreadProcessId(handle, out pid);
      string processName = "";
      try { processName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }

      long score = area;
      bool named = appName.Length > 0 && string.Equals(processName, appName, StringComparison.OrdinalIgnoreCase);
      bool hinted = titleHint.Length > 0 && title.IndexOf(titleHint, StringComparison.OrdinalIgnoreCase) >= 0;
      if (named && hinted) score += 2000000000L;
      else if (named) score += 1000000000L;
      else if (hinted) score += 500000000L;
      else return true;   // unrelated window

      if (score > bestScore) { bestScore = score; best = handle; }
      return true;
    }, IntPtr.Zero);

    if (best == IntPtr.Zero) return IntPtr.Zero;
    if (IsIconic(best)) ShowWindow(best, 9);        // SW_RESTORE
    else ShowWindow(best, 5);                       // SW_SHOW
    BringWindowToTop(best);
    if (!SetForegroundWindow(best)) {
      // Windows refuses SetForegroundWindow unless the caller owns the
      // foreground; sharing the input queue is the accepted way around it.
      uint target = 0;
      GetWindowThreadProcessId(best, out target);
      uint current = GetCurrentThreadId();
      bool attached = AttachThreadInput(current, target, true);
      try { SetForegroundWindow(best); } finally { if (attached) AttachThreadInput(current, target, false); }
    }
    return best;
  }
}
'@
}

function Focus-DshWindow {
  try {
    [void][DshNotifyActivate]::Activate($focusApp, $focusApp)
  } catch {
    # Activation is a convenience: a refused foreground switch must not stop the
    # conversation request itself.
  }
}

function Write-FocusRequest {
  try {
    [void](New-Item -ItemType Directory -Force -Path $stateDir -ErrorAction Stop)
    $document = [ordered]@{
      sessionId = $sessionId
      title = $title
      at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Compress
    $target = Join-Path $stateDir 'focus.json'
    $temporary = "$target.tmp"
    # Write-then-rename so the Host never reads a half-written request.
    Set-Content -LiteralPath $temporary -Value $document -Encoding UTF8 -ErrorAction Stop
    Move-Item -LiteralPath $temporary -Destination $target -Force -ErrorAction Stop
  } catch {
    # A failed request only costs the automatic jump, not the card's dismissal.
  }
}

function Get-PhysicalWorkArea {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  return @{ Left = $area.Left; Top = $area.Top; Right = $area.Right; Bottom = $area.Bottom }
}

$window.Add_SourceInitialized({
  # Out of the window switcher first: the style has to be in place before this
  # window is ever shown, which is exactly the window this handler runs in.
  try {
    $script:toolWindow = Set-ToolWindowStyle ([System.Windows.Interop.WindowInteropHelper]::new($window).Handle)
  } catch {
    $script:toolWindow = $false
  }

  # Start the cue as early as possible; it must not wait for layout.
  if ($sound -ne '' -and (Test-Path -LiteralPath $sound)) {
    $script:player = New-Object System.Windows.Media.MediaPlayer
    $script:player.Open([uri]$sound)
    $script:player.Volume = 1.0
    $script:player.Add_MediaOpened({ try { $script:player.Play() } catch {} })
  }
})

$placed = $false
$sized = $false
$script:stackIndex = 0
$script:cardHandle = [IntPtr]::Zero
$script:cardRect = @{ Left = 0; Top = 0; Right = 0; Bottom = 0 }

<#
    Put the card in the corner at its CURRENT live stack position.
    @returns the placed rectangle, or $null when it could not be placed.
#>
function Move-ToCorner {
  try {
    $area = Get-PhysicalWorkArea
    $source = [System.Windows.PresentationSource]::FromVisual($window)
    $hwnd = $source.Handle
    $script:cardHandle = $hwnd
    $rect = New-Object DshNotifyPlacement+RECT
    if (-not [DshNotifyPlacement]::GetWindowRect($hwnd, [ref]$rect)) { return $null }
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -le 0 -or $h -le 0) { return $null }
    $x = $area.Right - $w - 24
    $y = $area.Bottom - $h - 24 - ($script:stackIndex * ($h + 10))
    if ($y -lt $area.Top) { $y = $area.Top }
    $flags = 0x0010 -bor 0x0004   # SWP_NOACTIVATE | SWP_NOZORDER
    if (-not [DshNotifyPlacement]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $w, $h, $flags)) { return $null }
    $script:cardRect = @{ Left = $x; Top = $y; Right = $x + $w; Bottom = $y + $h }
    return @{ X = $x; Y = $y; Width = $w; Height = $h }
  } catch {
    # Positioning is cosmetic; a failed placement must not lose the card.
    return $null
  }
}

<#
    Record where this card sits and where its two live targets are.

    The element centres are PHYSICAL screen points (PointToScreen answers in
    device pixels), the same space as the card rectangle, so a probe can click
    the exact targets this card reacts to instead of guessing offsets. The line
    is rewritten after every move so the newest line is always the current
    geometry.
#>
function Write-CardLog {
  if ($logPath -eq '') { return }
  $geometry = ' hint=- close=-'
  try {
    $hintPoint = if ($null -ne $hintHit) {
      $hintHit.PointToScreen((New-Object System.Windows.Point (($hintHit.ActualWidth / 2), ($hintHit.ActualHeight / 2))))
    } else { $null }
    $closePoint = $closeHit.PointToScreen((New-Object System.Windows.Point (($closeHit.ActualWidth / 2), ($closeHit.ActualHeight / 2))))
    $geometry = " hint={0},{1} close={2},{3}" -f `
      [int][Math]::Round($hintPoint.X), [int][Math]::Round($hintPoint.Y), `
      [int][Math]::Round($closePoint.X), [int][Math]::Round($closePoint.Y)
  } catch {}
  try {
    Add-Content -LiteralPath $logPath -Value ("placed slot={0} stack={1} pid={2} hwnd={3} rect={4},{5} duration={6} canOpen={7} toolWindow={8} size={9}x{10} title={11}{12}" -f `
      $mySlot, $script:stackIndex, $myPid, $script:cardHandle, $script:cardRect.Left, $script:cardRect.Top, $cfg.duration, $canOpen, $script:toolWindow, `
      [Math]::Round($window.ActualWidth, 1), [Math]::Round($window.ActualHeight, 1), $title, $geometry) -Encoding UTF8
  } catch {}
}
$window.Add_ContentRendered({
  # SizeToContent can settle a few pixels short of the tallest row, which clips
  # the last line (the click hint). Pin the height to what the content actually
  # asked for, once, before placing the card.
  if (-not $sized) {
    $sized = $true
    try {
      $content = $window.Content
      if ($null -ne $content) {
        $needed = $content.DesiredSize.Height
        if ($needed -gt ($window.ActualHeight + 0.5)) { $window.Height = $needed + 0.5 }
      }
    } catch {
      # A card that is a few pixels short is better than no card.
    }
  }

  if ($placed) { return }
  $placed = $true

  # Sit at the bottom of whatever stack exists right now.
  $script:stackIndex = Get-LiveStackIndex
  [void](Move-ToCorner)
  Write-CardLog

  # Two things settle a beat after the first render: the shell has by then
  # registered a taskbar/switcher tab for the window (so it has to be dropped
  # here as well as at creation), and the layout is final (so the recorded
  # element centres are the ones the card really reacts to). Do both in one
  # pass and record the geometry again.
  $script:settleTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:settleTimer.Interval = [TimeSpan]::FromMilliseconds(400)
  $script:settleTimer.Add_Tick({
    $script:settleTimer.Stop()
    [void](Set-ToolWindowStyle $script:cardHandle)
    [void](Remove-FromSwitcher $script:cardHandle)
    [void](Move-ToCorner)
    Write-CardLog
  })
  $script:settleTimer.Start()

  # Keep the corner tidy: cards below this one come and go, and a card that
  # stayed at its original slot would leave a hole in the stack.
  $script:stackTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:stackTimer.Interval = [TimeSpan]::FromMilliseconds(900)
  $script:stackTimer.Add_Tick({
    $live = Get-LiveStackIndex
    if ($live -eq $script:stackIndex) { return }
    $script:stackIndex = $live
    [void](Move-ToCorner)
    Write-CardLog
  })
  $script:stackTimer.Start()
})

$window.Add_Closed({ try { Release-Slot } catch {} })

# Only two things on this card do anything: the hint row opens its conversation,
# and the close glyph dismisses. Clicking anywhere else - the title, the body, the
# gap between them - leaves both alone, because a card that navigates on any click
# is a card you cannot safely read or select text from.
if ($canOpen -and $null -ne $hintHit) {
  $hintHit.Add_MouseLeftButtonUp({
    param($sender, $eventArgs)
    $eventArgs.Handled = $true
    Focus-DshWindow
    Write-FocusRequest
    & $close
  })
  $hintHit.Add_MouseEnter({ try { $hintBlock.Foreground = $hintHoverBrush } catch {} })
  $hintHit.Add_MouseLeave({ try { $hintBlock.Foreground = $hintIdleBrush } catch {} })
}
$closeHit.Add_MouseLeftButtonUp({
  param($sender, $eventArgs)
  $eventArgs.Handled = $true
  & $close
})
$closeHit.Add_MouseEnter({ try { $closeBlock.Foreground = $closeHoverBrush } catch {} })
$closeHit.Add_MouseLeave({ try { $closeBlock.Foreground = $closeIdleBrush } catch {} })

# No timer at all when the configured lifetime is "always".
$autoTimer = $null
if ($autoDismissSeconds -gt 0) {
  $autoTimer = New-Object System.Windows.Threading.DispatcherTimer
  $autoTimer.Interval = [TimeSpan]::FromSeconds($autoDismissSeconds)
  $autoTimer.Add_Tick({ $autoTimer.Stop(); & $close })
  $autoTimer.Start()
}

try {
  [void]$window.ShowDialog()
} finally {
  if ($null -ne $autoTimer) { try { $autoTimer.Stop() } catch {} }
  if ($null -ne $heartbeat) { try { $heartbeat.Stop() } catch {} }
  if ($null -ne $script:settleTimer) { try { $script:settleTimer.Stop() } catch {} }
  if ($null -ne $script:stackTimer) { try { $script:stackTimer.Stop() } catch {} }
  Release-Slot
  if ($null -ne $script:player) { try { $script:player.Close() } catch {} }
}
exit 0
