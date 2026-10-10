# Flow Scene Queue

A Chrome side-panel extension (Manifest V3) that turns a scene document into a queue of
Google Flow image or video generations. Each `[Scene N]` block is inserted into Flow with its own
reference images, submitted, and **waited for**. The next scene starts only after Flow shows the
previous output. It uses your existing Flow session. It stores no Google credentials.

## Read this first: what has and has not been verified

- **Not verified against the live Google Flow page.** Flow needs a signed-in Google account, and
  the page could not be inspected while this was built. All Flow-specific code lives in `src/flow/`.
  It finds controls by heuristics (role, accessible name, text). Those heuristics are written from
  Flow's public help pages and common accessibility conventions. Before relying on the queue for
  real work, follow the live checklist in [`docs/flow-adapter.md`](docs/flow-adapter.md). It names
  each assumption and the symptom when it is wrong.
- **Verified in code:** the scene parser, reference matching, the state machine, completion
  detection, pause / resume / stop semantics, storage, and the side-panel UI (unit tests). The
  complete pipeline (side panel, service worker, content script, Flow adapter, reference files in
  IndexedDB) was also exercised in headless Chromium against a **synthetic** Flow page
  (`npm run e2e`).
- **Not verified in a real browser profile:** the unpacked extension was not loaded into Chrome,
  because the Chromium available in the build environment is a headless shell without extension
  support. The browser harness stubs `chrome.*` APIs instead. Load `dist/` in Chrome 116+ and check it
  yourself before first use.

## What it does

- **Scene document.** Paste text with `[Scene N]` markers (any number of digits, any letter case).
  Optional title after the marker (`[Scene 2]: Vex arrives`). `Reference images:` lines are
  removed from the prompt. The prompt text is otherwise inserted exactly as written. Duplicate
  numbers and empty prompts block the queue and are named in the message.
- **Reference library.** Add PNG, JPG, WEBP or GIF files (25 MB each, 40 MB per scene), and upload
  those files to the Flow project once. For each scene, the extension uses **Add → Use from project**
  and attaches only its references. It prefers an exact filename, then a case-insensitive basename
  without an extension or version suffix; missing or ambiguous project items are never guessed.
- **Missing and ambiguous references.** Missing references block Start and are listed per scene with
  an **Add** button for that exact name. A bare name that fits several files (for example `Aron`
  when `Aron.png` and `Aron_Closeup.png` both exist) is never picked automatically. You choose the
  file in the scene row.
- **Queue.** Statuses: Waiting, Preparing, Uploading, Generating, Completed, Failed, Retrying,
  Paused, Skipped (symbols ● ○ ✓ ⚠ ✕ ▶ ⏸ ■).
- **Flow settings.** Mode, Model and Aspect ratio are read from Flow's own settings menu. Changing a
  value in the panel changes it in Flow. Options are only what Flow exposes. Settings are re-applied
  and verified before each scene.
- **Connection.** `● Connected` when the active tab is a Flow page whose connector answers,
  otherwise `○ Not Connected`. No project ID is entered.
- **Controls.** Start (with optional confirmation), Pause (takes effect at a safe point), Resume,
  Stop. On a failed scene the queue pauses and offers **Retry**, **Skip**, **Mark completed** (only
  when you have checked Flow), or **Stop**.
- **Settings.** Pause on failure; Require confirmation before starting; Continue after successful
  generation; Strict filename matching; Case-insensitive matching; generation timeout;
  Check Flow page; Clear current project; Clear reference library.
- **Persistence.** The queue, settings, document and log survive a panel close and a browser
  restart. A run interrupted by a service-worker restart is shown as paused for review.
- **Activity log.** Collapsible, timestamped, with the reason for every pause and failure.

## Install and use

```bash
npm install
npm run build          # produces dist/
```

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select
   the `dist/` folder.
