'use strict';

// RTL Hierarchy tree view (NavigatePanel equivalent).
//
// VS Code's built-in File Explorer cannot be extended with extra child nodes
// (there is no provider API for it), so the instance hierarchy is rendered in
// its own Custom Tree View placed inside the Explorer container.
//
// The top level is the WHOLE workspace (every .sv/.svh/.v/.vh file found under
// the workspace roots by the server), grouped into folders, not just the
// documents that happen to be open. The tree is lazy: one `rtl/hierarchy`
// request per expanded node, carrying the opaque `expandToken` the server
// issued for that node (no token = the workspace root), so the server never
// has to serialise the whole workspace hierarchy at once and the client never
// builds a path or an index itself.

const vscode = require('vscode');
const path = require('path');

// ---- native node menu ids (generated from the C# catalog) --------------
//
// The RTL Hierarchy context menu mixes two kinds of row:
//
//   * the ones this extension implements itself (Add Folder, Delete, ...),
//     declared by hand in package.json;
//   * the ones the language server defines (CoreBridge/HierarchyMenuCatalog),
//     declared in package.json too but generated from that catalog by
//     `HierarchyMenuManifest` so the C# side stays the single source of truth.
//
// VS Code has no API to add a view/item/context row at run time, so the second
// group is materialised into package.json and this file only registers an
// implementation per generated command id. That is why the two groups are
// indistinguishable in the menu: both are ordinary `contributes` rows.
//
// Regenerate after changing the catalog (this writes package.json in place -
// there is no manual copy step any more):
//   npm run generate-menu      # == dotnet ...dll --write-hierarchy-menu-manifest
//   npm run check-menu         # fails when package.json is stale
// HierarchyMenuManifestTests / HierarchyMenuManifestSyncTests fail when the two
// drift apart.
const GENERATED_COMMAND_PREFIX = 'systemverilogLsp.hierarchy.';

// Catalog entry ids that have a native row. Kept in the same order as the
// generated package.json rows; the test compares this list with the catalog.
const GENERATED_HIERARCHY_MENU_IDS = [
    'addBlankFile',
    'addFolder',
    'addSystemVerilogInterface',
    'addSystemVerilogModule',
    'addVerilogModule',
    'simulationSetup',
    'deleteNode',
    'openInExplorer',
    'copyInstancePath',
    'copyPath',
    'showProperty',
];

// ---- icons -------------------------------------------------------------
//
// The tree uses the plugin's own SVG assets (copied into icons/) so the view
// matches the desktop editor's NavigatePanel. Each icon ships in a light and a
// dark variant because one fill cannot read on both themes: the light variant
// uses a saturated colour, the dark variant the same hue lifted towards white.
//
// The editor tints its NavigatePanel icons per kind, so the tree colours them
// too instead of leaving every node a neutral grey:
//
//   folder                     #556992  (editor Global.Color_Folder)
//   project                    #925555  (editor Global.Color_Project)
//   module                     #4EC9B0  (teal, like a module declaration)
//   interface                  #569CD6  (blue, like the interface keyword)
//   package                    #C8A2E0  (violet)
//   header                     #D7BA7D  (gold, include header)
//   systemverilog-document     #3FA08F  (deep teal)
//   verilog-document           #4A8FC0  (deep blue)
//   verilog-header-document    #D7BA7D  (gold)
//
// The server sends a stable icon *name* ("folder" / "project" / "module" /
// "interface" / "package" / "header" / "systemverilog-document" /
// "verilog-document" / "verilog-header-document"); the client maps it onto the
// two files. An unknown name falls back to a codicon so a new server-side kind
// still renders something.
const ICON_NAMES = new Set([
    // a workspace directory (editor: FolderNode -> Assets/Icons/folder.svg)
    'folder',
    // a workspace root when several folders are open (editor: ProjectNode ->
    // Assets/Icons/home.svg, drawn in Color_Project)
    'project',
    'module',
    'interface',
    'package',
    'header',
    'systemverilog-document',
    'verilog-document',
    'verilog-header-document',
]);

