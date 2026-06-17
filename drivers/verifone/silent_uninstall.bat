@echo off

REM push working dir onto stack so can use relative paths below
pushd "%~dp0"

REM silent uninstall
msiexec.exe /qn /x VerifoneUnifiedDriverInstaller64.msi

popd