Dim pathJar
Dim pathJre
Set pathJre = CreateObject("Scripting.FileSystemObject")
Set pathJar = CreateObject("Scripting.FileSystemObject")
pathJar = pathJre.GetParentFolderName(WScript.ScriptFullName)
pathJre = pathJre.GetParentFolderName(pathJre.GetParentFolderName(WScript.ScriptFullName))
pathJre = pathJre + "\jre"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run chr(34) & pathJre & "\bin\javaw.exe" &  chr(34) &  " -jar " &  chr(34) & pathJar & "\vpostest-1.0.0.jar" & chr(34) 