'use strict';

// Auto-connect form (RtlEditor2's AutoConnectWindow equivalent) shown as a
// webview panel.
//
// The desktop editor opens an Avalonia window listing every port of the
// instantiated module, showing for each port
//
//     .portName(<the signal that will be connected>)  -> <best candidate>
//
// and lets the user accept / reject each row with the keyboard only:
//
//     Up / Down   move the cursor
//     Left/Space  accept the row (connect the best candidate)
//     Right       reject the row (leave the port unconnected)
//     Enter       apply everything and close
//     Escape      cancel
//
// A headless LSP server cannot open that window, so the form is split in two:
//
//   - `rtl/autoConnect` returns the rows as data (port name, direction, port
//     group, current connection, candidate signals). The decision of *which
//     signal matches a port* lives in the server's UI-free
//     `CoreBridge.AutoConnectAdapter`, so the desktop editor and this view
//     share one implementation.
//   - `rtl/autoConnectApply` takes the chosen connections and returns the
//     replacement text for the instantiation as a TextEdit.
//
// This file is the renderer. It deliberately mirrors the desktop window: no
// combo boxes, no mouse-only affordances -- the row shows the current
// connection *and* the candidate, and the accept / reject buttons are just the
// mouse equivalent of Left/Space and Right. Per
// memory/vscode_extension_architecture.md the extension stays a pipe: it does
// not decide which signal matches a port, it only renders and forwards.

const vscode = require('vscode');

/**
 * One row of the form, as returned by `rtl/autoConnect`.
 * @typedef {{
 *   name: string, direction: string, portGroup: string|null,
 *   currentConnection: string|null, candidates: string[]
 * }} AutoConnectPort
 */

/**
 * The whole form, as returned by `rtl/autoConnect`.
 * @typedef {{
 *   moduleName: string, instanceName: string,
 *   ports: AutoConnectPort[], message: string|null
 * }} AutoConnectModel
 */

/**
 * Opens the auto-connect form for the instantiation at the caret.
 *
 * @param {object} deps
 * @param {() => Promise<any>} deps.ensureClient resolves the LSP client
 * @param {(msg: string) => void} deps.log log sink (OutputChannel)
 */
