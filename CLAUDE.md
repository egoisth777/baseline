# baseline — repo instructions

## Ubiquitous language

This project has an agreed vocabulary in
[`.arca/baseline-sp/ubi_lang.md`](.arca/baseline-sp/ubi_lang.md).

- **Consult `ubi_lang.md` before introducing any new word or concept.** Reuse the
  existing term rather than inventing a synonym.
- When a term in `ubi_lang.md` lists alternatives under _Avoid_, do not use the
  avoided words in code, docs, commits, or discussion.
- If a genuinely new concept appears that no existing term covers, **add it to
  `ubi_lang.md` first**, then use it. Keep definitions tight (what it IS, not how it
  is implemented).
- `ubi_lang.md` is the single source of truth for project vocabulary. Do not create
  a second glossary elsewhere.

## Source layout

- `src/` holds hand-authored source: `*.ts` (compiled by `tsc`) and the `*.zig`
  native source.
- `scripts/` holds committed compiled output (`*.js`) deployed by the manager.
- Edit TypeScript in `src/`, run `npm run build`, then re-run the installer. Never
  hand-edit `scripts/*.js`.
