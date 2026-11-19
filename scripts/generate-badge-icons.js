#!/usr/bin/env node
/*
 * Composites the NavigatePanel-style node badges into the tree icons.
 *
 * The desktop editor (VerilogFileNode.GetIcon) draws two overlays on top of the
 * file icon:
 *   - an exclamation triangle at the BOTTOM-LEFT when the parsed document has
 *     errors (red) or warnings (orange);
 *   - a shine at the TOP-RIGHT when the document has unsaved edits.
 *
 * VS Code's `TreeItem.iconPath` can only carry ONE icon and one theme colour,
 * so an overlay cannot be drawn by the client. Instead the overlay is baked
 * into the SVG: every base icon gets one file per badge
 * (`<icon>-<badge>.svg` / `<icon>-<badge>-dark.svg`).
 *
 * THIS SCRIPT IS A THIN WRAPPER. The generator lives in C#
 * (CoreBridge/BadgeIconGenerator.cs) so it runs in the same command that writes
 * package.json:
 *
 *   dotnet SystemVerilogLanguageServer.dll \
 *       --write-hierarchy-menu-manifest RtlEditorVscodeExtension/package.json
 *
 * Keeping one implementation is deliberate: the previous duplicate drifted
 * (the C# copy wrote LF where the committed assets are CRLF, a 42-file diff).
 * The wrapper stays so the documented
 * `node scripts/generate-badge-icons.js` keeps working.
 *
 * Usage:  node scripts/generate-badge-icons.js [--check]
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const extDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extDir, '..');
const manifestPath = path.join(extDir, 'package.json');
const csproj = path.join(repoRoot, 'SystemVerilogLanguageServer', 'SystemVerilogLanguageServer.csproj');

const checkOnly = process.argv.slice(2).includes('--check');

function fail(message, hint) {
    console.error('\n[ERROR] ' + message);
    if (hint) console.error('        ' + hint);
    process.exit(1);
}

if (!fs.existsSync(manifestPath)) fail('package.json was not found: ' + manifestPath);

const candidates = [
    path.join(repoRoot, 'SystemVerilogLanguageServer', 'bin', 'Release', 'net10.0', 'SystemVerilogLanguageServer.dll'),
    path.join(repoRoot, 'SystemVerilogLanguageServer', 'bin', 'Debug', 'net10.0', 'SystemVerilogLanguageServer.dll'),
];

let serverDll = candidates.find((p) => fs.existsSync(p));
if (!serverDll) {
    console.log('no server build found; building once');
    const build = spawnSync('dotnet', ['build', csproj, '-c', 'Debug', '-clp:ErrorsOnly'],
        { cwd: repoRoot, shell: true, stdio: 'inherit' });
    if (build.status !== 0) fail('could not build the language server');
    serverDll = candidates[1];
    if (!fs.existsSync(serverDll)) fail('the server build did not produce ' + serverDll);
}

// The manifest writer regenerates the icons as part of its work, so this wrapper
// only has to invoke it with the right mode.
const mode = checkOnly ? '--check-hierarchy-menu-manifest' : '--write-hierarchy-menu-manifest';
const result = spawnSync('dotnet', [serverDll, mode, manifestPath], {
    cwd: repoRoot,
    shell: true,
    stdio: 'inherit',
});

if (result.status !== 0) {
    if (checkOnly) fail('icons (or package.json) are out of date',
        'Run `npm run generate-menu` and commit the result.');
    fail('the icons could not be generated');
}
