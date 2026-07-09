del VposREST.vbs
echo Dim objWSHShell : Set objWSHShell = CreateObject("WScript.Shell") > VposREST.vbs
echo objWSHShell.CurrentDirectory = "%~dp0" >> VposREST.vbs
echo objWSHShell.Run "VposREST",0,True >> VposREST.vbs
copy VposREST.vbs "%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"
chcp 1252
@echo off
setlocal enableextensions disabledelayedexpansion
>>"ruta.txt" echo(%CD%
set "search=\"
set "replace=\\"
set "textFile=ruta.txt"
for /f "delims=" %%i in ('type "%textFile%" ^& break ^> "%textFile%" ') do (
set "line=%%i"
setlocal enabledelayedexpansion
>>"%textFile%" echo(!line:%search%=%replace%!)
endlocal
)
for /f "delims=" %%i in ('type "%textFile%" ^& break ^> "%textFile%" ') do (
set "line=%%i"
)
set "search=rutaAux"
set "replace=%line%"
CD conf
set "textFile=reinicioVpos.properties"
for /f "delims=" %%i in ('type "%textFile%" ^& break ^> "%textFile%" ') do (
set "line=%%i"
setlocal enabledelayedexpansion
>>"%textFile%" echo(!line:%search%=%replace%%!
endlocal
)
CD ..
del ruta.txt
echo .
echo .
echo Fin de la instalacion.
echo Puede cerrar esta ventana si queda abierta.
echo .
VposREST.vbs
