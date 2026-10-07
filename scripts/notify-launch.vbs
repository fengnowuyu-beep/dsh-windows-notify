' dsh-windows-notify - silent popup launcher
'
' wscript.exe has no console window of its own, and the hidden window style
' keeps the popup host's console hidden too, so a notification never flashes a
' black box. Command-line arguments arrive in order:
'   0 - path of the UTF-8 JSON payload
'   1 - path of notify.ps1
Option Explicit

Dim payload, script, shell, command, quote
quote = Chr(34)

If WScript.Arguments.Count < 2 Then
  WScript.Quit 2
End If
payload = WScript.Arguments(0)
script = WScript.Arguments(1)

command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " _
  & quote & script & quote & " -Payload " & quote & payload & quote

Set shell = CreateObject("WScript.Shell")
' 0 = hidden window, False = do not wait for the popup to close
shell.Run command, 0, False
