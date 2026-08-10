# Drafts（草稿）

Quick-capture sticky notes for problems, ideas, and low-urgency todos. A draft is a
single text note with a creation timestamp; it can be converted into a live agent
session in any project in one click.

## Entry

A **sticky note** floats in the bottom-right corner of the window (draggable, position
persisted in localStorage) and is visible in every view — recording never replaces the
main content area, so an active conversation stays visible. **⌘⇧N** (macOS) /
**Ctrl+Shift+N** (Windows/Linux) toggles the note; Esc collapses it. Clicking the
collapsed note expands it.

**Drafts** in the sidebar footer (above Scheduled tasks) opens the full management page.

## Workflow

1. Expand the sticky note (click it or press the hotkey) and type in the input —
   **Enter to save, Shift+Enter for newline**.
2. The note shows the two most recent drafts as a preview; **View all** opens the
   management page (list, Run as task, Delete).
3. **Run as task** on the management page opens a project picker. Confirming creates a
   new agent session in that project and sends the draft text immediately — the app
   switches back to the conversation view and the draft is kept (delete it manually if
   no longer needed).
4. **Delete** asks for confirmation and removes the note.

## Architecture and storage

- Definitions: `~/.look/drafts.json` (or `$LOOK_HOME/drafts.json`). Writes use a
  unique per-process temp file plus atomic rename, and a cross-process file lock
  (same `FileTaskLock` primitive as the scheduler) so concurrent mutations from
  multiple Look instances merge instead of overwriting.
- `DraftStore` (`src/main/drafts/draft-store.ts`): small atomic JSON store following
  the `ScheduledTaskStore` pattern — mutations are serialized through a queue and
  awaited before the IPC returns; the file is re-read inside the queue so concurrent
  creates never lose drafts; `list()` reloads from disk each time so external writes
  are visible. Malformed JSON roots or invalid draft entries are dropped (never
  crash the list), and a failed write does not poison the queue for later mutations.
- Data shape: `{ id, text, createdAt, convertedSessionId? }`. Text is trimmed; empty
  text is rejected; length is capped at 4000 chars (`DRAFT_MAX_TEXT_LENGTH`).
  `convertedSessionId` is written after a successful conversion and powers the
  **View task** button.
- IPC: `draft:list` / `draft:create` / `draft:update` / `draft:delete` via
  `draftRouter` (`src/main/ipc/routers/draft-router.ts`). `draft:update` validates
  its patch at runtime (text string / nullable convertedSessionId).

## Renderer

- `DraftStickyNote` (`src/renderer/components/drafts/DraftStickyNote.tsx`) — floating
  sticky note: collapsed pill showing the latest draft, expandable editor with the
  three most recent drafts, drag with pointer capture, ⌘⇧N hotkey (window-level keydown
  capture; Mac uses `metaKey`, others `ctrlKey`), position persisted in localStorage.
- `DraftsPage` (`src/renderer/components/drafts/DraftsPage.tsx`) — full management page.
- `ConvertDraftDialog` — project picker; conversion runs create → send → mark in
  that order using the existing `handleCreateClick(projectId)` and
  `handleSendMessage(text)`. Partial failures are retryable: if sending or marking
  fails, retrying the **same project** finishes the existing session instead of
  creating a duplicate; only after a successful send is `convertedSessionId` set.
- Navigation: `navigateMainView` (`store/viewNavigation.ts`) keeps chat / drafts /
  scheduled / agent-square / settings mutually exclusive; `AppLayout` derives its
  `MainView` union from those atoms and mounts `DraftStickyNote` at the shell root
  so it stays visible across views.

## Design decisions

- The sticky note is deliberately **non-disruptive**: recording never switches the
  main view, so running sessions stay visible; management (delete/convert) lives on
  the drafts page opened from "View all". Position is clamped back into the viewport
  on resize / expand so the note can never be lost off-screen.
- Drafts are deliberately minimal: no categories, tags, search, or pagination. The
  note can be pinned (kept as a collapsed bar after minimizing) or unpinned (hidden
  when minimized, reachable from the top bar button).
- Conversion keeps the draft and records the created session id
  (`convertedSessionId`); the draft's button becomes **View task** afterwards.
- A standalone always-on-top sticky window (visible outside Look) is a future option;
  the MVP is an in-window note with an app-level hotkey.