// Badges the server can attach to a node (see HierarchyNode.Badge). The client
// ships `icons/<icon>-<badge>(-dark).svg` for each of these, with the overlay
// composited in (exclamation triangle bottom-left for error / warning, shine
// top-right for unsaved edits).
const BADGES = new Set(['error', 'warning', 'dirty']);

// Icons that ship `<icon>-<badge>` variants. Folder / project nodes never
// carry a badge (the editor's FolderNode / ProjectNode do not draw them), so
// they are excluded: asking for "folder-error.svg" would resolve to a missing
// file and VS Code would render no icon at all.
const NO_BADGE_ICONS = new Set(['folder', 'project']);
const BADGEABLE_ICONS = new Set(
    [...ICON_NAMES].filter((name) => !NO_BADGE_ICONS.has(name)));

// codicon fallbacks for names the client does not ship an SVG for
const ICON_FALLBACKS = {
    folder: 'folder',
    project: 'home',
    file: 'file',
    module: 'symbol-module',
    interface: 'symbol-interface',
    package: 'symbol-package',
    header: 'file-code',
    'systemverilog-document': 'file-code',
    'verilog-document': 'file-code',
    'verilog-header-document': 'file-code',
};

/**
 * Resolves a menu-row icon for a QuickPick.
 *
 * The server sends either an icon name that ships in `icons/`
 * ("verilog-document") or a codicon in "$(...)" form. The native
 * view/item/context menu cannot draw an icon at all, so the QuickPick is the
 * only place the extension can show one next to a node-menu row.
 *
 * @param {string|undefined} icon the server-provided icon
 * @param {vscode.Uri|undefined} extensionUri the extension root, for SVG paths
 * @returns {vscode.ThemeIcon|{light: vscode.Uri, dark: vscode.Uri}|undefined}
 */
function resolveMenuIcon(icon, extensionUri) {
    if (!icon) return undefined;

    // "$(trash)" -> ThemeIcon('trash')
    const codicon = /^\$\((.+)\)$/.exec(icon);
    if (codicon) return new vscode.ThemeIcon(codicon[1]);

    // a bare name we ship an SVG for -> light / dark pair
    if (ICON_NAMES.has(icon) && extensionUri) {
        return {
            light: vscode.Uri.joinPath(extensionUri, 'icons', icon + '.svg'),
            dark: vscode.Uri.joinPath(extensionUri, 'icons', icon + '-dark.svg'),
        };
    }

    // unknown name: fall back to a codicon rather than drawing nothing
    return new vscode.ThemeIcon(ICON_FALLBACKS[icon] || 'file');
}

/** One node of the RTL hierarchy tree. */
class HierarchyItem {
    constructor(options) {
        this.label = options.label;
        // 'folder' (workspace folder) | 'file' (workspace file)
        // | 'instance' (building block instance)
        this.kind = options.kind;
        this.uri = options.uri;
        this.detail = options.detail;
        this.startLine = options.startLine;
        this.startCharacter = options.startCharacter;
        this.hasChildren = options.hasChildren;
        // Opaque token the server issued for this node. The client stores it
        // and echoes it back verbatim to expand the node; it never parses it.
        this.expandToken = options.expandToken;
        // readable instance path, used by "Copy Instance Path"
        this.instancePath = options.instancePath;
        // instance path as name segments from the file root; echoed back in
        // rtl/reparse so the server parses the document AS this instance
        // (parameter overrides applied)
        this.instancePathSegments = options.instancePathSegments;
        // URI of the file the instantiation is written in (the parent). The
        // instance path is relative to it, and it is a different file from
        // `uri` (the instantiated module's source).
        this.parentUri = options.parentUri;
        // workspace-relative folder path (informational; expansion uses the token)
        this.folderPath = options.folderPath;
        // ---- presentation metadata, decided by the server ----
        // The client only maps these onto the VS Code TreeItem; it never
        // derives them from `kind` / `hasChildren` itself.
        this.icon = options.icon;
        // Badge composited onto the icon: "error" / "warning" (exclamation
        // triangle, bottom-left) or "dirty" (shine, top-right, unsaved edits).
        // The client resolves icons/<icon>-<badge>.svg, mirroring the editor's
        // NavigatePanel badges. VS Code's iconPath holds one icon and one theme
        // colour, so the overlay is baked into the asset rather than drawn.
        this.badge = options.badge;
        // optional VS Code theme colour id ("errorForeground" /
        // "editorWarning.foreground"), used only when no badge asset exists
        this.iconColor = options.iconColor;
        this.contextValue = options.contextValue;
        this.collapsible = options.collapsible;
        this.tooltip = options.tooltip;
        // absolute paths for the file operations (Add / Delete / Open in
        // Explorer), resolved by the server
        this.fsPath = options.fsPath;
        this.dirPath = options.dirPath;
    }
}

