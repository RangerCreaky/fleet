# Fleet

A **productivity sidebar note-taking app for macOS** built with Electron. Fleet lives on the right edge of your screen: a slim strip you can expand into a full panel for folders, Markdown notes, quick capture, and Jira work—without leaving your current window.

---

## Requirements

- **macOS** (primary target; builds use `electron-builder` with a Mac `.dmg` target)
- **Node.js** (LTS recommended) for development and packaging

---

## Installation & running

### From source (development)

1. Clone the repository and open the project folder.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the app:

   ```bash
   npm start
   ```

   For development with DevTools detached:

   ```bash
   npm run dev
   ```

### Building a distributable (macOS)

```bash
npm run dist
```

This runs `electron-builder` and produces a Mac installer (see `package.json` → `build` for app ID and DMG settings).

---

## How to use Fleet

### Show and hide the sidebar

- **Collapsed:** A narrow strip appears on the **right edge** of the screen. **Click** it to **expand** the panel.
- **Expanded:** Use **Collapse** in the header to slide the panel back to the thin strip.

The window stays **always on top** and is visible across **workspaces** (including over full-screen apps where supported), so notes stay one glance away.

### Folders and notes

1. On the home view, use **Add folder** to create a folder (you can rename it inline after creation).
2. Open a folder to see its **notes**.
3. Use **Add note** to create a note. New notes open in **edit mode** automatically.
4. **Folder options** (⋯ on a folder): rename or delete (deleting a folder removes all notes inside).

### Writing and Markdown

- Notes support **Markdown** with **GFM-style** features (e.g. task lists `- [ ]` / `- [x]`).
- **Click** the preview to **edit**; click outside the editor (or blur) to return to **preview**.
- In preview, **click checkboxes** in task lists to toggle them without entering edit mode.
- **Aa (Formatting):** insert bold, italic, code, lists, todos, links, images, etc. (works on selection or at the cursor).
- **Keyboard shortcuts** (while editing, with **⌘** on Mac or **Ctrl** where noted):

  | Shortcut        | Action        |
  |----------------|---------------|
  | ⌘B             | Bold          |
  | ⌘I             | Italic        |
  | ⌘K             | Link          |
  | ⌘E             | Code          |
  | ⌘⇧T            | Todo list     |
  | ⌘⇧I            | Image         |
  | ⌘⇧H            | Heading       |
  | ⌘⇧'            | Quote         |
  | ⌘⇧M            | Highlight     |
  | ⌘⇧X            | Strikethrough |
  | ⌘⇧L / ⌘⇧O      | Bullet / ordered list |

- **Global (app):** **⌘F** opens search and focuses the field; **⌘N** adds a note when you are inside a folder’s note list; **Escape** closes search or dismisses overlays where applicable.

### Organizing and finding

- **Search** (magnifier): filter **folder names** and **note contents** on the folder list; inside a folder, filter **note contents**.
- **Pin** a note from the header pin control.
- **Favourite** a note from the header star control; use the **Favourites** view to see favourites across folders.
- Deleted folders and notes move to **Trash** and can be restored for 30 days; the last deletion also has an immediate Undo action.
- **Drag** the handle on the left of a note card to **reorder** notes.
- **Resize** the panel by dragging the **left edge** of the expanded window (width is remembered).

### Per-note tools

- **Upload:** import an image into Fleet’s managed assets directory and insert a portable Markdown asset URL.
- **Drag-and-drop:** drop **images** onto a note to insert image Markdown (you may be switched to edit mode first).
- **Download:** save the note as a portable **`.md`** file with adjacent managed assets.
- **Copy:** copy raw **Markdown** to the clipboard.
- **Settings (gear):** adjust **font size** and **color tag** for that note.
- **Backup and diagnostics:** Settings can export a complete portable backup or local diagnostics bundle.

### Links

- **http/https** links in Markdown preview open in your **default browser** (in-app navigation is blocked).

### Jira Cloud Space

Fleet includes a separate Jira Space behind the Jira icon in the header. This build connects directly to Jira Cloud and does not require a Fleet server. Enter the Jira site URL, the email address on the Atlassian account, and an Atlassian API token. Create or revoke tokens at [Atlassian account API tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Both scoped and unscoped account tokens are detected automatically; Jira account passwords are not supported.

The credential is encrypted with Electron `safeStorage` in a separate `jira-credentials.bin` file. It is never written to `fleet-data.json` or included in Fleet backups. The renderer still has `connect-src 'none'`; Jira requests travel through narrow Electron IPC handlers to the Electron main process.

After connecting, Fleet can browse assigned active-sprint work, inspect issue metadata and subtasks, edit fields Jira reports as editable, manage permitted comments, and run available workflow transitions. Jira remains the source of truth: issue content is not copied into local folders or available for offline editing. Company administrators can disable API-token access, so this local connection mode is intended for personal or controlled internal use rather than a publicly distributed integration.

### Data storage

- Your data is stored locally in the app’s user data directory as **`fleet-data.json`** (folders, notes, and settings such as panel width). Existing SideNote installations are migrated automatically while retaining their prior Application Support directory so notes, attachments, and encrypted Jira credentials remain available.

---

## Benefits

- **Low context switching:** Notes sit beside your work instead of hiding behind another full app window.
- **Fast capture:** Expand, jot in Markdown, collapse—ideal for todos, snippets, and meeting notes.
- **Structured but lightweight:** Folders keep projects separate; pinning and reordering handle priority without a heavy database UI.
- **Portable text:** Markdown, export to `.md`, and clipboard copy keep your notes usable anywhere.
- **Privacy-first by default:** Local JSON storage; no account or cloud required to use the app.

---

## License

Fleet is proprietary software. See [LICENSE](LICENSE) and [EULA.md](EULA.md)
for the commercial terms.
