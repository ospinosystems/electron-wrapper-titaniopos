@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo  DIAGNOSTICO DIRECTO IMPRESORA FISCAL HKA
echo  (ejecuta IntTFHKA.exe directamente, sin el POS)
echo ================================================
echo.
type Puerto.dat
echo.
echo --- 1) CheckFprinter (ping, no imprime) ---
IntTFHKA.exe CheckFprinter
echo.
echo --- 2) Estado S1 ---
IntTFHKA.exe SendCmd(S1)
echo.
echo --- 3) Reporte X (I0X) - imprime estado del dia ---
IntTFHKA.exe SendCmd(I0X)
echo.
echo ================================================
echo  Copia TODO lo de arriba y enviaselo al asistente
echo ================================================
pause