2. Open a Flow project in a tab (`https://flow.google.com/project/...`).
3. Click the extension icon. The side panel opens beside Flow.
4. Upload the reference images to the Flow project once, using Flow's UI.
5. In the extension, click **Add images** and add the same files so scene names can be validated.
6. Paste your scene document and press **Analyze scenes**. Fix any problems listed.
7. Check **Flow settings** (they are read from Flow automatically on first connection; press
   **Read from Flow** to refresh).
8. Press **Start queue** and confirm. Watch the queue. Each scene shows its status.

To try the included example: add the four images from `examples/reference-library/`, then press
**Load example** and **Analyze scenes**. You should see four scenes, all references matched.

### Scene document format

```text
[Scene 1]
Wide establishing shot of a quiet harbour at dawn.
Reference images: Aron.png, Laboratory.png

[Scene 2]: Aron at the door
Medium shot of Aron studying a glowing vial.
Reference images: Aron.png
```

Rules: a scene runs from its marker to the next marker. Lines starting with `Reference images:`,
`Reference image:`, `References:` or `Ref:` (and bullet lists directly under them) list the
references. `none` means no references. Text before the first marker is ignored, with a warning.

## Automation guarantees (enforced in code)

- **Strictly sequential.** One scene is in flight at a time. The next scene begins only after the
  previous one is COMPLETED or SKIPPED.
- **Completion needs evidence.** A scene completes only when a new output is visible in Flow, no
  progress indicator is active, and the state holds across consecutive polls and a settle window.
  Elapsed time never completes a scene. A generation that does not finish within the timeout fails.
- **No silent resubmission.** A submitted generation is never clicked again automatically. Resume
  waits for the generation already in Flow. A failed generation is never retried automatically;
  only steps before the click (preparing, uploading, inserting) get one automatic retry.
- **Pause and stop are honoured at safe points.** Clicking Generate is not interruptible, because
  once the click may have reached Flow its outcome must be recorded.
- **Completed scenes stay completed.** Starting the queue never regenerates them. **Regenerate**
  queues one again explicitly. A scene whose text changed after completion is reported as a new scene.
- **References are verified.** Each scene carries only its own references: the reference slot is
  cleared first, each named item is selected through **Use from project**, and its chip is confirmed
  before the prompt is inserted. Missing or ambiguous project items stop the scene.
- **Errors are never silent.** Every failure names its cause and offers a next step.

### State machine (specification names → implementation)

| Specification state | Implementation (`src/queue/states.js`) |
| --- | --- |
| IDLE | session phase `idle` |
| CONNECTING | session phase `connecting` (connection check, settings capture) |
| READY | session phase `running` begins once Flow is verified and settings are captured |
| PREPARING_SCENE | scene status `preparing` (Flow idle check, settings applied, reference slot cleared) |
| UPLOADING_REFERENCES | scene status `uploading` |
| INSERTING_PROMPT | scene status `inserting` (shown as "Preparing") |
| GENERATING | scene status `submitting` (shown as "Generating") then `generating` |
| WAITING_FOR_COMPLETION | scene status `generating` |
| COMPLETED | scene status `completed`. Requires recorded evidence |
| NEXT_SCENE | the next waiting scene enters `preparing` |
| ERROR → PAUSED | session phase `error`, then `paused` with a decision the user resolves |

Transitions that are not in the tables throw `INVALID_STATE`. The tables are tested.

## Errors and what to do

