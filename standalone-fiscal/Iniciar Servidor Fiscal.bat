@echo off
REM ============================================================
REM TitanioPOS - Servidor Fiscal HKA (standalone)
REM Arranca el server Python en localhost:3000
REM ============================================================

cd /d "%~dp0"

set "PYTHON_EXE=%~dp0python-embed\python.exe"
set "FISCAL_SCRIPT=%~dp0fiscal-server\fiscal.py"
set "FISCAL_RUNTIME_DIR=%APPDATA%\TitanioPOS\fiscal"

if not exist "%PYTHON_EXE%" (
    echo [ERROR] No se encontro Python embebido en:
    echo   %PYTHON_EXE%
    echo.
    echo Verifica que descomprimiste el ZIP completo.
    pause
    exit /b 1
)

if not exist "%FISCAL_SCRIPT%" (
    echo [ERROR] No se encontro fiscal.py en:
    echo   %FISCAL_SCRIPT%
    pause
    exit /b 1
)

if not exist "%FISCAL_RUNTIME_DIR%" mkdir "%FISCAL_RUNTIME_DIR%"

echo ============================================================
echo  TitanioPOS - Servidor Fiscal
echo ============================================================
echo  Python:       %PYTHON_EXE%
echo  Script:       %FISCAL_SCRIPT%
echo  Datos:        %FISCAL_RUNTIME_DIR%
echo  URL:          http://localhost:3000
echo ============================================================
echo.
echo  Deja esta ventana abierta. Cerrar = apagar el servidor.
echo.

cd /d "%~dp0fiscal-server"
"%PYTHON_EXE%" "%FISCAL_SCRIPT%"

echo.
echo [El servidor termino con codigo %ERRORLEVEL%]
pause
