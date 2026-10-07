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

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="$width" SizeToContent="Height" WindowStyle="None" ResizeMode="NoResize"
        AllowsTransparency="True" Background="Transparent" ShowInTaskbar="False" Topmost="True"
        ShowActivated="False" Title="dsh-notify">
  <Border Background="#16181D" BorderBrush="#4A5058" BorderThickness="1" CornerRadius="10" Margin="14" Padding="0">
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
        </StackPanel>
        <TextBlock Grid.Column="2" x:Name="CloseText" Text="&#x2715;" FontSize="13" Foreground="#9AA1AA"
                   VerticalAlignment="Top" Cursor="Hand" Padding="5,1,1,6" Background="Transparent"/>
      </Grid>
    </Grid>
  </Border>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)
$titleBlock = $window.FindName('TitleText')
$bodyBlock = $window.FindName('BodyText')
$closeBlock = $window.FindName('CloseText')
if ($null -eq $titleBlock -or $null -eq $closeBlock) { throw 'notification XAML is missing its named elements' }
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
$window.Add_MouseLeftButtonUp($close)
$closeBlock.Add_MouseLeftButtonUp($close)

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

function Get-PhysicalWorkArea {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  return @{ Left = $area.Left; Top = $area.Top; Right = $area.Right; Bottom = $area.Bottom }
}

$window.Add_SourceInitialized({
  # Start the cue as early as possible; it must not wait for layout.
  if ($sound -ne '' -and (Test-Path -LiteralPath $sound)) {
    $script:player = New-Object System.Windows.Media.MediaPlayer
    $script:player.Open([uri]$sound)
    $script:player.Volume = 1.0
    $script:player.Add_MediaOpened({ try { $script:player.Play() } catch {} })
  }
})

$placed = $false
$window.Add_ContentRendered({
  if ($placed) { return }
  $placed = $true
  try {
    $area = Get-PhysicalWorkArea
    $source = [System.Windows.PresentationSource]::FromVisual($window)
    $hwnd = $source.Handle
    $rect = New-Object DshNotifyPlacement+RECT
    if ([DshNotifyPlacement]::GetWindowRect($hwnd, [ref]$rect)) {
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      $stack = if ($mySlot -gt 0) { $mySlot } else { 0 }
      $x = $area.Right - $w - 24
      $y = $area.Bottom - $h - 24 - ($stack * ($h + 10))
      if ($y -lt $area.Top) { $y = $area.Top }
      $flags = 0x0010 -bor 0x0004   # SWP_NOACTIVATE | SWP_NOZORDER
      [void][DshNotifyPlacement]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $w, $h, $flags)
    }
  } catch {
    # Positioning is cosmetic; a failed placement must not lose the card.
  }
  if ($null -ne $cfg.log) {
    try {
      Add-Content -LiteralPath $cfg.log -Value ("placed slot={0} duration={1} title={2}" -f $mySlot, $cfg.duration, $title) -Encoding UTF8
    } catch {}
  }
})

$window.Add_Closed({ try { Release-Slot } catch {} })

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
  Release-Slot
  if ($null -ne $script:player) { try { $script:player.Close() } catch {} }
}
exit 0
