#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Linux (linux-x64, self-contained) variant of update-server.bat.
#
# Rebuilds the bundled language server under
#   RtlEditorVscodeExtension/server-linux-x64/
#
# Why this exists: the VS Code extension development host DIES with
# "exit code 134" (SIGABRT) a second after "Loading development extension",
# with no exthost folder and no crash log, when the bundled server folder is
# too big (measured at 322 files / 734.9 MB; a healthy framework-dependent
# folder is about 147 files / ~100 MB). The extension folder is watched as a
# whole, so EVERY bundled server folder has to stay small - including this one.
#
# A SELF-CONTAINED linux-x64 publish is ~139 MB / 322 files even when clean,
# because the whole .NET runtime (System.*.dll, libcoreclr.so, ...) ships with
# it. That is the price of "runs on Linux without installing .NET"; judge the
# folder by SIZE, not by the file count (see report_size).
#
# Why a separate folder (and not the same `server/` the .bat uses):
#   a publish is bound to one RID. The managed DLLs, the .deps.json and the
#   native libraries differ per platform, so a Windows publish and a Linux
#   publish cannot share a directory. `server/` stays the Windows bundle and
#   `server-linux-x64/` is the Linux one; extension.js picks the folder that
#   matches process.platform.
#
# Compilation happens ON WINDOWS: `dotnet publish -r linux-x64` cross-compiles
# from a Windows SDK, so this script is meant to be run from Git Bash / MSYS2
# (it also works on a Linux host, where --selftest is actually executed).
#
# Two things make the folder grow, and both are handled here (same reasoning
# as update-server.bat):
#   1. `dotnet publish -o <dir>` never DELETES anything, so a previous
#      publish's leftovers stay forever.
#   2. -p:CopyOutputSymbolsToPublishDirectory=false does NOT stop the symbols
#      of the referenced packages in this dependency graph; publishing into an
#      EMPTY folder still produced ~250 MB of *.pdb (measured on Windows).
#
# So: empty the folder, publish, then prune. Nothing else works - an
# AfterTargets="Publish" MSBuild target was tried and silently matched
# nothing, because with "-o <relative dir>" the item globs resolve against the
# project directory.
#
# Usage:
#   ./update-server.sh              publish + prune (the normal case)
#   ./update-server.sh --check      only report the current size
#   ./update-server.sh --no-publish prune an existing publish without rebuilding
#
# Requires the .NET SDK on PATH. Can be run from anywhere; the paths are
# resolved relative to this file.
#
# Running it ON WINDOWS: a .sh cannot be started meaningfully from cmd or
# PowerShell. Measured on this machine:
#   - "cmd /c update-server.sh --help" exits 0 and prints NOTHING (.sh is
#     associated with "git-bash.exe --no-cd", so a detached Git Bash window
#     opens and the exit code belongs to the launcher, not to the script)
#   - the "bash.exe" on PATH is WSL's (C:\windows\system32\bash.exe) and its
#     dotnet is 8.0.100 - it cannot build this net10.0 project
# Use update-server-linux.cmd (finds Git for Windows' bash and propagates the
# exit code), or run this file from a Git Bash prompt:
#   bash update-server.sh --check
#
# The executable bit is committed as 100755, but a Windows checkout drops it,
# so re-apply it once if you want "./update-server.sh" to work on Linux:
#   git update-index --chmod=+x RtlEditorVscodeExtension/update-server.sh
# ---------------------------------------------------------------------------

set -u
set -o pipefail

EXITCODE=0

# Paths are derived from this script's location (RtlEditorVscodeExtension/).
EXT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(cd -- "$EXT_DIR/.." && pwd)
SERVER_DIR="$EXT_DIR/server-linux-x64"
CSPROJ="$REPO_ROOT/SystemVerilogLanguageServer/SystemVerilogLanguageServer.csproj"
SERVER_EXE="$SERVER_DIR/SystemVerilogLanguageServer"

RID=linux-x64

# Running under Git Bash / MSYS2 / Cygwin on Windows: the ELF apphost cannot be
# executed there, so --selftest is skipped and paths are handed to dotnet.exe
# in Windows form (MSYS already converts arguments, but cygpath is exact).
HOST_IS_WINDOWS=0
case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*) HOST_IS_WINDOWS=1 ;;
esac

# Converts a POSIX path to a Windows path when running on Windows, otherwise
# returns it unchanged.
to_native_path() {
    if [ "$HOST_IS_WINDOWS" = "1" ] && command -v cygpath >/dev/null 2>&1; then
        cygpath -w -- "$1"
    else
        printf '%s\n' "$1"
    fi
}

