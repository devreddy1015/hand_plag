# Handscript

Turn typed text — or a PDF, or a Word file — into realistic handwriting on real paper,
then download it as a PDF or as images. It is free, needs no sign-up, has no page limit
and adds no watermark. Everything runs in the browser: documents, fonts and text never
leave the device.

![The Handscript editor, with an imported document written out on ruled paper](docs/screenshot.jpg)

Close-up of the writing itself (fountain pen):

![Close-up of the handwriting](docs/ink-closeup.jpg)

## What it does

**Reads your documents.** Drop in a PDF, a `.docx`, or a text file. A PDF has no
paragraphs — only thousands of positioned glyph runs — so the importer rebuilds the
document: it groups runs into lines, finds columns, joins words broken across a line
break, recovers headings from the size of the type, restores lists (including bulleted
lists whose bullets were drawn rather than written), carries sentences across page
boundaries, and drops the running headers, footers and page numbers that should not be
written out again. A 15-page PDF becomes about 30 handwritten pages in a couple of
seconds.

**Writes it by hand.** 19 handwriting fonts, or upload your own. The layout engine is
built around how people actually write, not how a typesetter sets type:

- The hand is steady inside a word and wanders between words; it drifts slowly in size,
  slant and spacing over many lines, and gets messier down the page and through the
  document.
- Lines are filled the way a writer fills them: crammed a little, run past the margin, or
  hyphenated, rather than left conspicuously short. Letters crowd together as the margin
  approaches.
- Each letter has several fixed variants, so a repeated letter is never identical, and a
  letter's persona (its own slight tilt, size and baseline) stays consistent through the
  document.
- Optional human corrections: a word started wrong and crossed out, one squeezed in above
  a caret, a dot of ink left where the pen rested.
- Headings are written larger and underlined by hand, bullets are dabbed on, `**bold**` is
  pressed harder, `_italic_` leans further.

**On the right paper.** 20 paper templates — exercise book, school notebook with a double
red margin, college and wide ruled, spiral-bound, torn-out, four-line practice paper,
French Séyès, graph, dot grid, engineering pad, legal pad, exam answer sheet, Cornell
notes, two columns, plain, ivory, recycled, diary, index card — and every part of them is
adjustable: ruling, spacing, colours, margins, binding holes, header and name/date lines,
page numbers printed or written by hand, mirrored margins on alternate pages, ink showing
through from the back, a torn edge.

**Written with a real pen.** Ballpoint, gel, rollerball, fountain, calligraphy nib, felt
tip and pencil. A nib is drawn as a nib — several passes across its width — so strokes
across it are broad and strokes along it are fine. Ink bleeds into the paper, pools where
the pen is set down, varies in flow and pressure, and pencil is broken up by the tooth of
the paper.

**Handed over how you like.** Flat art, a flatbed scan (crooked, uneven lamp, sensor
noise), or a photo on a desk (keystoned, lit from one side, casting a shadow). Export a
multi-page PDF or PNG/JPEG images at 150–400 DPI, all pages or a range.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests: layout, paper, markup, PDF reflow, segmentation
npm run build      # static site in dist/
npm run preview    # serve the built site
```

## Deploy it

`dist/` is a plain static site with relative asset paths, so it can be hosted anywhere and
from any sub-path. No server, no API keys, no backend.

- **GitHub Pages**: push to `main`; the included workflow (`.github/workflows/pages.yml`)
  builds and publishes it to https://devreddy1015.github.io/hand_plag/. This needs Pages
  set to **Source: GitHub Actions** (Settings → Pages). In the older "Deploy from a
  branch" mode, the `github-pages` environment only allows that one branch, and the
  deploy step is refused with "Branch main is not allowed to deploy to github-pages".
- **Netlify / Cloudflare Pages / Vercel**: build command `npm run build`, publish
  directory `dist`.
- **Anything else**: copy `dist/` onto any static host or CDN.

## How it works

```
text ─► blocks ─► layout (pure) ─► pages of glyphs + strokes ─► render (Canvas 2D) ─► PDF / PNG
  │        │           │                                            │
