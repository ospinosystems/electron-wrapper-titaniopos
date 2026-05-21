@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo  CERRAR DIA FISCAL (REPORTE Z) - HKA80
echo ================================================
echo.
echo Paso 1: cancelar cualquier documento abierto
IntTFHKA.exe SendCmd(7)
echo.
timeout /t 7 /nobreak >nul

echo Paso 2: REPORTE Z (cierra el dia fiscal)
IntTFHKA.exe SendCmd(I0Z)
echo.
timeout /t 12 /nobreak >nul

echo Paso 3: verificar con reporte X
IntTFHKA.exe SendCmd(I0X)
echo.
echo ================================================
echo  Copia TODO lo de arriba y enviamelo
echo ================================================
pause
