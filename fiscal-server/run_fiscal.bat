@echo off
cd /d "%~dp0"
IntTFHKA.exe %*
echo EXIT_CODE:%ERRORLEVEL%
