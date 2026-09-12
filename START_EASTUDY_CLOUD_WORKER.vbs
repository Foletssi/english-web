Option Explicit
Dim shell, files, repository, exitCode
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
repository = files.GetParentFolderName(WScript.ScriptFullName)
exitCode = shell.Run("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & repository & "\services\cloud-worker\start-worker.ps1""", 0, True)
WScript.Quit exitCode