| Code | Meaning | Next step |
| --- | --- | --- |
| `FLOW_NOT_CONNECTED`, `FLOW_TAB_CLOSED`, `FLOW_NO_RESPONSE` | Flow is not reachable | Open or reload Flow, then Resume |
| `FLOW_UI_CHANGED` | A required control was not found | Run **Check Flow page** in Settings |
| `FLOW_AGENT_ON` | Agent mode is on in the prompt box | Turn Agent off, then Resume |
| `FLOW_SETTING_FAILED` | Flow did not keep a setting | Set it in Flow, then Resume or Retry |
| `REFERENCE_MISSING` / `REFERENCE_AMBIGUOUS` | Reference not in the library, or several files match | Add the file, or choose one in the scene row |
| `REFERENCE_UPLOAD_FAILED` / `REFERENCE_CLEAR_FAILED` | Project media was missing/ambiguous, or Flow did not confirm attachment/removal | Upload or rename the project item, then Retry |
| `PROMPT_INSERT_FAILED` | Flow did not keep the prompt text | Check the prompt box, then Retry |
| `GENERATE_UNAVAILABLE` | Generate is missing or disabled | Check the prompt and settings, then Retry |
| `GENERATION_NOT_STARTED` / `GENERATION_FAILED` / `GENERATION_TIMEOUT` | Flow did not start, reported an error, or did not finish | Check Flow. Mark completed if the output exists, otherwise Retry |
| `INTERRUPTED` | The extension restarted during a step | Check Flow for that scene, then Resume |

## Permissions and data

- Permissions: `sidePanel`, `storage`, `scripting`. Host access only to `https://flow.google.com/*`
  and `https://labs.google/fx/tools/flow*`. No `tabs` permission and no all-sites access.
- Stored locally in the browser: preferences, the scene document and queue, the activity log, and
  reference metadata in `chrome.storage`; reference image bytes in IndexedDB (`flow-scene-queue`).
  Nothing is sent to any server by this extension.
- No Google credentials are read or stored. The extension acts only through the Flow page you have
  open in your browser.

## Typography

The side panel uses two typefaces. Both are bundled and both are licensed under the SIL Open Font
License 1.1:

- **DM Sans** (600 and 700) for the brand name, headings and scene titles.
- **Inter** (400, 500 and 600) for everything else: buttons, fields, dropdowns, the prompt text,
  reference filenames, status labels, settings, the activity log and error messages.

The Latin subsets are in `src/sidepanel/fonts/` as `.woff2` files, with the licence texts beside them
(`LICENSE-DM-Sans.txt` and `LICENSE-Inter.txt`). Nothing is loaded from a CDN. Text does not depend on
fonts installed on the computer; system fonts are fallbacks only. `src/sidepanel/typography.css` defines the families, the four-step
size scale (12, 13, 14 and 16 px), the line height and the weights as CSS variables, each with a
system fallback. Components use those variables and never name a font directly.

Text colours meet WCAG AA contrast (4.5:1) on every panel surface, and `test/typography.test.js`
checks each one. The browser harness measures every option of every Flow setting against its
dropdown at 320, 400 and 560 px, so a cut-off value shows up as a failed check.

## Architecture

```
src/
  manifest.json            Manifest V3
  background/              service worker: controller (commands), runner wiring, Flow bridge,
                           connection check, reference file loader
  content/                 Flow content script (top frame only): answers adapter commands
  flow/                    the only Flow-specific code: selectors (heuristics), settings,
                           prompt, references, outputs, adapter
  queue/                   state tables, scene model, completion polling, sequential runner,
                           readiness checks
  parser/                  [Scene N] parser and reference-line tokenizer
  references/              filename rules, matching, library (metadata + IndexedDB bytes)
  storage/                 schema and defaults, serialised store, chrome.storage and IndexedDB adapters
  sidepanel/               panel: index.html, sidepanel.css, typography.css (font and size tokens),
                           fonts/ (bundled Inter and DM Sans, with their licences), main.js (events
                           and polling), render.js (markup), api.js (messages), library-client.js
  shared/protocol.js       message names shared by panel, worker and content script
  utils/                   errors, async helpers, hashing, text, binary, ids
  icons/                   extension icons (generated by scripts/make-icons.mjs)
examples/                  test scene document and four test reference images
docs/flow-adapter.md       Flow assumptions and the live validation checklist
test/                      unit tests (node:test), synthetic Flow fixture, browser harness (test/e2e)
scripts/                   build, packaging, icon and fixture generators
```

Single writers: the service worker owns the queue, the automation state, the document, the
overrides, the logs and the Flow settings. The side panel owns the reference library. Both read the
other's data through storage. Flow DOM work happens only in the content script.

