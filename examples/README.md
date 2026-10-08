# Examples

- `test-scenes.txt`: a four-scene document. It parses to four scenes with these references:
  - Scene 1: `Aron.png`, `Laboratory.png`
  - Scene 2: `Aron.png`
  - Scene 3: `Vex.png`, `Mira.png`
  - Scene 4: `Mira.png`, `Laboratory.png`
- `reference-library/`: the four reference images with the exact filenames the document uses:
  `Aron.png`, `Vex.png`, `Mira.png`, `Laboratory.png`. They are plain coloured shapes, so they are
  easy to tell apart in Flow. Regenerate them with `node scripts/make-fixtures.mjs`.

To try the example:

1. In the side panel, press **Add images** and select the four files in `reference-library/`.
2. Press **Load example** (or paste `test-scenes.txt`), then **Analyze scenes**.
3. All four scenes should show their references as matched. Start is enabled once Flow is connected.

Note that a real Flow run uses real generations and your Flow quota. The browser harness uses a
synthetic Flow page instead (`npm run e2e`).