echo "============================================================"
echo " RtlEditor2 - bundled language server update ($RID)"
echo "============================================================"
echo " extension : $EXT_DIR"
echo " repo root : $REPO_ROOT"
echo " server    : $SERVER_DIR"
echo " host      : $(uname -s 2>/dev/null || echo unknown)$( [ "$HOST_IS_WINDOWS" = "1" ] && echo ' (cross-compiling for linux)' )"
echo

if [ ! -f "$CSPROJ" ]; then
    echo "[ERROR] server project not found:"
    echo "        $CSPROJ"
    echo "        Run this script from inside the RtlEditor2 repository."
    exit 1
fi

# The publish step needs the SDK; check once up front so a missing dotnet does
# not look like a failed build halfway through.
if ! command -v dotnet >/dev/null 2>&1; then
    echo "[ERROR] dotnet was not found on PATH. Install the .NET SDK first."
    exit 1
fi

# ---- argument parsing ------------------------------------------------------
DO_PUBLISH=1
CHECK_ONLY=0
while [ $# -gt 0 ]; do
    case "$1" in
        --check)      CHECK_ONLY=1 ;;
        --no-publish) DO_PUBLISH=0 ;;
        -h|--help)    usage=1 ;;
        *)
            echo "[ERROR] unknown argument: $1"
            exit 1
            ;;
    esac
    shift
done

if [ "${usage:-0}" = "1" ]; then
    echo "Usage: ./update-server.sh [--check] [--no-publish]"
    echo
    echo "  (no argument)  empty server-linux-x64/, publish, then prune"
    echo "  --check        report the current size and exit"
    echo "  --no-publish   prune an existing publish without rebuilding"
    echo
    echo "Target size: ~139 MB (322 files) - a self-contained linux-x64 publish"
    echo "carries the whole .NET runtime. A folder much larger than that means the"
    echo "prune was skipped; the extension host dies with exit code 134 when the"
    echo "bundled server folder gets very large."
    exit 0
fi

# ---- helpers ---------------------------------------------------------------

count_files() {
    [ -d "$1" ] || { echo 0; return; }
    find "$1" -type f 2>/dev/null | wc -l | tr -d ' '
}

count_pdb() {
    [ -d "$1" ] || { echo 0; return; }
    find "$1" -type f -name '*.pdb' 2>/dev/null | wc -l | tr -d ' '
}

total_bytes() {
    [ -d "$1" ] || { echo 0; return; }
    if find "$1" -type f -printf '' >/dev/null 2>&1; then
        # GNU find (Linux and Git Bash) - exact byte total.
        find "$1" -type f -printf '%s\n' 2>/dev/null | awk '{s += $1} END {printf "%d", s + 0}'
    else
        # Portable fallback; du reports 1K blocks.
        du -sk "$1" 2>/dev/null | awk '{printf "%d", $1 * 1024}'
    fi
}

format_mb() {
    awk -v b="$1" 'BEGIN { printf "%.1f MB", b / (1024 * 1024) }'
}