PDF/DOCX  headings   lines, columns, pagination,            paper + ruling + furniture,
importer  lists      seeded per-glyph jitter,               ink layer (multiply blend),
          emphasis   fill, hyphenation, corrections         nib, bleed, pooling, scan/photo
```

| Path | Role |
| --- | --- |
| `src/engine/` | The portable engine. No DOM: it needs only a Canvas 2D context and a text measurer, so the same code can run in a Web Worker or on a server (for example with `@napi-rs/canvas`) for a future rendering API. |
| `src/engine/layout.ts` | Splits blocks into lines and pages. Samples the jitter for each glyph from seeds based on position, so editing one paragraph doesn't reshuffle the others. |
| `src/engine/render.ts` | Paints one page at any scale: paper, then the ink layer blended with multiply, then the finish. |
| `src/engine/paper.ts` | Paper sizes, page geometry, printed furniture and the procedural paper texture. |
| `src/engine/templates.ts` | The paper templates and the features each one turns on. |
| `src/engine/markup.ts` | The small Markdown subset that maps onto things a hand can do. |
| `src/engine/segment.ts` | Grapheme clusters, whole-word units for scripts that need shaping, CJK break points, script detection, hyphenation points. |
| `src/import/reflow.ts` | Rebuilding a document from positioned text: lines, columns, paragraphs, headings, lists, running heads. Pure, and tested on its own. |
| `src/import/pdf.ts`, `docx.ts` | The readers themselves, loaded on first use. |
| `src/fonts.ts` | Font catalog, fallback stacks, per-script size matching, custom font upload. `@font-face` rules load per font, on demand. |
| `src/export/` | PDF (pdf-lib) and PNG/JPEG/ZIP (fflate). Both load only when you first export. |
| `src/main.ts`, `src/ui/` | The editor. |

Layout units are CSS pixels at 96 DPI. A page is laid out once and rendered at any scale:
the screen's pixel density for the preview, or the chosen DPI for export. Every random
choice is seeded, so the preview matches the export exactly, and "New variation" rolls a
new seed.

Mixed scripts work: characters the chosen font lacks fall back to a matching handwriting
font and are resized to the main font's x-height, and right-to-left paragraphs are laid
out from the right margin.

## Performance

A 78,000-character document (49 A4 pages) lays out in well under a second and exports at
200 DPI in about eight seconds, roughly 145 ms per page. Thumbnails are painted only when
they scroll into view, so a 300-page document opens as quickly as a one-page one.

Still to do: move layout into a Web Worker so documents of several hundred thousand
characters don't block typing.

## Roadmap

1. ~~Text box, OFL fonts, paper, jitter engine, PNG/PDF export~~ (done).
2. ~~PDF and Word import, paper templates, pens with real nibs, human corrections, scan
   and photo finishes~~ (done).
3. Rich text editor (Tiptap): tables, images and maths (KaTeX).
4. An in-app builder that turns a scan of your own handwriting into a font.
5. B2B API: headless rendering with the same engine, CSV batch personalisation, and
   print-ready PDFs (bleed, trim box, PDF/X).
6. Neural "your handwriting from one sample" (One-DM / DiffusionPen) as a GPU job whose
   word images slot into this layout engine.

## Fonts and licensing

App code is MIT (see `LICENSE`). Bundled fonts come from [Fontsource](https://fontsource.org)
and keep their own licences (SIL OFL 1.1 or Apache 2.0, both of which allow commercial
use and server-side rendering). `npm run build` gathers them into `font-licenses.txt`,
which ships with the app. If you add fonts, check that the licence allows web-service
use. Many "free" fonts do not.

PDF reading uses [pdf.js](https://mozilla.github.io/pdf.js/) (Apache 2.0), which runs in a
worker in the browser.
