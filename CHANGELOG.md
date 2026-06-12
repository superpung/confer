# Changelog

All notable changes to **confer** are recorded here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries are user-facing; implementation details belong in commit messages.

---

## [Unreleased]

### Added
- Per-paper **reading status**: 4-state cycle on the card — None → To read →
  Reading → Done; filter the list to any status from the controls bar
  (`?status=toread` / `?status=reading` / `?status=done`). Status is synced to
  GitHub Gist. Rapid multi-paper toggles coalesce into a single sync push.
- **Card action layout**: status / note / bookmark sit in a horizontal icon row
  at the top-right of each card, eliminating the old vertical overlap with the
  "open program page" link at the bottom-right.
- Per-paper **private notes**: dedicated preview/edit dialog — shows note in
  read-only preview mode when a note exists; drops straight into edit mode for
  new notes. Includes Edit, Delete, Save, and Cancel actions. Notes synced to
  GitHub Gist across devices.
- **"Noted" filter**: a "Noted" toggle in the controls bar filters the list to
  only papers with notes (`?notes=1`); a removable active-filter chip appears
  in the filter bar.
- Reading progress stats in the Insights rail show reading / done counts.
- **"Find similar"** per paper: icon button in the expanded abstract opens a
  global corpus search (all venues loaded on demand) with results grouped by
  venue and sortable by similarity / year / title.
- **"For you" recommendations**: toolbar button loads papers from the full corpus
  and recommends them based on the user's saved / tagged / noted / status-marked
  papers, grouped by venue with venue filter and sort controls.
- Latest AI/ML, NLP, and NDSS paper datasets are now included in the site.
- Theme auto mode: toggle now cycles light → dark → auto; auto follows the OS
  `prefers-color-scheme` live (page reacts immediately when the OS switches).
- Per-year official-site link in the sidebar: each venue edition shows an
  external-link icon on hover that opens its conference homepage in a new tab.
- ⌘S / Ctrl+S "Sync now" shortcut listed in the help/shortcuts panel.
- Sync retry with exponential backoff (30s → 1m → 2m → 5m) after a failed
  silent auto-push; retries clear automatically on success or sign-out.
- Cross-tab config sync: editing settings in one browser tab is immediately
  reflected in all other open tabs without a reload, and a push from one tab
  prevents the other from issuing a redundant clobber push.
- Best-effort flush on tab close / hide: a pending change inside the debounce
  window is sent via a `keepalive` PATCH before the page unloads, so edits
  survive accidental closes without waiting for the next startup pull.
- 3-way merge for sync conflicts: when both sides changed *different* items,
  sync now auto-resolves silently ("Synced ✓ — merged changes") without
  showing the conflict modal.
- Content-equality short-circuit: if local and remote carry the same effective
  content (e.g. after a keepalive flush), sync reconciles silently instead of
  showing a spurious conflict modal.
- `CHANGELOG.md` (this file) and a changelog convention in `AGENTS.md`.

### Changed
- Sidebar "All" / "None" selection buttons restored to text labels (were icon
  buttons).
- Expand/collapse toggle in the sidebar now only collapses venue series; category
  headers stay in place.
- "For you" / "Find similar" no longer shows the top progress bar while loading;
  the modal opens immediately in a loading state and fades in the results.
- Sign-out confirmation dialog now uses a red (danger) button, consistent with
  "Clear all data".
- Card first-row items (venue badge / id / status / note / bookmark) are now
  vertically centered relative to each other.
- "Notes" filter label renamed to "Noted" in the controls bar.
- Removed the "to read" count from the Insights rail (reading / done remain).
- "Clear local data" button restyled to a hollow danger button (red outline +
  red text/icon, transparent fill) — less visually heavy than the solid red.
- Removing a tag in Settings now asks for confirmation (the operation removes
  the tag from *all* papers and is not undoable).
- Removing a series from a venue group in Settings now asks for confirmation.

### Fixed
- Sort label no longer briefly flashes "Sort: Venue" on reload when a different
  sort is saved in the URL.
