# loomark VS Code Extension (MVP)

> Open the current Markdown file in [loomark](https://loomark.com/) — the Markdown-as-Database editor with live file watching.

## What it does

Adds one command: **`loomark: Open Current Markdown in loomark`**.

loomark watches files **on disk**, not editor buffers. If the current document has unsaved
changes, this extension saves it first (`document.save()`), then launches loomark with the
file path, so loomark always shows up-to-date content.

## Install

1. Package the extension (from this directory):
   ```sh
   npm run package
   ```
   This produces `loomark-open-in-loomark-0.1.0.vsix` (no dependencies added — `vsce` runs via `npx`).

   Alternatively, build it with the VS Code CLI:
   ```sh
   npx @vscode/vsce package
   ```

2. In VS Code, open the **Extensions** view (`⇧⌘X` / `Ctrl+Shift+X`).

3. Click the **`...`** (More Actions) menu in the top-right of the Extensions view →
   **Install from VSIX...** → select the `.vsix` file.

4. The command is ready immediately. No reload needed for the command itself; reload the
   window if the right-click menu entry does not appear.

## Usage

- Right-click inside a Markdown editor → **loomark: Open Current Markdown in loomark**.
- Or open the Command Palette (`⇧⌘P` / `Ctrl+Shift+P`) with a Markdown editor active
  (the command only appears when the active editor language is `markdown`).

If the document has unsaved changes, VS Code prompts to save (for new/untitled documents)
or saves silently — only then is the file handed to loomark.

## Configuration

| Setting                    | Description |
|----------------------------|-------------|
| `loomark.executablePath`    | Optional. Path or name of the loomark executable. When empty, the platform default is used. |

Platform defaults:

| Platform | Launch command |
|----------|----------------|
| macOS    | `open -a loomark <file>` (loomark.app resolved via LaunchServices) |
| Linux    | `loomark <file>` (`loomark` must be on `PATH`) |
| Windows  | `loomark.exe <file>` (`loomark.exe` must be on `PATH`) |

Set `loomark.executablePath` when loomark is not on `PATH`, e.g.
`C:\Program Files\loomark\loomark.exe` on Windows or `/opt/loomark/loomark` on Linux.
If launching fails, VS Code shows the underlying error (e.g. app not found).

## Limitations (MVP)

- **Unsaved content must be written to disk first.** The extension auto-saves before
  opening — that is by design, since loomark syncs file changes, not editor buffers.
  If the save fails (e.g. dialog cancelled), the file is not opened.
- **No two-way live sync.** This is one-way: VS Code → loomark. Editing the same file in
  loomark while it is open in VS Code may trigger VS Code's "file changed on disk" prompt.
- **Files on disk only.** Documents that are not `file`-scheme (untitled, git, etc.)
  are rejected with a clear message — save them first.
- **Markdown editors only.** The command is only available when the active editor
  language is `markdown`.

## Development

Pure JavaScript, no build step, no dependencies. Check syntax with:

```sh
npm run check
```

## Packaging / Publishing

To publish to the VS Code Marketplace later:

1. Register a publisher at <https://marketplace.visualstudio.com/manage> and set the
   `publisher` field in `package.json` to it (currently `loomark`).
2. `npx @vscode/vsce login <publisher>`
3. `npm run package` — then upload the `.vsix` in the Marketplace management page,
   or `npx @vscode/vsce publish` to publish directly.
