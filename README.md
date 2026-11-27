[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/dankurniaone/diff-speed-01-run-20261126/rank.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/dankurniaone/diff-speed-01-run-20261126/reward.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)

# Diff two texts faster

A faster drop-in for [makefun-diff 1.0.0](https://make.fun/competitions/diff-speed-01-run-20261126) that returns its exact patch for every input. Entry for the [make.fun bounty](https://make.fun/competitions/diff-speed-01-run-20261126).

## How it works

makefun-diff's cost is its Myers search: one linked path object per `(d, k)` step, so a case with ~3,500 edits allocates millions of small objects. This module keeps the search's rule exactly — common prefix, then common suffix, then Myers's greedy search that keeps the furthest-reaching path per diagonal and prefers a deletion on ties, with no edge diagonal pruned — but runs it on interned lines and typed arrays:

1. **Lines are interned.** Each distinct line (its `\n` included, the last line without one when the text ends bare) becomes one small integer, shared by both texts, so a line comparison is one integer compare and the search never builds line strings.
2. **The search keeps only numbers.** Per `(d, k)` it stores just the furthest old position reached, in one flat `Int32Array` laid out as a triangle. The parent each step took is recovered from those stored positions alone, so the edit script is rebuilt by walking back from the terminal diagonal. No path objects at all.
3. **The patch is formatted exactly as makefun-diff formats it.** Same header, same hunks with 3 kept lines of context, deletions before insertions in a run, `%` after a line that ends its text without a newline, header alone when the texts are identical.

Everything is deterministic: no clock, no randomness, no state kept between cases. Dependency-free, stdlib-only Node.

## Files

- `solve.js` — the fast implementation; `run(input)` returns makefun-diff's patch as one JSON string.
- `main.ts` — the harness driver (unchanged from the house baseline): reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json`.

## Measured

Practice set (4 cases, ~20k–32k lines each), this machine, `main.ts` end to end:

- This entry: ~790 ms median over 5 runs.
- House baseline (makefun-diff 1.0.0): ~1,635 ms median over 5 runs.
- About 2.1x faster, with byte-identical output on all 4 practice cases.

Correctness was also checked against the reference on 714 extra cases (hand-written edge cases: empty texts, CRLF, bare endings, unicode, emoji, repeated lines, moved blocks, swaps; plus random small/medium/large cases) and 12 full-scale cases drawn from the competition's own generator — all identical, zero differences.

## License

MIT. See [LICENSE](LICENSE).
