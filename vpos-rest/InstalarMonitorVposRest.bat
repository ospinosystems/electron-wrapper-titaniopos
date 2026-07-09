@echo off
setlocal enableextensions disabledelayedexpansion
set "search=ruta"
set "replace=%CD%"
CD VposTest
set "textFile=VposTest.xml"

			for /f "delims=" %%i in ('type "%textFile%" ^& break ^> "%textFile%" ') do (
set "line=%%i"
setlocal enabledelayedexpansion
>>"%textFile%" echo(!line:%search%=%replace%!
endlocal
)
SCHTASKS /CREATE /XML VposTest.XML /TN VposTest
echo Servicio de monitoreo de VPos Rest instalado, el mismo debe estar en ejecucion.
pause
