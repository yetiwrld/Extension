# Flow adapter: assumptions and live validation

`src/flow/` is the only code that knows how Google Flow's page is built. Everything else
talks to it through the commands listed in `src/shared/protocol.js`
(`probe`, `readSettings`, `applySettings`, `clearReferences`, `attachReferences`,
`insertPrompt`, `snapshotOutputs`, `submit`, `generationStatus`, `diagnose`).

## Status: not verified against the live Flow page

The heuristics below were written from Google's public Flow help pages (the prompt box with
the model name, Image/Video mode, Add → Upload, aspect ratio, Generate) and from common
accessibility conventions. Flow requires a signed-in Google account, so the page could not
be inspected while this code was written. Treat every row as an assumption until it passes
the checklist at the end of this document.

The unit tests and the browser harness use a synthetic page (`test/fixtures/flow-fixture.js`).
It models these assumptions. It is not a copy of Flow, so passing those tests does not prove
the live page matches.

## Heuristics and the symptom when each one is wrong

| What | How the adapter finds it | Symptom when wrong | Where |
| --- | --- | --- | --- |
| Prompt box | Candidate discovery, then disambiguation. Candidates: every `textarea`, text-like `input`, any `contenteditable` value (`true`, `""`, `plaintext-only`) and any `role="textbox"`, in the top document, in same-origin frames and in shadow roots. Rejected: search fields, fields in header/nav/aside/search regions, fields in dialogs, read-only fields, unrelated names. Scored by: prompt-like label, a Generate/Send control in its region, an Add/upload control in its region, a model/settings control in its region, size, enabled. Equal scores are reported as ambiguous. Both the standard composer and the Agent chat input are detected; the report says which layout was active. | "Flow prompt box not found." — the error names every text field the page offers and why each was rejected | `selectors.js` `collectPromptCandidates`, `selectPromptCandidate`, `findPromptBox`, `requirePromptBox` |
| Generate button | Visible control in the prompt's region named Generate, Create, Make, Send or Submit (a chat layout starts with Send). Document-wide fallback only for an explicit "Generate". | "Generate button not found." or "disabled" | `findGenerateButton` |
| Settings control | The model-name control in the prompt region (it opens the menu with Mode, Model and Aspect ratio together), then any control with `aria-haspopup`/`aria-expanded` (any tag), then settings-like names, chevrons, aspect-ratio chips and bare Image/Video words. If the prompt region holds no candidate, the document is searched, but only strong matches (model name or declared popup) are clicked there. When nothing is found, the Check Flow page report lists the controls that are near the prompt. | "Could not find the model/settings control." | `findSettingsTrigger`, `listPromptControls` |
| Settings options | Options inside an open menu, dialog or listbox. Grouped by the nearest heading (Mode, Model, Aspect ratio). Options are classified by group, then by shape (`16:9`). | Empty or wrong option lists; setting not found | `readPopoverOptions`, `classifySettingOption` |
| Agent switch | Control named "Agent" with `aria-checked` or `aria-pressed`. | Agent state not detected | `findAgentToggle` |
| Add / Upload | Button named Add, Upload or Attach near the prompt. Menu item named Upload. Then a file input. | "Could not find the Add control" or "did not open a file picker" | `findAddButton`, `findUploadMenuItem`, `findFileInput` |
| Reference chips | Remove buttons named Remove, Delete, Clear or Close inside the prompt region, plus thumbnails of 24–160 px. | Upload never confirmed → `REFERENCE_UPLOAD_FAILED`; leftovers → `REFERENCE_CLEAR_FAILED` | `countAttachedReferences`, `findReferenceRemoveButtons` |
| Outputs | `img` and `video` elements at least 96×96 px, outside the prompt region and menus. Key = `src`. | New output never seen → generation times out (fails safely) | `findOutputMedia` |
| In progress | `[role="progressbar"]` or `[aria-busy="true"]` outside the prompt region. | Completion too early if a generation shows no indicator; never completes if an unrelated spinner stays on screen | `findProgressIndicators` |
| Failure | Text of a `[role="alert"]` that was not on the page before submission. | Failure not reported → times out instead of failing fast | `findAlertTexts` |

Two safety properties do not depend on these heuristics being right:

- A scene completes only when a new output is seen, no progress indicator is active, and the
  state holds for consecutive polls and a settle window. Elapsed time alone never completes a scene.
- If an element cannot be found or verified, the step fails with a named error. The adapter never
  clicks a guessed location and never reports success it did not observe.

## Live validation checklist

Do this once on a real, signed-in Flow project before using the queue on real work.

1. Build (`npm run build`), then load `dist/` as an unpacked extension in Chrome 116 or later.
2. Open a Flow project in the active tab and open the side panel. The header should read
   **● Connected**.
3. Open **Settings → Check Flow page**. Each check should be OK:
   Flow connector, Flow page, Project open, Prompt box, Generate button, Settings
   control, Agent mode. Any failing check names the heuristic that needs updating
   (table above). The report lists, with the checks:
   - the composer selectors that ran and how many fields each matched, per frame;
   - every prompt field candidate: tag, role, accessible label, placeholder, contenteditable
     value, visibility, enabled state, bounding rectangle, frame (or shadow root), and
     why it was or was not chosen;
   - the controls that ARE near the prompt (tag, role, accessible name, purpose) and the
     settings those controls show;
   - any exception with a trimmed stack trace.
   Press **Copy report** to put the whole report on the clipboard and paste it where the
   heuristic is being fixed. The report contains page structure only — a field's content
   (your prompt text) is never read, and account details are never collected. The report
   is produced even when the connector does not answer, so a dead tab is itself diagnosable.
4. Press **Read from Flow**. Mode, Model and Aspect ratio should list exactly what Flow's
   settings menu shows, and the current values should match Flow.
5. Add one real reference image whose filename a one-scene document names exactly. Analyze a
   one-scene document. Press Start. Confirm, in order:
   - the prompt appears in Flow's prompt box, verbatim;
   - the reference appears as a chip in Flow;
   - Generate is clicked (progress appears in the results);
   - the queue shows Completed only after the output is visible in Flow;
   - Flow's settings are unchanged after the run, apart from what you chose.
6. Force a failure you can see in Flow, for example by leaving a required setting invalid. Confirm the
   scene shows Failed with Flow's own message, and that Retry, Skip and Stop are offered.
7. Record what you saw, including the Flow version and date, in your change notes.

## Changing a heuristic

Change only `src/flow/selectors.js` (and `dom.js` for generic helpers). Before changing it, add a
test that reproduces the observed markup — `test/prompt-detection.test.js` for the composer,
`test/settings-trigger.test.js` for the settings control, `test/flow-adapter.test.js` for the
adapter contract — so the fix is pinned. Then run `npm test` and `npm run e2e`.

Composer detection never reads a field's text content: for a composer, the text content IS the
user's prompt. Candidate labels come from `aria-label`, `aria-labelledby`, `placeholder` and
`title` only. Keep it that way — the "Check Flow page" report must never carry prompt text.