- Private note dialog no longer feels sluggish to open (removed double
  backdrop-blur layer).
- Paper title and author normalization now removes LaTeX/entity artifacts, repairs
  source-specific author parsing, and avoids unsafe metadata matches for generic
  authorless schedule entries.
- GitHub session no longer silently drops after ~8 hours: expired access tokens
  are refreshed automatically via the broker; a single transient 401 retries
  with the refreshed token before clearing credentials.
- Sign-in now explicitly requests `gist` scope so newly-authorized tokens have
  the required permissions on fresh OAuth App authorizations.
- Net-zero edits (e.g. adding then removing a tag within the 5-second debounce
  window) no longer trigger a GitHub Gist sync.
- Toggling theme or changing accent no longer triggers a spurious sync push
  (theme/accent are not part of the synced bundle).
- Page load with a saved accent no longer briefly shows "Pending" for a logged-in
  user who has no actual pending changes.

---

## [2026-06-10]

### Added
- GitHub Gist sync: sign in with GitHub to automatically sync venue groups,
  collections, tags, and saved searches across devices via a private Gist.
- 3-state sync pill button (Pending / Syncing… / Synced) with last-synced
  hover tooltip and ⌘S / Ctrl+S manual-sync shortcut.
- Conflict detection with a diff view (local vs cloud) and three resolution
  options: keep local, apply cloud, or merge both sides.
- Auto-sync on tab focus (pulls remote changes when switching back to the tab)
  and on startup (recovers any un-pushed changes after a reload).
- ETag conditional GET: unchanged remote returns HTTP 304 (not billed against
  GitHub rate limit).
- Shareable URLs: export/import a complete settings bundle or share a single
  collection via a URL hash link.
- Tag combobox with space-separated multi-word search support and correct
  Chinese IME (composition) handling.
- Tag filter pill in the active-filters bar.
- "Last synced at" full timestamp on sync pill hover.
- Account dropdown in the Settings panel with avatar, display name, and sign-out.
- Custom modal dialogs replacing all `window.confirm` / `window.prompt` calls.
- Show local storage usage in Settings with a confirmed-clear button.
- Accent color picker (clay / sage / ocean / dusk) with flash-overlay transition.

### Changed
- Sync control redesigned from icon-only cloud button to a wider icon + label
  pill reusing the existing `.chip-btn` component; uses a circular-arrows icon
  consistent with the site's Feather icon set.
- Theme and accent settings excluded from the synced bundle (device-local preferences).
- "Last synced" display now reflects the last confirmed-in-sync check time
  (push, pull, or verified no-op) rather than the remote `updatedAt` timestamp.

### Fixed
- Active-filter chip text corrupted by smart/curly quotes in HTML attributes
  (caused all filter chips to render as bare text with an inert × button).
- `tags=` URL parameter lost after a page reload (tag filter was pruned against
  an empty paper list before data finished loading).

---

## [2026-06-09]

### Added
- Venue groups: create named groups of venue series (e.g. "My SE list")
  that appear as a top-level entry in the category sidebar.
- Paper collections: save papers into named collections; filter to a collection
  from the sidebar.
- Per-paper tags: tag any paper with free-form labels; filter by tag from the
  active-filter bar.
- Saved searches: bookmark a filter + sort state under a name for quick recall.
- Settings panel: central UI for groups, collections, tags, saved searches,
  theme, accent, import/export, and (later) GitHub sync.
- Favorite venue series: pin series in the sidebar with a star toggle; "Favorites
  only" sidebar filter.
- Accent color support (clay default) with `data-accent` on the root element.
- Custom caret-select dropdown component (replaces `<select>` for Sort and
  similar pickers).
- Show local-storage size in Settings.
- 2023 and 2024 venue editions added to the data set.

### Changed
- Settings panel relocated to a dedicated modal accessible from the topbar.
- SVG chevron icons replace emoji carets throughout the UI.

### Fixed
- Chip box model unified so the "+ tag" button matches the height of regular
  tag chips.
