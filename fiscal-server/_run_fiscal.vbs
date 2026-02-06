Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "c:\xampp\htdocs\projects\titaniopos-electron\fiscal-server"
returnCode = WshShell.Run("IntTFHKA.exe SendCmd(I0X)", 0, True)
WScript.Quit returnCode