list_runtimes() {
    [ -d "$1/runtimes" ] || return 0
    for d in "$1"/runtimes/*; do
        [ -d "$d" ] || continue
        printf ' %s' "$(basename "$d")"
    done
}

report_size() {
    if [ ! -d "$SERVER_DIR" ]; then
        echo "  server-linux-x64/: missing"
        return
    fi
    files=$(count_files "$SERVER_DIR")
    pdb=$(count_pdb "$SERVER_DIR")
    bytes=$(total_bytes "$SERVER_DIR")
    runtimes=$(list_runtimes "$SERVER_DIR")
    playwright=absent
    [ -d "$SERVER_DIR/.playwright" ] && playwright=PRESENT

    # NOTE: the file count is NOT the crash criterion for a self-contained
    # publish. Measured: linux-x64 self-contained is 322 files / 139 MB - the
    # same file count as the 734.9 MB folder that killed the extension host,
    # because the whole .NET runtime (System.*.dll, libcoreclr.so, ...) ships
    # with it. The Windows framework-dependent bundle in server/ is 147 files /
    # ~100 MB. So judge by SIZE; the file count is informational and only
    # flags a folder that is clearly an unpruned publish (600+ files).
    state=ok
    if [ "$bytes" -gt $((250 * 1024 * 1024)) ]; then
        state="TOO BIG - the extension host may crash (exit code 134)"
    elif [ "$files" -gt 600 ]; then
        state="unexpectedly many files - was the prune skipped?"
    fi

    echo "  files: $files ($state)"
    echo "  size : $(format_mb "$bytes")"
    echo "  *.pdb: $pdb   .playwright: $playwright"
    [ -n "$runtimes" ] && echo "  runtimes:$runtimes"
    return 0
}

prune_playwright() {
    [ -d "$SERVER_DIR/.playwright" ] || return 0
    if rm -rf "$SERVER_DIR/.playwright" 2>/dev/null && [ ! -d "$SERVER_DIR/.playwright" ]; then
        echo "  removed .playwright/"
    else
        echo "  [warn] could not remove .playwright/"
    fi
}

prune_pdb() {
    [ -d "$SERVER_DIR" ] || return 0
    removed=0
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        rm -f "$f" 2>/dev/null && removed=$((removed + 1))
    done <<EOF
$(find "$SERVER_DIR" -type f -name '*.pdb' 2>/dev/null)
EOF
    echo "  removed $removed *.pdb file(s)"
}

prune_runtimes() {
    [ -d "$SERVER_DIR/runtimes" ] || return 0
    # A RID-specific (self-contained) publish normally flattens the native
    # assets into the output root, but a package that ships a runtimes/<rid>
    # layout can still leave one behind. Keep only the linux family (any
    # architecture: linux-x64 / linux-arm64) so the folder cannot accumulate
    # the windows / osx / browser copies again.
    for d in "$SERVER_DIR"/runtimes/*; do
        [ -d "$d" ] || continue
        rid=$(basename "$d")
        case "$rid" in
            linux*|unix*)
                echo "  kept runtimes/$rid"
                ;;
            *)
                if rm -rf "$d" 2>/dev/null && [ ! -d "$d" ]; then
                    echo "  removed runtimes/$rid"
                else
                    echo "  [warn] could not remove runtimes/$rid"
                fi
                ;;
        esac
    done
}

verify() {
    if [ ! -f "$SERVER_EXE" ]; then
        echo "[ERROR] $SERVER_EXE was not produced."
        EXITCODE=1
        return
    fi

    # The apphost must be a Linux ELF binary. Publishing a win-x64 build into
    # this folder by mistake produces a PE ("MZ") file that cannot start on
    # Linux at all, and the only symptom in VS Code is a spawn error.
    magic=$(head -c 4 "$SERVER_EXE" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')
    if [ "$magic" = "7f454c46" ]; then
        echo "  apphost: ELF (linux executable)"
    elif [ "$magic" = "4d5a" ]; then
        echo "  [ERROR] the apphost is a Windows PE binary - this is not a $RID publish."
        EXITCODE=1
    else
        echo "  [warn] could not confirm the apphost format (magic: ${magic:-none})"
    fi

    # The point of this script is a small folder, so fail loudly when the prune
    # did not actually happen (a leftover .playwright, a *.pdb or a foreign
    # runtime means the extension host can die again with exit code 134).
    # This check must match prune_pdb / prune_runtimes exactly.
    leftover=0
    [ -d "$SERVER_DIR/.playwright" ] && leftover=1
    if [ -d "$SERVER_DIR/runtimes" ]; then
        for d in "$SERVER_DIR"/runtimes/*; do
            [ -d "$d" ] || continue
            rid=$(basename "$d")
            case "$rid" in
                linux*|unix*) ;;
                *) leftover=1 ;;
            esac
        done
    fi
    [ "$(count_pdb "$SERVER_DIR")" != "0" ] && leftover=1
    if [ "$leftover" = "1" ]; then
        echo "  [ERROR] prune incomplete: .playwright, a *.pdb or a foreign runtime"
        echo "          is still there. The extension host may crash on startup."
        EXITCODE=1
    fi

    # --selftest needs to execute the ELF, which is impossible on Windows.
    if [ "$HOST_IS_WINDOWS" = "1" ]; then
        echo "  selftest: skipped (cross-compiled on $(uname -s); run it on Linux)"
        echo "            ./server-linux-x64/SystemVerilogLanguageServer --selftest"
        # The executable bit is a POSIX permission and is NOT set by a Windows
        # cross-publish (nor preserved by zip / .vsix packaging). Record it here
        # so the missing bit is not mistaken for a broken build.
        echo "  note: the executable bit is set on Linux by extension.js (chmod +x),"
        echo "        so a missing bit is not a build problem."
    else
        echo "  selftest:"
        if "$SERVER_EXE" --selftest >/dev/null 2>&1; then
            echo "  [ok] the server answers LSP requests"
        else
            echo "  [warn] --selftest failed; the server may not start in VS Code"
        fi
    fi

    # The RTL Hierarchy menu rows live in package.json (VS Code reads
    # `contributes` once at load time and has no API to add a row at run time),
    # so a catalog change that is not written into package.json never appears.
    # Not fatal - the server itself is fine - but the symptom is "the menu did
    # not change" with nothing in any log, so say it here.
    echo "  menu manifest:"
    # The generator lives in the Windows/Debug server assembly, not in the
    # linux-x64 bundle (which cannot be executed on a Windows host).
    MANIFEST_SERVER="$REPO_ROOT/SystemVerilogLanguageServer/bin/Debug/net10.0/SystemVerilogLanguageServer.dll"
    if [ -f "$MANIFEST_SERVER" ]; then
        if dotnet "$MANIFEST_SERVER" --check-hierarchy-menu-manifest "$EXT_DIR/package.json" >/dev/null 2>&1; then
            echo "  [ok] package.json matches the C# menu catalog"
        else
            echo "  [warn] package.json is out of date. The new menu rows will NOT"
            echo "         appear in VS Code until it is regenerated:"
            echo "           cd RtlEditorVscodeExtension && npm run generate-menu"
        fi
    else
        echo "  skipped (no server build at $MANIFEST_SERVER)"
        echo "          run: npm run generate-menu"
    fi
}

# ---- 0. --check ------------------------------------------------------------

if [ "$CHECK_ONLY" = "1" ]; then
    report_size
    exit 0
fi

# ---- 1. empty the output folder --------------------------------------------
# This is not optional: dotnet publish only adds / overwrites files.
# --no-publish must NOT empty it (that would leave nothing to prune), so the
# whole step is skipped in that mode.
if [ "$DO_PUBLISH" = "0" ]; then
    echo "[1/3] skipped (--no-publish)"
    if [ ! -d "$SERVER_DIR" ]; then
        echo "[ERROR] nothing to prune: $SERVER_DIR does not exist."
        exit 1
    fi
else
    if [ -d "$SERVER_DIR" ]; then
        echo "[1/3] removing $SERVER_DIR"
        rm -rf "$SERVER_DIR" 2>/dev/null || true
        if [ -d "$SERVER_DIR" ]; then
            echo "[ERROR] could not remove the server folder."
            echo "        A running VS Code language server may be holding it open."
            echo "        Close VS Code (all windows) and try again."
            exit 1
        fi
    else
        echo "[1/3] $SERVER_DIR does not exist yet"
    fi

    # ---- 2. publish --------------------------------------------------------
    # -r linux-x64 --self-contained true  => the folder runs without a .NET
    #   runtime installed on the target machine (and the apphost is ELF).
    # -p:DebugType=None -p:DebugSymbols=false
    #   => no symbols for THIS project.
    # -p:CopyOutputSymbolsToPublishDirectory=false
    #   => no symbols for the referenced packages (SkiaSharp etc.); prune_pdb
    #      still runs because this setting does not cover everything.
    echo "[2/3] dotnet publish (Release, $RID, self-contained)"
    publish_exit=0
    (
        cd "$REPO_ROOT" || exit 1
        dotnet publish "$(to_native_path "$CSPROJ")" \
            -c Release \
            -r "$RID" \
            --self-contained true \
            -o "$(to_native_path "$SERVER_DIR")" \
            -p:DebugType=None \
            -p:DebugSymbols=false \
            -p:CopyOutputSymbolsToPublishDirectory=false
    ) || publish_exit=$?

    if [ "$publish_exit" != "0" ]; then
        echo "[ERROR] dotnet publish failed with exit code $publish_exit."
        exit "$publish_exit"
    fi
fi

# ---- 3. prune what must never reach the debug host / the .vsix ------------
#   .playwright/     browser automation bundle (~100 MB), unused here
#   **/*.pdb         package symbols (~250 MB)
#   runtimes/<rid>   every platform but linux
echo "[3/3] pruning"
prune_playwright
prune_pdb
prune_runtimes

echo
report_size
verify

echo
if [ "$EXITCODE" = "0" ]; then
    echo "Done. Copy server-linux-x64/ into <extension>/ on the Linux machine and"
    echo "reload the VS Code window (extension.js picks the folder that matches"
    echo "process.platform). 'npm run package' only bundles the Windows server,"
    echo "so run this script first if the .vsix must also work on Linux."
else
    echo "Finished with errors (exit code $EXITCODE)."
fi
exit "$EXITCODE"
