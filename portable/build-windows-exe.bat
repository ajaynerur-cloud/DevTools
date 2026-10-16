@echo off
rem Builds dist\DevHub-Portable.exe and dist\DevHub.html on Windows.
rem Needs Python 3 (python) and Go 1.21+ (go) on PATH. Run it from anywhere.
setlocal
cd /d "%~dp0.."
where python >nul 2>&1 || (echo Python 3 is required: https://www.python.org/downloads/ & exit /b 1)
where go >nul 2>&1 || (echo Go 1.21 or newer is required: https://go.dev/dl/ & exit /b 1)
python portable\build-single-file.py dist\DevHub.html || exit /b 1
copy /y dist\DevHub.html portable\windows\DevHub.html >nul || exit /b 1
pushd portable\windows
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=0
go build -trimpath -ldflags "-H=windowsgui -s -w" -o ..\..\dist\DevHub-Portable.exe . || (popd & exit /b 1)
popd
del portable\windows\DevHub.html
echo.
echo Built: %CD%\dist\DevHub-Portable.exe
endlocal