async function showAutoConnect(deps) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('SystemVerilog LSP: open a SystemVerilog file first.');
        return;
    }
    const doc = editor.document;
    if (doc.languageId !== 'systemverilog' && doc.languageId !== 'verilog') {
        vscode.window.showWarningMessage('SystemVerilog LSP: the active file is not SystemVerilog / Verilog.');
        return;
    }

    const position = { line: editor.selection.active.line, character: editor.selection.active.character };
    const params = { textDocument: { uri: doc.uri.toString() }, position };

    let model;
    try {
        const client = await deps.ensureClient();
        model = await client.request('rtl/autoConnect', params);
    } catch (e) {
        deps.log('rtl/autoConnect ERROR: ' + (e && e.stack ? e.stack : e));
        vscode.window.showErrorMessage('SystemVerilog LSP: auto-connect request failed (see the log).');
        return;
    }

    if (!model || !model.ports || model.ports.length === 0) {
        const message = (model && model.message) || 'no module instantiation at the caret';
        vscode.window.showInformationMessage('SystemVerilog LSP: ' + message);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'systemverilogLsp.autoConnect',
        `Auto Connect: ${model.instanceName || model.moduleName}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    const nonce = createNonce();
    panel.webview.html = buildHtml(model, nonce);

    panel.webview.onDidReceiveMessage(async (message) => {
        if (!message) return;

        if (message.type === 'cancel') {
            deps.log('auto-connect cancelled');
            panel.dispose();
            return;
        }
        if (message.type !== 'apply') return;

        const selections = message.selections || {};
        try {
            const client = await deps.ensureClient();
            const edits = await client.request('rtl/autoConnectApply', {
                textDocument: { uri: doc.uri.toString() },
                position,
                selections,
            });
            if (!edits || edits.length === 0) {
                vscode.window.showInformationMessage('SystemVerilog LSP: nothing to apply.');
                // The webview latches its Apply key so keyboard auto-repeat
                // cannot send the request twice; release it so the user can
                // try again instead of being left with a dead panel.
                panel.webview.postMessage({ type: 'applyFailed' });
                return;
            }
            const workspaceEdit = new vscode.WorkspaceEdit();
            for (const edit of edits) {
                workspaceEdit.replace(doc.uri, toRange(edit.range), edit.newText);
            }
            await vscode.workspace.applyEdit(workspaceEdit);
            deps.log('auto-connect applied: ' + Object.keys(selections).length + ' port(s)');
            panel.dispose();
        } catch (e) {
            deps.log('rtl/autoConnectApply ERROR: ' + (e && e.stack ? e.stack : e));
            vscode.window.showErrorMessage('SystemVerilog LSP: applying the connections failed (see the log).');
            panel.webview.postMessage({ type: 'applyFailed' });
        }
    });
}

/** Converts an LSP range to a vscode.Range. */
function toRange(range) {
    return new vscode.Range(
        range.start.line, range.start.character,
        range.end.line, range.end.character
    );
}

/** A random nonce for the webview CSP. */
function createNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

/**
 * Builds the webview HTML.
 *
 * The row list is rendered by the webview script from the model (embedded as
 * JSON) so accept / reject can repaint a row without a round trip to the
 * extension host. Only the static chrome is built here.
 *
 * @param {AutoConnectModel} model
 * @param {string} nonce
 */
function buildHtml(model, nonce) {
    // The model only carries identifiers, but escape `<` anyway so a port
    // group comment can never terminate the inline <script>.
    const modelJson = JSON.stringify({
        moduleName: model.moduleName || '',
        instanceName: model.instanceName || '',
        ports: (model.ports || []).map((port) => ({
            name: port.name,
            direction: port.direction || '',
            portGroup: port.portGroup || null,
            currentConnection: port.currentConnection || null,
            candidates: port.candidates || [],
        })),
    }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 8px;
    outline: none;
  }
  h2 {
    font-size: 1.1em;
    margin: 0 0 4px 0;
    font-family: var(--vscode-editor-font-family);
  }
  .sub { opacity: 0.7; margin-bottom: 10px; }
  .head, .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 6px;
    font-family: var(--vscode-editor-font-family);
    white-space: nowrap;
  }
  .head {
    opacity: 0.7;
    border-bottom: 1px solid var(--vscode-panel-border);
    padding-bottom: 4px;
    margin-bottom: 2px;
  }
  .group {
    opacity: 0.7;
    font-style: italic;
    padding: 8px 6px 2px 6px;
    font-family: var(--vscode-editor-font-family);
  }
  .marker { width: 1em; opacity: 0.5; }
  .dir    { min-width: 5em; opacity: 0.6; }
  .expr   { flex: 1 1 auto; }
  .arrow  { opacity: 0.6; }
  .state  { width: 1.4em; text-align: center; }
  .ops    { margin-left: auto; display: flex; gap: 4px; }
  .more   { opacity: 0.6; font-size: 0.85em; }
  .row.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
    box-shadow: inset 2px 0 0 var(--vscode-focusBorder);
  }
  .row.selected .marker { opacity: 1; }
  .row.accepted .state { color: var(--vscode-charts-green, #89d185); }
  .row.rejected .state { color: var(--vscode-charts-red, #f14c4c); }
  .row.kept .state, .row.empty .state { opacity: 0.5; }
  .row.rejected .expr, .row.empty .expr { opacity: 0.55; }
  button.op {
    font-size: 0.85em;
    line-height: 1.5;
    padding: 0 6px;
    border: 1px solid transparent;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
  }
  button.op:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .hint { margin-top: 12px; opacity: 0.7; }
  .buttons { margin-top: 10px; display: flex; gap: 8px; }
  button.main {
    border: none;
    padding: 6px 14px;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button.main.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.main:hover { opacity: 0.9; }
</style>
</head>
<body tabindex="0">
  <h2 id="title"></h2>
  <div class="sub" id="sub"></div>
  <div class="head">
    <span class="marker"></span>
    <span class="dir">Dir</span>
    <span class="expr">Connection (result) &rarr; candidate</span>
    <span class="state"></span>
    <span class="ops"></span>
  </div>
  <div id="rows"></div>
  <div class="hint" id="hint"></div>
  <div class="buttons">
    <button class="main" id="apply" tabindex="-1">Apply (Enter)</button>
    <button class="main secondary" id="cancel" tabindex="-1">Cancel (Esc)</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const MODEL = ${modelJson};

  const ports = MODEL.ports || [];

  // The signal each port will be connected to. Starts as the connection that
  // is already written in the instantiation, exactly like the desktop window
  // (its ConnectionItem.target is initialised from the current expression).
  const results = {};
  for (let i = 0; i < ports.length; i++) {
    results[ports[i].name] = ports[i].currentConnection || null;
  }

  let selected = 0;
  let applied = false;

  const STATE_ICON = {
    accepted: '\\u2713',   // picked a candidate that is not connected yet
    kept: '=',             // already connected, nothing to change
    rejected: '\\u2717',   // user rejected: the port stays unconnected
    empty: '\\u00b7'       // no connection and no candidate
  };

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // A row whose existing connection is an expression (a bit / part select such
  // as AAA[2:1], a concatenation, ~x, ...) must keep that text: the candidates
  // are whole signal names, so replacing the connection with candidates[0]
  // would silently drop the select. The server marks these rows with
  // keepsExistingConnection.
  function keepsExisting(port) {
    return port.keepsExistingConnection === true;
  }

  function stateOf(port) {
    const current = port.currentConnection || null;
    const result = results[port.name];
    if (result == null) return current ? 'rejected' : 'empty';
    if (current && result === current) return 'kept';
    return 'accepted';
  }

  function render() {
    const html = [];
    let lastGroup = null;

    for (let i = 0; i < ports.length; i++) {
      const port = ports[i];

      // Port groups (the editor's // @group annotations) become comment rows,
      // like the desktop window. They are not selectable: Up / Down always
      // lands on a port so Left / Right never hits a non-actionable row.
      if (port.portGroup && port.portGroup !== lastGroup) {
        lastGroup = port.portGroup;
        html.push('<div class="group">// ' + esc(port.portGroup) + '</div>');
      }

      const state = stateOf(port);
      const candidates = port.candidates || [];
      const best = candidates.length ? candidates[0] : '';
      const result = results[port.name] || '';

      // The row reads like the desktop window's ConnectionItem:
      //   .port( <the signal that will be written> )   -> <best candidate>
      // The arrow only appears when the candidate differs from the result, so
      // a settled row does not repeat the same name twice.
      //
      // Rows that keep an expression connection show the candidate as an
      // alternative without implying it will be applied: the arrow is replaced
      // by "kept" wording so the user can see the select survives.
      let expr = '.' + esc(port.name) + '(' + esc(result) + ')';
      if (keepsExisting(port) && result) {
        expr += ' <span class="kept-note">(kept as written)</span>';
      } else if (best && best !== result) {
        expr += ' <span class="arrow">&rarr;</span> ' + esc(best);
        if (candidates.length > 1) {
          expr += ' <span class="more">+' + (candidates.length - 1) + '</span>';
        }
      }

      const classes = ['row', state];
      if (i === selected) classes.push('selected');

      html.push(
        '<div class="' + classes.join(' ') + '" data-index="' + i + '">' +
          '<span class="marker">' + (i === selected ? '\\u25b6' : '') + '</span>' +
          '<span class="dir">' + esc(port.direction) + '</span>' +
          '<span class="expr">' + expr + '</span>' +
          '<span class="state">' + STATE_ICON[state] + '</span>' +
          '<span class="ops">' +
            '<button class="op accept" data-index="' + i + '" tabindex="-1" ' +
              'title="Accept (Left / Space)">&#10003;</button>' +
            '<button class="op reject" data-index="' + i + '" tabindex="-1" ' +
              'title="Reject (Right)">&#10007;</button>' +
          '</span>' +
        '</div>'
      );
    }

    document.getElementById('rows').innerHTML = html.join('');

    const active = document.querySelector('.row.selected');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  // Clamps at both ends (the desktop moveUpWard / moveDownWard do the same) and
  // does not repaint: the callers repaint once, so accepting on the last row
  // still shows the new state.
  function stepSelection(delta) {
    const next = selected + delta;
    if (next >= 0 && next < ports.length) selected = next;
  }

  function move(delta) {
    stepSelection(delta);
    render();
  }

  // Left / Space: connect the best candidate. With no candidate the row keeps
  // its current state (the desktop Accept() does the same).
  //
  // A row whose existing connection is an expression (AAA[2:1], {a, b}, ~x, ...)
  // keeps that text: the candidates are whole signal names, so "accept" on such
  // a row must not replace the select with the whole signal.
  function acceptRow(index, thenMoveDown) {
    const port = ports[index];
    if (!port) return;
    if (keepsExisting(port)) {
      results[port.name] = port.currentConnection || null;
      if (thenMoveDown) stepSelection(1);
      render();
      return;
    }
    const candidates = port.candidates || [];
    if (candidates.length) results[port.name] = candidates[0];
    if (thenMoveDown) stepSelection(1);
    render();
  }

  // Right: leave the port unconnected.
  function rejectRow(index, thenMoveDown) {
    const port = ports[index];
    if (!port) return;
    results[port.name] = null;
    if (thenMoveDown) stepSelection(1);
    render();
  }

  function apply() {
    // Every port is sent, so ports that were already connected keep their
    // signal and rejected ones are explicitly cleared (the desktop
    // Complete() writes every row too).
    // A repeated Enter (keyboard auto-repeat) must not apply twice: the panel
    // is disposed by the extension host once the edit lands.
    if (applied) return;
    applied = true;
    const selections = {};
    for (let i = 0; i < ports.length; i++) selections[ports[i].name] = results[ports[i].name];
    vscode.postMessage({ type: 'apply', selections: selections });
  }

  function cancel() {
    if (applied) return;
    applied = true;
    vscode.postMessage({ type: 'cancel' });
  }

  document.addEventListener('keydown', function (event) {
    switch (event.key) {
      case 'ArrowDown':
        move(1);
        break;
      case 'ArrowUp':
        move(-1);
        break;
      case 'ArrowLeft':
      case ' ':
      case 'Spacebar':
        acceptRow(selected, true);
        break;
      case 'ArrowRight':
        rejectRow(selected, true);
        break;
      case 'Enter':
        apply();
        break;
      case 'Escape':
        cancel();
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  // Mouse is only a fallback for the same two actions. mousedown is used (and
  // default prevented) so focus never leaves the body and the arrow keys keep
  // working after a click.
  document.getElementById('rows').addEventListener('mousedown', function (event) {
    event.preventDefault();
    const target = event.target;
    if (!target || !target.closest) return;

    const button = target.closest('button.op');
    if (button) {
      const index = parseInt(button.getAttribute('data-index'), 10);
      selected = index;
      if (button.classList.contains('accept')) acceptRow(index, false);
      else rejectRow(index, false);
      document.body.focus();
      return;
    }

    const row = target.closest('.row');
    if (row) {
      selected = parseInt(row.getAttribute('data-index'), 10);
      render();
      document.body.focus();
    }
  });

  document.getElementById('apply').addEventListener('click', function (event) {
    event.preventDefault();
    apply();
  });
  document.getElementById('cancel').addEventListener('click', function (event) {
    event.preventDefault();
    cancel();
  });

  // The host releases the Apply latch when the edit could not be produced, so
  // Enter works again instead of being swallowed.
  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message && message.type === 'applyFailed') applied = false;
  });

  document.getElementById('title').textContent = MODEL.moduleName + ' ' + MODEL.instanceName;
  document.getElementById('sub').textContent =
    'Accept the signal for each port, then Apply.';
  document.getElementById('hint').textContent =
    '\\u2191/\\u2193 move  \\u00b7  \\u2190 / Space accept  \\u00b7  ' +
    '\\u2192 reject  \\u00b7  Enter apply  \\u00b7  Esc cancel';

  render();
  document.body.focus();
</script>
</body>
</html>`;
}

module.exports = { showAutoConnect };
