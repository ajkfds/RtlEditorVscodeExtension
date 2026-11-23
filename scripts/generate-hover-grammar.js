'use strict';

// Rewrites the TextMate grammar that colours hover code blocks from the C# palette.
//
// Why this exists: a language server cannot colour a hover any other way. VS Code
// strips `style` / `class` from markdown (its sanitizer allow list holds only
// href/target/src/alt/title/for/name/role/tabindex/x-dispatch/required/checked/
// placeholder/type/start/width/height/align), so the only channel is a fenced
// code block that a TextMate grammar tokenises. The grammar must carry the
// parser's palette, otherwise the VS Code hover drifts from the editor's
// mouse-over hint - and a hand-maintained copy is exactly how the two would
// drift.
//
// The generator lives in C# (CoreBridge/HoverGrammar.cs) next to the palette and
// the keyword list, so both inputs stay in one place. This script only drives it.
//
// Usage (from the extension folder or the repository root):
//   node scripts/generate-hover-grammar.js          # write the grammar
//   node scripts/generate-hover-grammar.js --check  # fail if it is stale
//
// npm scripts: `npm run generate-hover-grammar` / `npm run check-hover-grammar`.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const extDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extDir, '..');
const csproj = path.join(repoRoot, 'SystemVerilogLanguageServer', 'SystemVerilogLanguageServer.csproj');
const grammarPath = path.join(extDir, 'syntaxes', 'systemverilog.tmLanguage.json');

const checkOnly = process.argv.slice(2).includes('--check');

function fail(message, hint) {
    console.error('\n[ERROR] ' + message);
    if (hint) console.error('        ' + hint);
    process.exit(1);
}

if (!fs.existsSync(path.join(extDir, 'package.json'))) {
    fail('package.json was not found: ' + path.join(extDir, 'package.json'));
}

// Prefer an existing build; fall back to building. The generator lives in the
// server assembly, so a stale build would write a stale grammar.
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

const mode = checkOnly ? '--check-hover-grammar' : '--write-hover-grammar';
console.log('hover grammar: ' + (checkOnly ? 'checking' : 'writing') + ' ' + path.relative(repoRoot, grammarPath));
console.log('  server: ' + path.relative(repoRoot, serverDll));

const result = spawnSync('dotnet', [serverDll, mode, extDir], {
    cwd: repoRoot,
    shell: true,
    stdio: 'inherit',
});

if (result.status !== 0) {
    if (checkOnly) {
        fail('the hover grammar is out of date',
            'Run `npm run generate-hover-grammar` and commit the result.');
    }
    fail('the hover grammar could not be written');
}

if (checkOnly) {
    console.log('the hover grammar is up to date');
} else {
    console.log('\nDone. Reload the VS Code window (or rebuild the .vsix) to pick up the new colours.');
}