- Tag chip CSS rules ordered after `.chip` so overrides apply correctly.
- Settings panel placement, popover animation, and tag/chip spacing polished.

---

## [2026-06-08]

### Added
- Author disambiguation: hybrid author-id system (ORCID / OpenAlex) with
  name+affiliation fallback; per-author IDs stored in `authorIds` field.
- Institution relationship network modal: explore co-institution links for the
  current result set.
- Co-author network modal: explore collaboration graphs for the current result set.
- Insights rail: live top-institutions / top-authors / top-tracks charts for
  the current filter; click any bar to drill in.
- Field-aware search: `author:`, `title:`, `inst:` prefix filters; `-` exclusion.
- Author affiliation display: hover an author chip to see their institution; click
  institution to filter to it.
- Keyboard navigation: `j/k` card focus, `Enter` to open abstract, `g g` / `G`
  to scroll, `⌘K` to focus search, `⌘/` to toggle help.
- Publication-metadata enrichment: merge DOI, abstracts, publication date,
  volume/issue/pages, keywords, and open-access/PDF links from Crossref/OpenAlex.
- DBLP adapter: publishes TOSEM 2025/2026, TSE 2025/2026 journal articles, plus
  security/privacy and systems/networking conference proceedings.
- Collapsible sidebar with animated transitions; responsive mobile drawer.
- Export bar: select papers, then copy BibTeX or download CSV with full metadata.
- "By year" and "by venue" chart variants in Insights (later unified into rail).
- 2025 venue editions added for all existing series.

### Changed
- Sidebar grouped by series with collapsible years for each series.
- Footer redesigned: GitHub icon + commit hash left, build time right.
- Title card acts as an expand/collapse toggle for the abstract.

### Fixed
- Footer separator, icon alignment, and build-time timezone display.
- Search-clear icon centered; relative build time shown in viewer's timezone.
- `[hidden]` attribute override fixed so hidden panels stay hidden.
- Mobile layout: full-bleed safe areas, `dvh`, themed root canvas.

---

## [2026-06-07]

### Added
- Brand lockup, favicon (SVG), unified Feather icon set; renamed project
  `confcrawl` → `confer`.
- DATE 2025/2026 via `dateconf` adapter (official detailed programme).
- ICSE 2023/2024/2025/2026, FSE 2023/2024/2025/2026, ASE 2023/2024/2025,
  ISSTA 2023/2024/2025, OOPSLA 2025/2026 via Researchr adapter.
- ASPLOS 2026, ISCA 2026, MICRO 2025 via `sigarch` adapter.
- HPCA 2026 via Researchr adapter.
- POPL 2025/2026, PLDI 2025/2026 via Researchr adapter.
- Abstract animation (height transition on card expand/collapse).
- Sidebar footer with last-update date, repo link, and commit hash.

### Changed
- Scraper refactored into a self-sufficient config-driven pipeline: single
  `confer build` command; retry fetcher with exponential backoff; rebuilt
  per-venue JSON with current enrichers.

### Fixed
- All-caps paper titles normalized by the scraper.
- iOS Safari ghost-layer band on theme toggle (multiple attempts; workaround
  via opacity/visibility modals and `color-scheme` on root; documented as a
  known Safari compositor issue in AGENTS.md).
- Mobile safe-area, `dvh` canvas, and responsive grid fixes.
- Sidebar collapse animation, mobile overflow, and broken hidden panels.

---

## [2026-06-05 – 2026-06-06]

### Added
- Initial Astro multi-venue static site with category sidebar (Phase 2 & 3).
- Single-page app: client-side search, track/event filters, sort, per-venue
  paper favorites keyed as `venueId:paperId`, BibTeX/CSV export, saved searches.
- Collapsible sidebar and filter groups (Phase 3 polish).
- Netlify deployment (`netlify.toml`); removed old GitHub Pages `docs/` site.
- Scraper monorepo (`scraper/src/confer`): config-driven package with adapters
  for Linklings; reads `config/venues.yaml`; pytest from `tests/fixtures/`.