class HierarchyProvider {
    /**
     * @param {() => Promise<any>} ensureClient resolves the LSP client
     * @param {(msg: string) => void} [log] optional logger (OutputChannel)
     * @param {() => void} [revealLog] optional: reveal the log output channel
     * @param {vscode.Uri} [extensionUri] root of the extension (for icons/)
     */
    constructor(ensureClient, log, revealLog, extensionUri) {
        this.ensureClient = ensureClient;
        this.extensionUri = extensionUri;
        this.log = log || (() => {});
        this.revealLog = revealLog || (() => {});
        // set once we auto-revealed the log for an empty top level, so we do
        // not steal focus on every redraw
        this.revealedLogOnce = false;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.lastError = null;
        // set by refresh(): the next top-level fetch asks the server to
        // re-scan the workspace roots from disk (picking up files created or
        // deleted since initialize). Plain expands skip the rescan so the tree
        // does not enumerate the whole workspace on every render.
        this.pendingRescan = false;
        // The server pushes rtl/hierarchyInvalidated when the workspace root
        // becomes known (or files change), so the client no longer needs the
        // "retry after N seconds" / "latch once non-empty" timers that used to
        // live here: the redraw is driven by the server.
    }

    /**
     * Re-reads the whole workspace from disk (files created / deleted since the
     * last scan) and redraws the tree. Bound to the view's refresh button.
     */
    refresh() {
        this.lastError = null;
        this.pendingRescan = true;
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Redraws the tree without touching the disk, for events that only changed
     * the parse result of files already known to the server (e.g. didSave).
     */
    refreshTree() {
        this.lastError = null;
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Asks the server to re-parse the given file and then redraws the tree, so
     * clicking a hierarchy node updates the instance list even before the
     * client sends a didChange (an already-open, unedited file otherwise keeps
     * the parse result from when it was first opened).
     */
    async reparseAndRefresh(uri, instancePathSegments, parentUri) {
        try {
            const client = await this.ensureClient();
            if (client && uri) {
                // When the node is an instance, ask the server to parse the
                // document AS that instance: the parameter overrides written at
                // the instantiation are then applied, exactly like the editor
                // (which opens the instance, not the file). The instance path is
                // relative to the file the instantiation is written in
                // (parentUri), which is a different file from `uri` (the
                // instantiated module's source). Without the segments the
                // server does a plain file parse.
                const params = { uri };
                if (Array.isArray(instancePathSegments) && instancePathSegments.length > 0) {
                    params.instancePathSegments = instancePathSegments;
                    if (parentUri) params.parentUri = parentUri;
                }
                await client.request('rtl/reparse', params);
            }
        } catch (e) {
            this.log('reparse ERROR: ' + (e && e.stack ? e.stack : e));
        }
        this.refreshTree();
    }

    /**
     * Redraws the tree once the LSP session is ready.
     *
     * <p>
     * The view is created as soon as the extension activates, which can be
     * before the client has started: the first fetch then comes back empty.
     * The server also pushes <c>rtl/hierarchyInvalidated</c> when it infers a
     * workspace root, so this is only the "session just became ready" nudge.
     * </p>
     *
     * <p>
     * Deferred with setTimeout(0): this is called from inside the LSP
     * initialize promise chain, and getChildren awaits ensureClient() (the same
     * promise). Firing the tree change synchronously would make the re-fetch
     * wait on a promise that only resolves after the current callback returns.
     * </p>
     */
    refreshIfEmpty() {
        setTimeout(() => this.refresh(), 0);
    }

    /**
     * Maps a server descriptor onto a VS Code TreeItem.
     *
     * The server decides the icon, contextValue, collapsible state, tooltip and
     * the absolute paths; this method only translates them into the VS Code
     * types. The only client-side special case is the file icon: a real
     * `resourceUri` gives the proper file-type icon, which the server cannot
     * express as a ThemeIcon id.
     */
    getTreeItem(element) {
        const collapsible = element.collapsible === 'collapsed'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(element.label, collapsible);

        if (element.contextValue) item.contextValue = element.contextValue;
        if (element.tooltip) item.tooltip = element.tooltip;
        if (element.detail) item.description = element.detail;

        // The server decides the icon name, the badge (error / warning / dirty)
        // and (as a fallback) a theme colour id.
        const iconColor = element.iconColor
            ? new vscode.ThemeColor(element.iconColor)
            : undefined;

        const iconPath = this._resolveIconPath(element.icon, element.badge, iconColor);
        if (iconPath) item.iconPath = iconPath;

        // Default click action: open the node's own file. For an instance the
        // server sends the instantiated module's source as `uri` (matching the
        // editor's NavigatePanel), so clicking "AAA" under PartialAssign.sv
        // opens moduleSample.v, not PartialAssign.sv.
        if (element.kind === 'file') {
            item.command = {
                command: 'systemverilogLsp.openHierarchyNode',
                title: 'Open',
                arguments: [element],
            };
        } else if (element.kind === 'instance') {
            item.command = {
                command: 'systemverilogLsp.revealInEditor',
                title: 'Reveal in Editor',
                arguments: [element],
            };
        }
        return item;
    }

    /**
     * Maps the server's icon name + badge onto a VS Code icon.
     *
     * The plugin's own SVGs are shipped in icons/ (light + dark variants) so
     * the tree matches the desktop editor. A node the server flagged as error /
     * warning / dirty resolves `icons/<icon>-<badge>.svg`, which has the
     * NavigatePanel overlay (exclamation triangle bottom-left / shine top-right)
     * composited in - VS Code's iconPath cannot draw an overlay, so the badge is
     * part of the asset. `icons/<icon>.svg` is used when no badge applies.
     *
     * When the name has no shipped SVG (a kind added on the server later) a
     * codicon is used, which still carries the theme colour fallback.
     */
    _resolveIconPath(iconName, badge, iconColor) {
        if (iconName && ICON_NAMES.has(iconName) && this.extensionUri) {
            // Only icons that actually ship a badge variant may take one; a
            // missing file would leave the node without any icon.
            const decorated = badge && BADGES.has(badge) && BADGEABLE_ICONS.has(iconName)
                ? iconName + '-' + badge
                : iconName;
            return {
                light: vscode.Uri.joinPath(this.extensionUri, 'icons', decorated + '.svg'),
                dark: vscode.Uri.joinPath(this.extensionUri, 'icons', decorated + '-dark.svg'),
            };
        }
        const codicon = ICON_FALLBACKS[iconName] || iconName || 'file';
        return new vscode.ThemeIcon(codicon, iconColor);
    }

    async getChildren(element) {
        try {
            this.log('getChildren: ' + (element === undefined ? '<root>' : element.kind + ':' + element.label));
            const client = await this.ensureClient();
            if (!client) {
                this.log('getChildren: no client');
                return [];
            }

            if (element === undefined) {
                // top level: the whole workspace (folder tree + files). No
                // expandToken means "the workspace root".
                const params = {};
                // A window that has no folder open ("File > Open File") sends no
                // workspace root at initialize, so the server cannot scan the
                // project. Ask for a rescan on the first render: the server then
                // infers the root from the opened document instead of showing
                // only that one file. Once the root is known the server pushes
                // rtl/hierarchyInvalidated, so no client-side retry timer is
                // needed here.
                const noFolderOpen = !(vscode.workspace.workspaceFolders || []).length;
                if (this.pendingRescan || noFolderOpen) {
                    params.rescan = true;
                    this.pendingRescan = false;
                }
                const result = await client.request('rtl/hierarchy', params);
                const items = this._toItems(result);
                this.log('hierarchy top level: ' + items.length + ' node(s)'
                    + (params.rescan ? ' (rescan)' : ''));
                if (items.length === 0) {
                    // Never leave the view silently blank: surface the reason
                    // as a single diagnostic node, and reveal the log once so
                    // the user can see what the server actually did.
                    if (!this.revealedLogOnce) {
                        this.revealedLogOnce = true;
                        this.revealLog();
                    }
                    return [new HierarchyItem({
                        label: 'No SystemVerilog files found (click refresh)',
                        kind: 'info',
                        detail: 'The server returned an empty workspace tree. '
                            + 'Open a folder containing .sv/.svh/.v/.vh files, '
                            + 'or press the refresh button in the view title.',
                        hasChildren: false,
                        icon: 'warning',
                        contextValue: 'rtlInfo',
                        collapsible: 'none',
                        tooltip: 'The server returned an empty workspace tree.',
                    })];
                }
                return items;
            }

            if (!element.hasChildren) return [];
            if (!element.expandToken) {
                // a leaf, or a node the server did not mark expandable
                return [];
            }

            // The server issued an opaque token for this node: echo it back
            // verbatim. The client never builds a path or an index itself.
            const result = await client.request('rtl/hierarchy', {
                expandToken: element.expandToken,
            });
            return this._toItems(result);
        } catch (err) {
            this.lastError = err;
            this.log('getChildren ERROR: ' + (err && err.stack ? err.stack : err));
            throw err;
        }
    }

    /**
     * Maps the server's node descriptors onto HierarchyItems.
     *
     * Everything the tree needs (label, icon, contextValue, collapsible state,
     * tooltip, instance path, absolute paths, expand token) comes from the
     * server, so this is a straight field copy: no path building, no index
     * bookkeeping.
     */
    _toItems(result) {
        const nodes = (result && result.nodes) || [];
        return nodes.map((node) => new HierarchyItem({
            label: node.label || '',
            kind: node.kind || 'instance',
            uri: node.uri,
            detail: node.detail,
            startLine: node.startLine,
            startCharacter: node.startCharacter,
            hasChildren: !!node.hasChildren,
            expandToken: node.expandToken,
            instancePath: node.instancePath,
            instancePathSegments: node.instancePathSegments,
            parentUri: node.parentUri,
            folderPath: node.folderPath,
            icon: node.icon,
            badge: node.badge,
            iconColor: node.iconColor,
            contextValue: node.contextValue,
            collapsible: node.collapsible,
            tooltip: node.tooltip,
            fsPath: node.fsPath,
            dirPath: node.dirPath,
        }));
    }
}

/**
 * Registers the tree view plus its commands.
 * @param {vscode.ExtensionContext} context
 * @param {() => Promise<any>} ensureClient
 * @param {(msg: string) => void} [log] optional logger (OutputChannel)
 */
function registerHierarchy(context, ensureClient, log, revealLog) {
    const provider = new HierarchyProvider(ensureClient, log, revealLog, context.extensionUri);
    const view = vscode.window.createTreeView('systemverilogLsp.hierarchy', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    context.subscriptions.push(view);
    context.subscriptions.push(provider._onDidChangeTreeData);

    // Clicking a node must BOTH switch the editor to the node's declaration and
    // re-parse its file (so the hierarchy and its errors are fresh).
    //
    // Relying on TreeItem.command alone does not work for expandable nodes:
    // VS Code toggles their expansion on click and does NOT run the command.
    // Module instances are exactly that case (they have children), so clicking
    // one only expanded it and the editor never switched. Selection changes on
    // every click, so drive both actions here.
    //
    // `revealing` guards against re-entrancy: reparseAndRefresh() ends with
    // refreshTree(), which can change the selection again and would otherwise
    // bounce between "open" and "refresh" forever.
    let revealing = false;
    context.subscriptions.push(view.onDidChangeSelection(async (e) => {
        const node = e.selection && e.selection.length > 0 ? e.selection[0] : null;
        if (!node || !node.uri) return;
        if (revealing) return;
        revealing = true;
        try {
            // Log the exact target. `uri` is the file the node OPENS: for an
            // instance that is the instantiated module's own source (the
            // editor's NavigatePanel opens the instance's source too), and
            // `startLine` / `startCharacter` point at the module declaration
            // there. `fsPath` is the same file as an absolute path. If the
            // editor opens the wrong file, this line shows which uri the
            // client actually used.
            provider.log('selection: ' + node.kind + ' ' + node.label
                + ' -> uri=' + node.uri
                + ' line=' + node.startLine + ' char=' + node.startCharacter
                + ' (fsPath=' + node.fsPath + ')');
            await openAt(node.uri, node.startLine, node.startCharacter, provider.log);
            await provider.reparseAndRefresh(node.uri, node.instancePathSegments, node.parentUri);
        } catch (err) {
            provider.log('selection reveal/reparse ERROR: ' + (err && err.message));
        } finally {
            revealing = false;
        }
    }));
    // The view title shows "No ... files" (viewsWelcome) only when the provider
    // returns nothing; keep the message visible by revealing the view itself.
    try { view.badge = undefined; } catch (e) { /* ignore */ }

    context.subscriptions.push(
        vscode.commands.registerCommand('systemverilogLsp.refreshHierarchy', () => provider.refresh())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('systemverilogLsp.openHierarchyNode', async (item) => {
            const node = item || view.selection[0];
            if (!node || !node.uri) return;
            await openAt(node.uri, node.startLine, node.startCharacter, provider.log);
            await provider.reparseAndRefresh(node.uri, node.instancePathSegments, node.parentUri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('systemverilogLsp.revealInEditor', async (item) => {
            const node = item || view.selection[0];
            if (!node || !node.uri) return;
            await openAt(node.uri, node.startLine, node.startCharacter, provider.log);
            await provider.reparseAndRefresh(node.uri, node.instancePathSegments, node.parentUri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('systemverilogLsp.copyHierarchyPath', async (item) => {
            const node = item || view.selection[0];
            if (!node || !node.instancePath) return;
            await vscode.env.clipboard.writeText(node.instancePath);
            vscode.window.setStatusBarMessage('Copied: ' + node.instancePath, 3000);
        })
    );

    // ---- file system operations (performed for the C# catalog) --------------
    //
    // Every row in the node menu - including Add / Delete / Open / Copy Path -
    // is declared in the plugin's CoreBridge.HierarchyMenuCatalog. The catalog
    // decides what to do and returns a ClientOperation ({ kind, path, content });
    // this function performs it. The split matters: the decision and the path
    // stay in C#, while the actual I/O goes through vscode.workspace.fs so
    // remote and virtual file systems keep working (the language server must not
    // write files behind VS Code's back).
    //
    // Do not re-implement a menu action here: add the row to the catalog.

    /**
     * Performs the file-system operation the server returned.
     * @param {{kind: string, path?: string, content?: string, recursive?: boolean}} operation
     * @returns {Promise<boolean>} true when the tree should be refreshed
     */
    async function executeClientOperation(operation) {
        if (!operation || !operation.path) return false;

        switch (operation.kind) {
            case 'createFolder':
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(operation.path));
                return true;

            case 'createFile': {
                const uri = vscode.Uri.file(operation.path);
                const content = operation.content || '';
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                // Open the new file so the user can start editing it (the editor
                // opens a newly created module too).
                if (content) await openAt(uri.toString(), 0, 0);
                return true;
            }

            case 'delete':
                await vscode.workspace.fs.delete(
                    vscode.Uri.file(operation.path), { recursive: true, useTrash: true });
                return true;

            case 'reveal':
                await vscode.commands.executeCommand(
                    'revealFileInOS', vscode.Uri.file(operation.path));
                return false;

            default:
                provider.log('unknown menu operation: ' + operation.kind);
                return false;
        }
    }

    // ---- C#-driven node menu ------------------------------------------
    //
    // VS Code's view/item/context menu is declared statically in package.json,
    // so a menu row written in C# could never appear unless this file also knew
    // about it. The catalog is the single source of truth and
    // CoreBridge/HierarchyMenuManifest renders it into package.json, so the
    // rows are ordinary `contributes` entries - indistinguishable from the ones
    // this extension used to declare by hand, which is why there are none left.
    //
    // Each generated command id forwards to rtl/hierarchyMenuInvoke; the server
    // answers with a ClientOperation that executeClientOperation performs.
    // "Show Menu..." remains as the fallback that lists rows registered at run
    // time (those never reach package.json).

    /**
     * Shows the C#-defined menu for a hierarchy node and runs the picked entry.
     * @param {any} item the tree item (or the current selection)
     */
    async function showNodeMenu(item) {
        const node = item || view.selection[0];
        if (!node) return;

        let result;
        try {
            const client = await provider.ensureClient();
            if (!client) return;
            result = await client.request('rtl/hierarchyMenu', {
                kind: node.kind,
                uri: node.uri,
                label: node.label,
                instancePath: node.instancePath,
                fsPath: node.fsPath,
            });
        } catch (e) {
            provider.log('rtl/hierarchyMenu ERROR: ' + (e && e.stack ? e.stack : e));
            vscode.window.showErrorMessage('SystemVerilog LSP: the node menu request failed (see the log).');
            return;
        }

        if (!result || !result.entries || result.entries.length === 0) {
            vscode.window.showInformationMessage(
                'SystemVerilog LSP: ' + ((result && result.message) || 'no menu for this node'));
            return;
        }

        // A QuickPick cannot render a disabled row, so the reason is appended to
        // the description and picking the row only reports it.
        //
        // The icon is the only place the extension can draw one for a node-menu
        // row: VS Code's view/item/context menu has no icon property, so the
        // native rows are text only. `entry.icon` is an icon name under icons/
        // or a "$(codicon)" string; resolveIcon handles both.
        const picks = result.entries.map((entry) => ({
            label: entry.label,
            description: entry.enabled ? (entry.detail || '') : (entry.reason || 'unavailable'),
            iconPath: resolveMenuIcon(entry.icon, provider.extensionUri),
            entry,
        }));

        const picked = await vscode.window.showQuickPick(picks, {
            placeHolder: 'RTL Hierarchy: ' + (node.instancePath || node.label),
            matchOnDescription: true,
        });
        if (!picked) return;
        if (!picked.entry.enabled) {
            vscode.window.showInformationMessage(
                'SystemVerilog LSP: ' + (picked.entry.reason || 'this entry is not available here'));
            return;
        }

        await runNodeMenuEntry(node, picked.entry.id);
    }

    /**
     * Runs one menu entry through the server and performs the mechanical part
     * (show text / reveal a file / copy to the clipboard).
     */
    async function runNodeMenuEntry(node, id) {
        if (!node) return;

        let result = await invokeNodeMenuEntry(node, id, undefined);

        // A row that needs a name (new folder / file / module) answers with a
        // prompt; ask for it and run the same entry again with the answer. This
        // mirrors the editor, where the row opens an input window.
        if (result && result.prompt) {
            const input = await vscode.window.showInputBox({ prompt: result.prompt });
            if (!input || !input.trim()) return;
            result = await invokeNodeMenuEntry(node, id, input.trim());
        }

        if (!result) return;
        if (result.message) {
            vscode.window.showInformationMessage('SystemVerilog LSP: ' + result.message);
            return;
        }
        if (result.clipboardText) {
            await vscode.env.clipboard.writeText(result.clipboardText);
            vscode.window.setStatusBarMessage('Copied: ' + result.clipboardText, 3000);
            return;
        }
        if (result.operation) {
            // Confirm a delete the same way the editor asks before removing a
            // file (the server already decided the path and whether it recurses).
            if (result.operation.kind === 'delete') {
                const name = require('path').basename(result.operation.path);
                const ok = await vscode.window.showWarningMessage(
                    'Delete ' + name + '?', { modal: true }, 'Delete');
                if (ok !== 'Delete') return;
            }
            const refresh = await executeClientOperation(result.operation);
            if (refresh) provider.refresh();
            return;
        }
        if (result.text) {
            // The server already formatted the text; show it verbatim. A modal
            // dialog keeps the multi-line list readable (a notification message
            // collapses newlines).
            const doc = await vscode.workspace.openTextDocument({
                content: result.text,
                language: 'plaintext',
            });
            await vscode.window.showTextDocument(doc, { preview: true });
            provider.log('node menu: ' + result.title + '\n' + result.text);
        }
    }

    /**
     * Asks the server to run one catalog row for a node.
     * @param {any} node the tree item
     * @param {string} id the catalog entry id
     * @param {string|undefined} argument the value the user typed, when the row prompted
     */
    async function invokeNodeMenuEntry(node, id, argument) {
        try {
            const client = await provider.ensureClient();
            if (!client) return undefined;
            return await client.request('rtl/hierarchyMenuInvoke', {
                id,
                kind: node.kind,
                uri: node.uri,
                label: node.label,
                instancePath: node.instancePath,
                fsPath: node.fsPath,
                relativePath: node.detail,
                argument,
            });
        } catch (e) {
            provider.log('rtl/hierarchyMenuInvoke ERROR: ' + (e && e.stack ? e.stack : e));
            vscode.window.showErrorMessage('SystemVerilog LSP: the menu action failed (see the log).');
            return undefined;
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('systemverilogLsp.showNodeMenu', showNodeMenu)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('systemverilogLsp.runNodeMenuEntry',
            (item, id) => runNodeMenuEntry(item || view.selection[0], id))
    );

    // ---- native menu rows generated from the C# catalog ----------------
    //
    // VS Code reads view/item/context rows from package.json when the extension
    // loads and has no API to add one at run time, so the rows themselves are
    // generated by the plugin (CoreBridge/HierarchyMenuManifest) and committed
    // into package.json. Each generated command id is
    // `systemverilogLsp.hierarchy.<catalog id>`, and every one of them only has
    // to forward to the server - exactly like the static rows the extension
    // implements itself, which is why the two are indistinguishable in the
    // context menu.
    //
    // The ids are listed in package.json under `contributes.commands`; the
    // extension registers an implementation for each so VS Code does not report
    // "command not found". The list is kept in sync by
    // SystemVerilogLanguageServer.Tests/HierarchyMenuManifestTests.
    for (const entryId of GENERATED_HIERARCHY_MENU_IDS) {
        context.subscriptions.push(
            vscode.commands.registerCommand(GENERATED_COMMAND_PREFIX + entryId,
                (item) => runNodeMenuEntry(item || view.selection[0], entryId))
        );
    }

    return provider;
}

/**
 * Opens the given file and reveals the given 0-based line/character.
 * Falls back gracefully when the position is unknown.
 */
async function openAt(uriString, line, character, log) {
    const uri = vscode.Uri.parse(uriString);
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        if (typeof line === 'number' && line >= 0) {
            const pos = new vscode.Position(line, typeof character === 'number' ? character : 0);
            const range = new vscode.Range(pos, pos);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        if (log) log('openAt: opened ' + doc.uri.toString() + ' at ' + line + ':' + character);
    } catch (err) {
        vscode.window.showErrorMessage('Could not open ' + uriString + ': ' + err.message);
    }
}

module.exports = { registerHierarchy, HierarchyProvider, HierarchyItem };
