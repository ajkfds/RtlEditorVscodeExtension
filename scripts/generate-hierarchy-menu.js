'use strict';

// Rewrites the RTL Hierarchy menu blocks in package.json from the C# catalog.
//
// Why this exists: VS Code reads `contributes` once, when the extension loads,
// and has no API to add a context-menu row at run time. So a menu row written in
// C# only reaches the menu if package.json already declares it. The catalog
// (CoreBridge/HierarchyMenuCatalog.cs) is the single source of truth and this
// script asks the language server to splice the generated blocks into
// package.json.
//
// Before this script the manifest was printed and pasted in by hand, and a
// forgotten paste was invisible: the server was current while the menu silently
// kept showing the previous rows. That is exactly how "the Add entries are flat"
// and "the label reads Add > Folder" survived a release.
//
// Usage (from the extension folder or the repository root):
//   node scripts/generate-hierarchy-menu.js          # write package.json
//   node scripts/generate-hierarchy-menu.js --check  # fail if it is stale
//
// npm scripts: `npm run generate-menu` / `npm run check-menu`.

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

if (!fs.existsSync(manifestPath)) {
    fail('package.json was not found: ' + manifestPath);
}

// Prefer an existing build; fall back to building. The generator lives in the
// server assembly, so a stale build would write a stale menu - but the server is
// rebuilt as part of `npm run package` anyway, and `--check` is meant to be cheap
// enough to run on its own.
const candidates = [
    path.join(repoRoot, 'SystemVerilogLanguageServer', 'bin', 'Release', 'net10.0', 'SystemVerilogLanguageServer.dll'),
    path.join(repoRoot, 'SystemVerilogLanguageServer', 'bin', 'Debug', 'net10.0', 'SystemVerilogLanguageServer.dll'),
    path.join(extDir, 'server', 'SystemVerilogLanguageServer.dll'),
];

let serverDll = candidates.find((p) => fs.existsSync(p));
if (!serverDll) {
    console.log('no server build found; building once');
    const build = spawnSync(
        'dotnet',
        ['build', csproj, '-c', 'Debug', '-clp:ErrorsOnly'],
        { cwd: repoRoot, shell: true, stdio: 'inherit' }
    );
    if (build.status !== 0) {
        fail('could not build the language server',
            'Install the .NET 10 SDK and run this from the RtlEditor2 repository.');
    }
    serverDll = candidates[1];
    if (!fs.existsSync(serverDll)) fail('the server build did not produce ' + serverDll);
}

const mode = checkOnly ? '--check-hierarchy-menu-manifest' : '--write-hierarchy-menu-manifest';
console.log('menu manifest: ' + (checkOnly ? 'checking' : 'writing') + ' ' + path.relative(repoRoot, manifestPath));
console.log('  server: ' + path.relative(repoRoot, serverDll));

const result = spawnSync('dotnet', [serverDll, mode, manifestPath], {
    cwd: repoRoot,
    shell: true,
    stdio: 'inherit',
});

if (result.status !== 0) {
    if (checkOnly) {
        fail('package.json is out of date',
            'Run `npm run generate-menu` and commit the result.');
    }
    fail('the menu manifest could not be written');
}

if (checkOnly) {
    console.log('package.json is up to date');
} else {
    console.log('\nDone. Reload the VS Code window (or rebuild the .vsix) to pick up the new menu.');
}
