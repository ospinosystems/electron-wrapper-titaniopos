@echo off

REM push working dir onto stack so can use relative paths below
pushd "%~dp0"

REM silently install the new version with below default settings.
REM SINGLE_DEVICE_SYSTEM , PORT no. 9, PORT Link name as COM.
msiexec /qn /i VerifoneUnifiedDriverInstaller64.msi PORT=9 SINGLE_DEVICE_SYSTEM=1 PORT_ROOT_LINK_NAME=COM FILE_LOGGING_OFF=1 IGNOREHWSERNUM=0

popd
