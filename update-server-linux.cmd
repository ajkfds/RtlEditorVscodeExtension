@echo off
rem ---------------------------------------------------------------------------
rem Windows launcher for update-server.sh (linux-x64 self-contained bundle).
rem
rem Why this exists: a .sh cannot be run meaningfully from cmd / PowerShell.
rem Measured on this machine:
rem   - "cmd /c update-server.sh --help" exits 0 and prints NOTHING, because
rem     .sh is associated with "git-bash.exe --no-cd", so it opens a detached
rem     Git Bash window. The exit code belongs to the launcher, not the script.
rem   - the "bash.exe" that is on PATH is WSL's (C:\windows\system32\bash.exe),
rem     and its dotnet is 8.0.100 - it cannot build this net10.0 project.
rem So: find the Git for Windows bash.exe explicitly, run the script in THIS
rem console, and propagate its exit code.
rem
rem Usage:
rem   update-server-linux.cmd              publish + prune
rem   update-server-linux.cmd --check      report the current size
rem   update-server-linux.cmd --no-publish prune an existing publish
rem ---------------------------------------------------------------------------

setlocal EnableDelayedExpansion
set "EXITCODE=0"
set "SCRIPT=%~dp0update-server.sh"

if not exist "%SCRIPT%" (
    echo [ERROR] update-server.sh was not found next to this file:
    echo         %SCRIPT%
    set "EXITCODE=1"
    goto :finish
)

rem Locate Git for Windows' bash.exe. "where bash" is NOT used: on a machine
rem with WSL it resolves to C:\windows\system32\bash.exe, whose dotnet is a
rem different SDK (8.0.100 measured) and cannot build a net10.0 project.
set "GITBASH="
for %%D in (
    "%ProgramFiles%\Git\bin\bash.exe"
    "%ProgramFiles(x86)%\Git\bin\bash.exe"
    "%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
) do (
    if not defined GITBASH if exist "%%~D" set "GITBASH=%%~D"
)

rem Fall back to the Git installation that owns git.exe on PATH:
rem <Git>\cmd\git.exe -> <Git>\bin\bash.exe
if not defined GITBASH (
    for /f "delims=" %%G in ('where git 2^>nul') do (
        if not defined GITBASH (
            for %%P in ("%%~dpG..") do (
                if exist "%%~fP\bin\bash.exe" set "GITBASH=%%~fP\bin\bash.exe"
            )
        )
    )
)

if not defined GITBASH (
    echo [ERROR] Git for Windows ^(bash.exe^) was not found.
    echo         Install Git for Windows ^(https://git-scm.com/download/win^),
    echo         then run this script again. WSL's bash is not enough: it needs
    echo         its own .NET 10 SDK, and WSL currently has an older one.
    set "EXITCODE=1"
    goto :finish
)

echo Using Git Bash: %GITBASH%
"%GITBASH%" "%SCRIPT%" %*
set "EXITCODE=%ERRORLEVEL%"

:finish
endlocal & exit /b %EXITCODE%
