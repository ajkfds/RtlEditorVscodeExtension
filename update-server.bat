@echo off
setlocal EnableDelayedExpansion

rem ---------------------------------------------------------------------------
rem Rebuilds the bundled language server under RtlEditorVscodeExtension\server.
rem
rem Why this exists: the VS Code extension development host DIES with
rem "exit code 134" (SIGABRT) a second after "Loading development extension",
rem with no exthost folder and no crash log, when server\ is too big. It reached
rem 322 files / 734.9 MB that way - the symptom is simply "the extension failed
rem to start". Keep the folder around 147 files / ~100 MB.
rem
rem Two things make the folder grow, and both are handled here:
rem   1. `dotnet publish -o <dir>` never DELETES anything, so a previous
rem      publish's leftovers stay forever.
rem   2. -p:CopyOutputSymbolsToPublishDirectory=false does NOT stop the symbols
rem      of the referenced packages in this dependency graph: publishing into an
rem      EMPTY folder still produced 314 files / 733.9 MB (measured), including
rem      six *.pdb and the whole .playwright bundle.
rem
rem So: empty the folder, publish, then prune. Nothing else works - an
rem AfterTargets="Publish" MSBuild target was tried and silently matched
rem nothing, because with "-o <relative dir>" the item globs resolve against the
rem project directory.
rem
rem Usage:
rem   update-server.bat              publish + prune (the normal case)
rem   update-server.bat --check      only report the current size
rem   update-server.bat --no-publish prune an existing publish without rebuilding
rem
rem Requires the .NET SDK on PATH. Must be run from anywhere; the paths are
rem resolved relative to this file.
rem ---------------------------------------------------------------------------

set "EXITCODE=0"

rem Paths are derived from this script's location (RtlEditorVscodeExtension\).
set "EXT_DIR=%~dp0"
if "%EXT_DIR:~-1%"=="\" set "EXT_DIR=%EXT_DIR:~0,-1%"
for %%I in ("%EXT_DIR%\..") do set "REPO_ROOT=%%~fI"
set "SERVER_DIR=%EXT_DIR%\server"
set "CSPROJ=%REPO_ROOT%\SystemVerilogLanguageServer\SystemVerilogLanguageServer.csproj"
set "SERVER_EXE=%SERVER_DIR%\SystemVerilogLanguageServer.dll"

echo ============================================================
echo  RtlEditor2 - bundled language server update
echo ============================================================
echo  extension : %EXT_DIR%
echo  repo root : %REPO_ROOT%
echo  server    : %SERVER_DIR%
echo.

if not exist "%CSPROJ%" (
    echo [ERROR] server project not found:
    echo         %CSPROJ%
    echo         Run this script from inside the RtlEditor2 repository.
    set "EXITCODE=1"
    goto :finish
)

rem The publish step needs the SDK; check once up front so a missing dotnet does
rem not look like a failed build halfway through.
where dotnet >nul 2>nul
if not "%ERRORLEVEL%"=="0" (
    echo [ERROR] dotnet was not found on PATH. Install the .NET SDK first.
    set "EXITCODE=1"
    goto :finish
)

rem ---- argument parsing -----------------------------------------------------
set "DO_PUBLISH=1"
set "CHECK_ONLY=0"
rem Each branch shifts on its own line: "if cond cmd & shift" would run the
rem part after & unconditionally (cmd splits on & before evaluating the if).
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--check" goto :arg_check
if /i "%~1"=="--no-publish" goto :arg_no_publish
if /i "%~1"=="-h" goto :usage
if /i "%~1"=="--help" goto :usage
echo [ERROR] unknown argument: %~1
set "EXITCODE=1"
goto :finish
:arg_check
set "CHECK_ONLY=1"
shift
goto :parse_args
:arg_no_publish
set "DO_PUBLISH=0"
shift
goto :parse_args
:args_done

if "%CHECK_ONLY%"=="1" (
    call :report_size
    goto :finish
)

rem ---- 1. empty the output folder ------------------------------------------
rem This is not optional: dotnet publish only adds / overwrites files.
if exist "%SERVER_DIR%" (
    echo [1/3] removing %SERVER_DIR%
    rd /s /q "%SERVER_DIR%"
    if exist "%SERVER_DIR%" (
        echo [ERROR] could not remove the server folder.
        echo         A running VS Code language server may be locking it.
        echo         Close VS Code (all windows) and try again.
        set "EXITCODE=1"
        goto :finish
    )
) else (
    echo [1/3] %SERVER_DIR% does not exist yet
)

if "%DO_PUBLISH%"=="0" (
    echo [2/3] skipped ^(--no-publish^)
    if not exist "%SERVER_DIR%" (
        echo [ERROR] nothing to prune: %SERVER_DIR% is empty.
        set "EXITCODE=1"
        goto :finish
    )
    goto :do_prune
)

rem ---- 2. publish ----------------------------------------------------------
echo [2/3] dotnet publish (Release)
pushd "%REPO_ROOT%"
dotnet publish "%CSPROJ%" -c Release -o "%SERVER_DIR%" ^
    -p:DebugType=None -p:DebugSymbols=false ^
    -p:CopyOutputSymbolsToPublishDirectory=false
set "PUBLISH_EXIT=%ERRORLEVEL%"
popd
if not "%PUBLISH_EXIT%"=="0" (
    echo [ERROR] dotnet publish failed with exit code %PUBLISH_EXIT%.
    set "EXITCODE=%PUBLISH_EXIT%"
    goto :finish
)

