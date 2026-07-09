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
set JAVA_HOME=.\jre
%JAVA_HOME%\bin\java.exe -version
%JAVA_HOME%\bin\java.exe -classpath .\lib\log4j-api-2.17.2.jar;.\lib\log4j-core-2.17.2.jar;.\lib\Bematech.jar;.\lib\BiopagoBDV.jar;.\lib\EXML.jar;.\lib\ImpresorasFiscales_1.0.jar;.\lib\TfhkaJava.jar;.\lib\TlvBuilder.jar;.\lib\VposUniversal.jar;.\lib\WinRegistry-4.5.jar;.\lib\bundles.jar;.\lib\clibwrapper_jiio.jar;.\lib\cliente-tokenizador-0.0.1-SNAPSHOT-jar-with-dependencies.jar;.\lib\comm.jar;.\lib\commons-codec-1.7.jar;.\lib\commons-httpclient-3.1.jar;.\lib\commons-logging-1.0.4.jar;.\lib\freemarker.jar;.\lib\gson-2.8.6.jar;.\lib\ikernel-Desa.jar;.\lib\jai_imageio.jar;.\lib\jettison-1.2.jar;.\lib\jna.jar;.\lib\kxml2-min-2.3.0.jar;.\lib\log4j-1.2-api-2.17.2.jar;.\lib\log4j-api-2.17.2.jar;.\lib\log4j-core-2.17.2.jar;.\lib\mlibwrapper_jai.jar;.\lib\msb2b-7.0.jar;.\lib\nrjavaserial-5.1.1.jar;.\lib\olb-pos-3.0.1.jar;.\lib\pinpad-1.0.0.jar;.\lib\qrcodegenerator-1.0.0.jar;.\lib\reinicio-vpos-1.0.0.jar;.\lib\stax-api-1.0.1.jar;.\lib\systray4j.jar;.\lib\xmlISO-1.3.jar;.\lib\xmlParserAPIs.jar;.\lib\xstream-1.4.2.jar;.\lib\comm.jar ve.com.megasoft.simuladores.vpos.VposUtility
pause
