# SystemVerilog LSP (RtlEditor2)

A VS Code extension that brings RtlEditor2's SystemVerilog/Verilog language
server and RTL instance hierarchy to VS Code.

The language server is bundled inside the extension (no separate .NET install
or build step needed once it is packaged).

## Features

- Go to definition / Find references / Hover (markdown) / Outline
  (`documentSymbol`) / Completion
- **Hover code blocks are coloured** with the parser's palette. A hover shows
  the parser's own declaration label (the same text and colours the editor's
  mouse-over hint paints, including its `@sync clk` / `@clock` annotation
  lines). VS Code strips `style` / `class` from markdown, so the colour comes
  from a fenced code block plus a TextMate grammar generated from the C#
  palette - see [Hover colours](#hover-colours)
- Semantic-token syntax highlighting driven by the parser (including the
  comment annotations such as `// @sync:clk` / `// @clock` / `// @scope ...`,
  which keep the editor's distinct colour instead of blending into the comment).
  Declaration names (the module name of an instantiation, the instance name and
  the named port labels such as `.clk`) use the editor's teal `identifier`
  colour; plain references keep their data-object colour (net / variable /
  register / parameter)
- Diagnostics (parse errors / warnings / notices) as editor squiggles and in the
  Problems panel
- **RTL Hierarchy** tree view (see below) with the same content as RtlEditor2's
  NavigatePanel
- **Messages** pane (see below) on the right-hand side, the equivalent of
  RtlEditor2's MessageView
- **Snippets** from the editor (see below): alwaysFF block, instance
  auto-format, module instance, port connection fill, port inversion, modport
  generation
- **Tool menu** (see below): the editor's `Shift+Space` tool list in a QuickPick
- **Auto Connect** form (see below): every port of an instantiation in one
  panel, with the signal the editor would connect

## Hover colours

A hover shows the parser's declaration label inside a fenced code block tagged
`systemverilog-hover`. That block is the only place the extension's TextMate
grammar applies; it never touches the editor's own highlighting, which stays on
the semantic tokens (those carry the real parser's colours, including the
comment annotations).

Why a fence is the only option: VS Code's markdown sanitizer allows only
`href`, `target`, `src`, `alt`, `title`, `for`, `name`, `role`, `tabindex`,
`x-dispatch`, `required`, `checked`, `placeholder`, `type`, `start`, `width`,
`height`, `align` - there is no `style` or `class`, so an inline-coloured
`<span>` is stripped and the text renders flat. A fence, by contrast, is
tokenised by a TextMate grammar, and the grammar's colours are what you see.

`syntaxes/systemverilog.tmLanguage.json` is **generated** from C#:

| Input | Source |
|---|---|
| colours | `CodeEditor2VerilogPlugin/.../CodeDrawStyle.cs` (the editor palette) |
| keywords / types | the parser's keyword sets in `CoreBridge/HoverGrammar.cs` |

so the VS Code hover cannot drift from the editor's mouse-over hint. Regenerate
it after changing either:

```bash
npm run generate-hover-grammar   # rewrite the grammar
npm run check-hover-grammar      # fail if it is stale
```

`npm run vsix` runs the generator before packaging, and
`HoverGrammarTests` fails the test suite if the committed file is stale, is not
contributed by `package.json`, colours a scope it does not emit (or vice versa),
uses a colour outside the palette, or contains a regex that does not compile.

> The grammar is contributed for its own language id, deliberately **not** for
> `systemverilog`: contributing a grammar for the editor language would take
> syntax highlighting away from the semantic tokens.

## Snippets

**All snippet logic is implemented in C#.** The extension holds none of it: it
asks the server (`rtl/snippet`) for the text and inserts it. The desktop editor
uses the same code - `CoreBridge.SnippetAdapter` produces the text and
`Verilog/Snippets/SnippetRunner` drives the editor's highlights - so a snippet
cannot behave differently in the two hosts.

Available from the command palette (`SystemVerilog Snippet: ...`) and the
editor right-click menu:

| Command | What it does |
|---|---|
| `Insert alwaysFF Block` | `always @(posedge clk or negedge rst)` block; the clock / reset are prefilled tab stops taken from the ports annotated `// @sync: clock` / `// @sync: reset`. With several annotated clocks / resets the tab stop becomes a choice list, and the `if(~reset)` follows the reset field automatically |
| `AutoFormat Instance at Caret` | Reformats **only** the module instantiation under the caret (one port connection per line). This is the editor's `autoFormat` tool, not the whole-document formatter |
| `Insert Module Instance` | Full instantiation of a module (parameter overrides + one named port connection per port). Shows a module picker first. The instance name is tab stop 1 (prefilled) and every port connection is a **blank** tab stop - like the editor, no signal name is guessed |
| `Fill Port Connections` | Rewrites the instantiation under the caret, filling every port connection |
| `Invert Selected Ports` | Flips `input`/`output` and the `_I`/`_O` name suffix of the selected port declarations |
| `Generate Modport` | Modport listing every logic signal of the enclosing interface |

The text of every snippet comes from **one implementation**
(`CoreBridge.SnippetAdapter` in the plugin), which renders the same template
twice:

- `snippetText` with VS Code tab stops (`${1:name}`, `${2|a,b|}`) - inserted by
  this extension;
- `plainText` with every field's default inlined - inserted by the desktop
  editor, which highlights the reported `fields` and lets the user tab through
  them.

Because both hosts read the same template they cannot insert different text
(they used to have separate builders - e.g. port inversion kept two copies of
its regular expression). The interaction is expressed declaratively, so VS Code
gets it without any extra client logic:

| editor behaviour | VS Code equivalent |
|---|---|
| several clocks / resets offered in a popup | `${1\|CLK_I,CLK2_I\|}` choice list |
| `if(~reset)` copied from the reset field | `${2}` used twice (a mirror) |
| `Tab` / `Enter` moves to the next field | `Tab` / `Shift+Tab` |
| `Escape` aborts | `Escape` (or click outside the snippet) |
| caret moved to another line aborts | leaving the snippet session ends it |

The editor's key handling is therefore not "not reproduced": what it did
imperatively (ask, copy, move on) is what the tab stops and mirrors describe.
Only `Connection Check` remains desktop-only, because its result is a tree
window rather than inserted text.

`Insert Module Instance` uses `${1:name}` for the instance name and a blank
`${2}` / `${3}` ... for every port connection: the editor's own snippet writes
`.port(  )` and never guesses a signal, so accepting the snippet does not wire a
port to a signal that may not exist. `Fill Port Connections` is the tool that
*does* fill them (it derives the signal from the port name).

## Tool menu (`Shift+Space`)

`Shift+Space` in a SystemVerilog / Verilog editor (or
`SystemVerilog Snippet: Show Tool Menu` from the command palette) opens the same
tool list the desktop editor shows, as a QuickPick:

- the list itself is the server's (`rtl/toolMenu`), built from
  `CoreBridge.ToolMenuCatalog` - the **same** catalog the editor iterates, so
  adding a tool is a one-place change and the two menus cannot drift apart;
- each row's availability is decided by the server (`CoreBridge.ToolMenuAdapter`),
  which asks the snippet code itself whether the tool applies at the caret. A
  row that cannot run stays visible with the reason in its description, so the
  menu still matches the editor's (which always lists every tool);
- picking a row runs the corresponding command (`systemverilogLsp.snippet.*`,
  `systemverilogLsp.autoConnect`, or VS Code's own case-transform commands);
- `Connection Check` is reported as unavailable: it needs the desktop editor's
  connection tree view, which has no VS Code counterpart.

A QuickPick is used because VS Code has no API to place a flyout at the caret.

## Auto Connect

`SystemVerilog Snippet: Auto Connect Ports` (also in the editor right-click
menu) opens a panel listing **every port** of the module instantiation under the
caret, the same content and the same interaction as RtlEditor2's
`AutoConnectWindow`:

- one row per port showing the port name, its direction, the connection
  currently written in the instantiation, the best candidate signal and the
  result that will be written;
- the candidate is the signal the editor would connect (a signal whose name
  equals the port name, or the port name without an `_I` / `_O` / `_IO`
  suffix);
- port groups (`// @group` annotations) are shown as comment rows;
- **Apply** rewrites the instantiation with the chosen connections, **Cancel**
  leaves it untouched.

There is no drop-down: like the desktop window, each row is accepted or
rejected as a whole, and the keyboard is enough to drive it.

| Key | Action |
|---|---|
| `Up` / `Down` | move the cursor between ports |
| `Left` / `Space` | accept the row (connect the best candidate) and move down |
| `Right` | reject the row (leave the port unconnected) and move down |
| `Enter` | apply every row and close |
| `Escape` | cancel |

The `✓` / `✗` buttons on each row are the mouse equivalent of `Left` / `Right`;
clicking a row moves the cursor. Port group rows are not selectable, so
`Left` / `Right` always acts on a port.

The matching rule lives in the language server (the same code the desktop
editor uses), so the extension only renders the rows and forwards the choices.
The panel is a webview rather than a QuickPick because the whole port list has
to be visible at once, and a QuickPick cannot show a per-row current value
next to its candidate.

## RTL Hierarchy view

VS Code's built-in File Explorer cannot be extended with extra child nodes, so
this extension contributes its own **RTL Hierarchy** tree view inside the
Explorer container.

- The top level mirrors the project layout: every file and folder of the
  workspace is listed (not only `.sv`/`.svh`/`.v`/`.vh`). A SystemVerilog /
  Verilog file can be expanded into its module/interface instance hierarchy;
  other files are leaves that open in the editor.
- If a file is opened without a folder, the server infers the project root from
  the opened file (nearest `.git` / `*.sln` / `*.code-workspace` / ...).
- Build output / VCS folders (`obj`, `bin`, `publish`, `node_modules`, `.git`,
  `.svn`, `.hg`) are skipped.
- The tree is lazy: expanding a node issues one `rtl/hierarchy` request, and a
  source file is parsed only when expanded, so the top level answers immediately
  even for a large project.
- Clicking a node re-parses its file and refreshes the tree (so edits and their
  diagnostics show up). The view refresh icon forces a full workspace re-scan;
  files created / deleted / renamed on disk are picked up automatically.
- Right-click menu (mirrors the editor's NavigatePanel): Add Folder, Add Blank
  File, Delete, Open in Explorer, Copy Path, Property, Reveal in Editor, Copy
  Instance Path (e.g. `u_mid.u_leaf`).
- Icons come from the editor's own SVG assets (shipped in `icons/`, light and
  dark variants) and are **coloured per kind** the way the editor's NavigatePanel
  tints them:
  | icon | colour (light) | meaning |
  |---|---|---|
  | `folder` | `#556992` (blue) | a directory (`Global.Color_Folder`) |
  | `project` | `#925555` (red) | the workspace root when several folders are open (`Global.Color_Project`) |
  | `module` | `#4EC9B0` (teal) | a module instance |
  | `interface` | `#569CD6` (blue) | an interface instance |
  | `package` | `#C8A2E0` (violet) | an imported package |
  | `header` | `#D7BA7D` (gold) | an include header |
  | `systemverilog-document` | `#3FA08F` (deep teal) | a `.sv` file |
  | `verilog-document` | `#4A8FC0` (deep blue) | a `.v` file |
  | `verilog-header-document` | `#D7BA7D` (gold) | a `.svh` / `.vh` file |

  Each icon has a matching `-dark` variant (same hue, lifted towards white) so
  the colour stays legible on a dark theme.
- **Node badges** mirror the editor's NavigatePanel: an exclamation triangle at
  the bottom-left for parse **errors** (red) or **warnings** (orange), and a
  shine at the top-right for **unsaved edits** (dirty). At most one badge is
  shown, in the priority order error > warning > dirty.
  VS Code's `TreeItem.iconPath` can only hold one icon and one theme colour, so
  the badge cannot be drawn by the extension; it is composited into the asset
  (`icons/<icon>-<badge>.svg`, e.g. `icons/module-error.svg`). Folder / project
  nodes never carry a badge (the editor's `FolderNode` / `ProjectNode` do not
  draw one either), so only the file / instance icons ship badge variants.
  Regenerate them with `node scripts/generate-badge-icons.js` after editing a
  base icon.

### Node menu defined in C#

**Every** row of the node menu is defined by the language server - there are no
hand-written rows left in this extension. The same catalog
(`CoreBridge.HierarchyMenuCatalog`) also drives the desktop editor's NavigatePanel
right-click menu, so the two environments cannot drift apart.

| Entry | What it does |
|---|---|
| `Add` › `Folder` | creates an empty directory next to the node |
| `Add` › `Blank File` | creates an empty file |
| `Add` › `verilog module` | creates a `.v` file with a module skeleton |
| `Add` › `SystemVerilog module` | creates a `.sv` file with a module skeleton |
| `Add` › `SystemVerilog interface` | creates a `.sv` file with an interface skeleton |
| `Delete` | deletes the node's file / directory (asks first) |
| `Simulation` › `Simulation Setup (files)` | lists the top module, the files the simulator would compile and the include paths (the same `SimulationSetup` collection the desktop editor's Run Simulation uses), plus any unresolved references |
| `Open in Explorer` | reveals the node's file in the OS file manager |
| `Copy Path` | copies the workspace-relative path |
| `Copy Instance Path` | copies the instance path (`u_mid.u_leaf`) |
| `Property` | shows the node's path / instance path / error and warning counts |

The rows live in the plugin's `CoreBridge.HierarchyMenuCatalog`, including the
submenu nesting (`Entry.ParentId` / `Entry.IsSubmenu`); a plugin can append its
own with `HierarchyMenuCatalog.Register(...)`. A row also declares which hosts
offer it (`Entry.Hosts`): editor-only entries such as `Parse All` or
`Run Simulation` are declared `Hosts.Desktop` and never reach this extension.

#### Who performs the file-system work

The server decides **what** to do and **where** (`NavigateNodeMenuAdapter`), and
answers `rtl/hierarchyMenuInvoke` with a `ClientOperation`
(`createFolder` / `createFile` / `delete` / `reveal` + path + content). The
extension performs it through `vscode.workspace.fs`
(`executeClientOperation` in `hierarchy.js`) so remote and virtual file systems
keep working - the language server must not write files behind VS Code's back.

A row that needs a name answers with `prompt`; the extension asks for it and
calls the entry again with `argument` set, mirroring the editor's input window.
Do **not** implement a menu action in `hierarchy.js`: add the row to the catalog.

#### Why the rows are generated

VS Code reads `contributes.commands`, `contributes.submenus` and
`contributes.menus` from `package.json` **once, when the extension loads**, and
has **no API to add a menu row at run time** (`registerCommand` only supplies the
implementation). A row written in C# therefore only reaches the menu if
`package.json` already declares it.

`CoreBridge/HierarchyMenuManifest` splices the catalog into `package.json`
directly - no manual copy step:

```bash
cd vscode-extension
npm run generate-menu     # rewrite package.json from the catalog
npm run check-menu        # exit 1 when package.json is stale
```

Equivalently, without node:

```bash
dotnet SystemVerilogLanguageServer/bin/Debug/net10.0/SystemVerilogLanguageServer.dll \
    --write-hierarchy-menu-manifest RtlEditorVscodeExtension/package.json
dotnet SystemVerilogLanguageServer/bin/Debug/net10.0/SystemVerilogLanguageServer.dll \
    --check-hierarchy-menu-manifest RtlEditorVscodeExtension/package.json
```

Only the blocks the generator owns are touched: generated `commands` (ids under
`systemverilogLsp.hierarchy.`), all of `submenus`, and the generated rows plus the
submenu-keyed menus inside `contributes.menus`. Everything else - the
extension's own commands, `editor/context`, `view/title`, `configuration` - is
left as it is.

Each generated command id is `systemverilogLsp.hierarchy.<catalog id>`, and
`hierarchy.js` registers one implementation per id
(`GENERATED_HIERARCHY_MENU_IDS`) that forwards to `rtl/hierarchyMenuInvoke`.

Only rows declared `Hosts.VsCode` are emitted, so an editor-only entry never
appears here.

**Nesting matters**: a row that opens a flyout belongs to `view/item/context`,
but the submenu's *children* belong to `contributes.menus["<submenu id>"]`.
Putting a child in `view/item/context` renders it as an ordinary row of the
tree's context menu - the "Add entries are flat" symptom.

`npm run vsix` / `npm run package` run `generate-menu` first, so a release can
never ship a stale menu. `update-server.bat` / `update-server.sh` print a warning
(not an error) when `package.json` is out of date, because the server itself is
fine in that state - only the menu is stale, and nothing else reports it.

#### Menu row icons

A catalog row can carry an icon, and it is emitted as
`contributes.commands[].icon`:

- a bare name (`"verilog-document"`) becomes a light / dark pair from `icons/`;
- a codicon (`"$(trash)"`) is passed through.

**VS Code does not draw icons in `view/item/context` menus.** The schema has no
icon property for those rows, so the native right-click menu is text only - a
VS Code limitation, not a missing declaration. The icon is visible in the
command palette and in any toolbar placement, and the `Show Menu...` QuickPick
draws it too (that path uses `entry.icon` from `rtl/hierarchyMenu`).

#### Tree icons

The error / warning / dirty overlays are baked into the SVG assets
(`icons/{icon}-{badge}.svg`), because `TreeItem.iconPath` carries one icon and
cannot draw an overlay. Those variants are generated from the base icons by
`CoreBridge/BadgeIconGenerator.cs`, and the same command refreshes them:

```bash
npm run generate-menu    # package.json + badge icons
npm run generate-icons   # same thing (kept for the documented name)
npm run check-menu       # fails when either is out of date
```

`scripts/generate-badge-icons.js` is now a thin wrapper around that C# generator;
the geometry and colours live in one place only.

`SystemVerilogLanguageServer.Tests/HierarchyMenuManifestTests` and
`HierarchyMenuManifestSyncTests` fail when `package.json`, `hierarchy.js` and the
catalog drift apart.

#### `Show Menu...` fallback

`Show Menu...` (right-click a node, or the view title) still opens a QuickPick
listing every applicable entry through `rtl/hierarchyMenu`. It is what makes an
entry a plugin registers **at run time** reachable without regenerating the
manifest; nested rows appear prefixed with their submenu label
(`Simulation › Simulation Setup (files)`) because a QuickPick cannot nest.

## Messages pane

The **SystemVerilog Messages** view lives in the Auxiliary Bar (the secondary
side bar on the right-hand side of the window), so the parse messages stay
visible next to the editor - the same role as RtlEditor2's MessageView.

- Each entry shows a severity icon (error / warning / info / hint), the line
  number and the message text, sorted by file and position with errors first.
- Clicking an entry opens the file and selects the reported range.
- The scope selector switches between **Current file** (the focused document,
  like the editor) and **Whole workspace** (every file the server has parsed).
- The view title shows the error / warning counts.
- Open it with `SystemVerilog: Show Messages` from the command palette, or the
  warning icon in the Auxiliary Bar.

The pane renders the diagnostics the server already publishes through the
standard `textDocument/publishDiagnostics` notification, so it adds no custom
protocol and does not change the LSP standard. It complements (rather than
replaces) VS Code's built-in Problems panel: the Problems panel groups by file
in a tree, this pane is a flat, severity-coloured list like the editor's.

## Install

### From a `.vsix`

1. Build the VSIX (see below) or download it from GitHub Releases.
2. `Extensions: Install from VSIX...` in VS Code.
3. Open a folder containing `.sv`/`.svh`/`.v`/`.vh` files.

The extension ships the server under its `server/` folder, so nothing else is
required on end-user machines.

## Build / package the extension

Prerequisites for building: .NET SDK, Node.js, and `npm i -g @vscode/vsce`.

```bash
cd vscode-extension
npm run vsix
```

`npm run vsix` (`scripts/make-vsix.js`) runs five steps and stops at the first
problem with a readable message:

1. **toolchain check** - node / dotnet / `vsce` (falls back to
   `npx --yes @vscode/vsce` when `vsce` is not installed globally)
2. **rewrite the menu manifest** - `scripts/generate-hierarchy-menu.js` splices
   the C# catalog into `package.json`. VS Code reads `contributes` at load time,
   so a stale manifest is a menu that silently keeps the previous rows
3. **bundle the server** - `scripts/bundle-server.js` empties `server/` and runs
   `dotnet publish` into it, then prunes symbols, `.playwright/` and the
   non-host native runtimes
4. **verify the bundle** - runs `--selftest` against the exact DLL that will be
   shipped, so a missing / stale server fails here instead of silently shipping
   an extension that does nothing
5. **package** - `vsce package --no-dependencies`, producing
   `systemverilog-lsp-<version>.vsix`

Useful flags:

```bash
node scripts/make-vsix.js --skip-bundle   # repackage the existing server/ (#4 only)
node scripts/make-vsix.js --out dist      # also copy the .vsix into dist/
```

To package without rebuilding the server (e.g. CI that already published it):

```bash
npm run vsix:fast     # == npm run package:nobundle
```

`server/` is expected to stay around **100 MB**. It grew to 734 MB once
(accumulated publishes: stale `.pdb` files, every platform's native runtimes,
a bundled Playwright `node.exe`); a folder that large makes the extension
development host die with exit code 134 right after
`Loading development extension`. See `memory/vscode_extension_debugging.md`.

### Release to GitHub

A GitHub Actions workflow is provided at
`.github/workflows/vscode-extension-release.yml`. It builds the server, packages
the `.vsix` and attaches it to a GitHub Release when you push a `v*` tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

You can also run the workflow manually (Actions → "Release VS Code extension" →
Run workflow); the `.vsix` is uploaded as a downloadable artifact.

### Icon (optional)

To show an icon on the Marketplace / Extensions list, add a 128x128 `icon.png`
under `vscode-extension/` and reference it from `package.json`:

```json
"icon": "icon.png"
```

## Configuration

| Setting | Description |
|---|---|
| `systemverilogLsp.serverPath` | Path to a specific `SystemVerilogLanguageServer` executable. Leave empty to use the bundled server under the extension's `server/` folder. |

## Development (F5)

### Debug both sides at once (recommended)

Open `RtlEditor2.code-workspace` in VS Code and press `F5`, choosing
**Extension + Language Server**. This is a compound launch that starts:

1. **Launch: SystemVerilog Language Server (C#)** — the server under the C#
   debugger (breakpoints in the server work). It listens on
   `127.0.0.1:9250` (`--port 9250`).
2. **Run Extension** — the Extension Development Host (TS/JS side).

The two talk over TCP instead of stdio: the launch configuration sets
`SVLSP_SERVER_PORT=9250` in the extension host's environment, and
`extension.js` then **connects** to the already-running server instead of
spawning it. Without that variable the extension spawns the server as usual
(stdio), which is what the packaged `.vsix` does.

The same configurations (and the compound) are also defined in
`vscode-extension/.vscode/launch.json`, so opening the `vscode-extension`
folder directly and pressing `F5` works too. There, **Run Extension** spawns
the server as usual and **Run Extension (connect to C# debug server)** is the
TCP variant used by the compound.

Notes:

- The server is built first by the `build-server` task
  (`dotnet build SystemVerilogLanguageServer/SystemVerilogLanguageServer.csproj`).
- The extension retries the TCP connection for 30 seconds, so the launch order
  between the two configurations does not matter.
- `Developer: Reload Window` in the Extension Development Host reconnects to
  the same server (the server accepts connections in a loop).
- In a `.code-workspace` file the plain `${workspaceFolder}` variable cannot be
  resolved (a workspace may contain several folders), so the entries there use
  `${workspaceFolder:RtlEditor2}` and the folder is given an explicit `name`.
  If you rename the folder, update those variables too.
- To debug only the extension, run **Run Extension** (the non-TCP one); it
  spawns the server itself and needs no other configuration.

### Updating the bundled server

The extension spawns the copy under `server/`, so **any C# change needs that
folder rebuilt**. Use the batch file:

```bat
update-server.bat              :: empty server\, publish, prune, selftest
update-server.bat --check      :: just report the current size
update-server.bat --no-publish :: prune an existing publish without rebuilding
```

It does the three steps that must happen together, for the reason described
below:

1. **empty `server/`** — `dotnet publish -o` only adds and overwrites files, so
   a previous publish's leftovers stay forever,
2. **`dotnet publish`** (`-c Release -p:CopyOutputSymbolsToPublishDirectory=false`),
3. **prune** — remove `.playwright/`, `**/*.pdb` and the non-host
   `runtimes/<rid>` folders.

Then it prints the resulting file count and runs `--selftest`.

#### Linux bundle (`server-linux-x64/`)

A publish is bound to one RID: the managed DLLs, the `.deps.json` and the native
libraries differ per platform, so a Windows and a Linux bundle cannot share one
folder. `server/` stays the Windows bundle; the Linux one is built into
`server-linux-x64/` by **`update-server.sh`**:

```bash
./update-server.sh              # empty server-linux-x64/, publish, prune
./update-server.sh --check      # just report the current size
./update-server.sh --no-publish # prune an existing publish without rebuilding
```

It publishes with

```
dotnet publish SystemVerilogLanguageServer/SystemVerilogLanguageServer.csproj \
    -c Release -r linux-x64 --self-contained true -o RtlEditorVscodeExtension/server-linux-x64 \
    -p:DebugType=None -p:DebugSymbols=false -p:CopyOutputSymbolsToPublishDirectory=false
```

so the result runs on a Linux machine **without a .NET runtime installed**.

The compilation itself happens **on Windows**: `-r linux-x64` cross-compiles
from a Windows SDK, so run the script from Git Bash / MSYS2. It also works on a
Linux host, where the `--selftest` step is actually executed (on Windows the
ELF apphost cannot be run, so the script verifies the file magic is ELF
instead and prints the command to run later).

#### Running it from cmd / PowerShell

A `.sh` cannot be started meaningfully from cmd or PowerShell. Measured on a
machine with Git for Windows **and** WSL:

| Invocation | Result |
|---|---|
| `cmd /c update-server.sh --help` | exit 0, **no output at all** — `.sh` is associated with `git-bash.exe --no-cd`, so a detached Git Bash window opens and the exit code belongs to the launcher |
| `bash update-server.sh` (the `bash.exe` on PATH is WSL's `C:\windows\system32\bash.exe`) | runs, but `dotnet --version` there is **8.0.100** — it cannot build this `net10.0` project |
| `bash update-server.sh` (**Git for Windows** `C:\Program Files\Git\bin\bash.exe`) | works |

So use the wrapper, which finds Git for Windows' bash explicitly (never
`where bash`) and propagates the exit code:

```bat
update-server-linux.cmd              :: publish + prune
update-server-linux.cmd --check      :: report the current size
update-server-linux.cmd --no-publish :: prune an existing publish
```

`bash update-server.sh ...` from a Git Bash prompt works too.

`extension.js` looks in the folder matching `process.platform` first
(`server-linux-x64/` on Linux, `server/` elsewhere) and falls back to the other
one, so a checkout that only has the Windows bundle still starts.

> **Executable bit**: a RID-specific publish produces a native launcher, but the
> `+x` permission is a POSIX attribute that a Windows cross-publish cannot set
> and that zip / `.vsix` packaging does not preserve. `extension.js` sets it
> (`chmod +x`) before spawning the server on non-Windows hosts, so a bundle
> copied over from Windows works as-is.

> **Why the prune is mandatory**: the VS Code extension development host dies
> with **exit code 134** (SIGABRT) about a second after
> `Loading development extension`, with no `exthost` folder and no crash log,
> when `server/` is too large. That reads as "the extension failed to start".
> It happened at 322 files / 734.9 MB; a healthy framework-dependent folder is
> about **147 files / 100 MB**. Note that
> `-p:CopyOutputSymbolsToPublishDirectory=false` alone does **not** prevent
> this — publishing into an empty folder still produced 314 files / 733.9 MB
> (six `.pdb` plus the whole `.playwright` bundle), so the prune step is what
> keeps it small. An `AfterTargets="Publish"` MSBuild target was tried instead
> and does not work (`-o <relative dir>` makes the item globs resolve against
> the project directory), which is why this is a script.
>
> For the **self-contained** Linux bundle the file count is a bad criterion:
> the whole .NET runtime ships with it, so `server-linux-x64/` is
> **322 files / ~139 MB** when healthy — the same file count as the bloated
> folder above. Judge it by size, which is what `update-server.sh` does.

`npm run package` / `npm run vsix` runs `scripts/bundle-server.js`, which
performs the same three steps (plus the `.vsix` build).

### Spawning a published server

For development the extension also looks for a server published at
`SystemVerilogLanguageServer/publish/` (inside or next to the extension folder),
so you can run:

```bash
dotnet publish SystemVerilogLanguageServer/SystemVerilogLanguageServer.csproj -c Release -o SystemVerilogLanguageServer/publish
```

## License

MIT