:do_prune
rem ---- 3. prune what must never reach the debug host / the .vsix -----------
rem   .playwright\        browser automation bundle (~100 MB), unused here
rem   **\*.pdb            package symbols (~250 MB)
rem   runtimes\<rid>      every platform but the host's (only win-* on Windows)
echo [3/3] pruning
call :prune_playwright
call :prune_pdb
call :prune_runtimes

echo.
call :report_size
call :verify

:finish
echo.
if "%EXITCODE%"=="0" (
    echo Done. Reload the VS Code window to pick up the new server.
) else (
    echo Finished with errors ^(exit code %EXITCODE%^).
)
endlocal & exit /b %EXITCODE%


rem ===========================================================================
rem helpers
rem ===========================================================================

:usage
echo Usage: update-server.bat [--check] [--no-publish]
echo.
echo   (no argument)  empty server\, publish, then prune
echo   --check        report the current size and exit
echo   --no-publish   prune an existing publish without rebuilding
echo.
echo Target size: about 147 files / 100 MB. A folder over 150 MB makes the
echo VS Code extension host die with exit code 134 on startup.
set "EXITCODE=0"
goto :finish

:prune_playwright
if exist "%SERVER_DIR%\.playwright" (
    rd /s /q "%SERVER_DIR%\.playwright" 2>nul
    if exist "%SERVER_DIR%\.playwright" (
        echo   [warn] could not remove .playwright\
    ) else (
        echo   removed .playwright\
    )
)
goto :eof

:prune_pdb
rem `del /s` is used instead of a for-loop so a locked file only warns.
del /s /q "%SERVER_DIR%\*.pdb" >nul 2>nul
goto :eof

:prune_runtimes
if not exist "%SERVER_DIR%\runtimes" goto :eof
rem Keep only the host platform family: win / osx / linux (any architecture),
rem so win-x64, win-x86 and win-arm64 all survive on Windows.
for /d %%D in ("%SERVER_DIR%\runtimes\*") do (
    set "RID=%%~nxD"
    set "KEEP=0"
    if /i "!RID:~0,3!"=="win" set "KEEP=1"
    if /i "!RID:~0,3!"=="osx" set "KEEP=1"
    if /i "!RID:~0,5!"=="linux" set "KEEP=1"
    if "!KEEP!"=="0" (
        rd /s /q "%%~fD" 2>nul
        if exist "%%~fD" (
            echo   [warn] could not remove runtimes\!RID!
        ) else (
            echo   removed runtimes\!RID!
        )
    )
)
goto :eof

:report_size
rem Reports what actually matters for the crash. The byte total is NOT read from
rem `dir`'s summary line: that text is localised ("N 個のファイル" / "N File(s)")
rem and the column layout differs per locale, which made the parsed value wrong
rem or empty. Counting the listed files instead is locale independent.
set "FILES=0"
if not exist "%SERVER_DIR%" (
    echo   server\: missing
    goto :eof
)
for /f %%A in ('dir /s /b /a-d "%SERVER_DIR%" 2^>nul ^| find /c /v ""') do set "FILES=%%A"
set "PDB=0"
for /f %%A in ('dir /s /b /a-d "%SERVER_DIR%\*.pdb" 2^>nul ^| find /c /v ""') do set "PDB=%%A"
set "RUNTIMES="
if exist "%SERVER_DIR%\runtimes" (
    for /d %%D in ("%SERVER_DIR%\runtimes\*") do set "RUNTIMES=!RUNTIMES! %%~nxD"
)
set "PLAYWRIGHT=absent"
if exist "%SERVER_DIR%\.playwright" set "PLAYWRIGHT=PRESENT"

rem 150 files is the threshold above which the extension host starts dying;
rem report it plainly so the state is obvious at a glance.
set "SIZE_STATE=ok"
if !FILES! GTR 200 set "SIZE_STATE=TOO BIG - the extension host will crash (exit code 134)"
echo   files: !FILES! (!SIZE_STATE!)
echo   *.pdb: !PDB!   .playwright: !PLAYWRIGHT!
if defined RUNTIMES echo   runtimes:!RUNTIMES!
goto :eof

:verify
if not exist "%SERVER_EXE%" (
    echo [ERROR] %SERVER_EXE% was not produced.
    set "EXITCODE=1"
    goto :eof
)

rem The point of this script is a small folder, so fail loudly when the prune
rem did not actually happen (a leftover .playwright or a foreign runtime means
rem the extension host will die again with exit code 134).
set "LEFTOVER=0"
if exist "%SERVER_DIR%\.playwright" set "LEFTOVER=1"
if exist "%SERVER_DIR%\runtimes\linux-x64" set "LEFTOVER=1"
if exist "%SERVER_DIR%\runtimes\osx-arm64" set "LEFTOVER=1"
if "!LEFTOVER!"=="1" (
    echo   [ERROR] prune incomplete: .playwright or a foreign runtime is still
    echo           there. The extension host will crash on startup.
    set "EXITCODE=1"
)

echo   selftest:
dotnet "%SERVER_EXE%" --selftest >nul 2>nul
if "%ERRORLEVEL%"=="0" (
    echo   [ok] the server answers LSP requests
) else (
    echo   [warn] --selftest failed; the server may not start in VS Code
)
goto :eof
