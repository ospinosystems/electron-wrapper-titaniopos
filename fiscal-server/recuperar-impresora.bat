@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo  RECUPERACION IMPRESORA FISCAL HKA80
echo ================================================
echo.
echo Paso 1: cancelar documento abierto (intento 1)
IntTFHKA.exe SendCmd(7)
echo.
timeout /t 6 /nobreak >nul

echo Paso 2: cancelar documento abierto (intento 2)
IntTFHKA.exe SendCmd(7)
echo.
timeout /t 6 /nobreak >nul

echo Paso 3: cancelar documento abierto (intento 3)
IntTFHKA.exe SendCmd(7)
echo.
timeout /t 6 /nobreak >nul

echo Paso 4: probar reporte X (si da Error 0 = RECUPERADA)
IntTFHKA.exe SendCmd(I0X)
echo.
echo ================================================
echo  Copia TODO lo de arriba y enviamelo
echo ================================================
pause