## Development

| Command | What it does |
| --- | --- |
| `npm run build` | Bundles `dist/` (service worker, content script, panel, manifest, icons) |
| `npm run watch` | Rebuilds on change (rerun the build after editing HTML, CSS or the manifest) |
| `npm test` | Unit tests: parser, references, states, completion, runner, store, library, adapter (jsdom), controller, panel rendering, manifest, typography (fonts bundled, tokens, contrast), connector injection (jsdom with the real content script) |
| `npm run check` | Build, then unit tests (the one-command gate before committing) |
| `npm run e2e` | Browser harness (see below). Needs `CHROME_PATH` and `puppeteer-core` |
| `npm run package` | Writes `release/flow-scene-queue-<version>.zip` from `dist/` |
| `npm run icons` | Regenerates `src/icons/` |
| `node scripts/make-fixtures.mjs` | Regenerates `examples/reference-library/` |

### Browser harness (`npm run e2e`)

```bash
npm run build
CHROME_PATH=/path/to/chromium npm run e2e
```

The harness serves the built panel and service worker, a synthetic Flow page in an iframe with the
real content script, and a `chrome.*` stub (`test/e2e/harness/stub.js`). It drives the panel with
real clicks and file inputs and checks: connection, layout with no horizontal overflow (1366×768
with 320 px and 400 px panels, 1440×900 with a 400 px panel, 1920×1080 with a 560 px panel),
typography (both fonts load, every text uses Inter or DM Sans, nothing is below 12 px, and every
Flow setting option is shown in full at 320, 400 and 560 px),
reference import, a full four-scene run
(order, per-scene references, settings applied, sequential submission), failure and Retry, pause
and resume without resubmission, reload during a run, settings read and change, and disconnection.
Screenshots go to `release/e2e-screenshots/`. A passing run shows the pipeline works. It does not
show that the live Flow page matches the synthetic one.

## Known limitations

- The Flow page heuristics are unverified (see the top of this file). Expect to adjust
  `src/flow/selectors.js` after the first live run.
- Completion detection relies on new large images or videos appearing in Flow's results area and on
  progress indicators. An unrelated spinner that stays on screen can stall a scene until the timeout.
- Agent mode must be off. The queue refuses to run with it on.
- One Flow tab per run. The run stays bound to that tab. Switching projects in that tab is not
  tracked; use Read from Flow after changing projects.
- A run interrupted by a browser or service-worker restart is paused for review. It is never
  resumed or resubmitted automatically.
- No image previews in the panel. Scene prompts are shown truncated.
- Native title tooltips and dropdown popups are drawn by the browser or the operating system, so they
  keep the system font. The status symbols (● ○ ✓ ⚠ ✕ ▶ ⏸ ■) and non-Latin text also fall back to
  the system font, because the bundled files cover Latin text only.

## Troubleshooting

- **○ Not Connected:** the active tab must be a Flow page. Open the project and press Check Flow page.
- **"Could not connect to this Flow tab":** the Flow tab was open before the extension was loaded or reloaded, and the extension could not attach to it. Reload the Flow tab (F5), then press Check Flow page. After reloading the extension in `chrome://extensions`, close and reopen the side panel as well.
- **"Flow is open but did not respond: Could not establish connection. Receiving end does not exist.":** the copy Chrome is running is the first build, which skipped the connector silently in a tab that had been open across a reload. Run `npm run build`, click ⟳ on the extension in `chrome://extensions`, then press F5 on the Flow tab. The current panel never shows that wording, so if you still see it, the old copy is still loaded.
- **Flow prompt box not found:** open a project and keep the prompt box visible.
- **A check in Check Flow page fails:** see [`docs/flow-adapter.md`](docs/flow-adapter.md).
- **Start is disabled:** the header of the Queue section names the first blocking problem.
- **Something unexpected:** read the Activity log. It records every step and error with a timestamp.
