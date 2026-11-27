// Fast drop-in for makefun-diff 1.0.0: the same patch, the same tie-breaks, far less work.
//
// makefun-diff's cost is its Myers search: one linked path object per (d, k) step, so a case
// with ~3,000 edits allocates millions of small objects and the collector pays for it. This
// module keeps the search's rule exactly — the common prefix, then the common suffix, then
// Myers's greedy search that keeps on each diagonal the path furthest into the old text and,
// when a deletion and an insertion reach the same point, the deletion's; no edge diagonal
// pruned; every run of equal lines followed as far as it goes; the first path to reach both
// ends is the script — but runs it on interned lines and typed arrays:
//
//  1. Lines are interned: each distinct line (its "\n" included, the last line without one
//     when the text ends bare) becomes one small integer, shared by both texts, so a line
//     comparison is one integer compare and the search never builds line strings.
//  2. The search keeps, per (d, k), only the furthest old position reached, in one flat
//     Int32Array laid out as a triangle (layer d at d*(d+1)/2, entry j for k = -d + 2j).
//     The parent a step took is recovered from those stored positions alone, so the edit
//     script is rebuilt by walking back from the terminal diagonal — no path objects at all.
//  3. The patch is formatted exactly as makefun-diff 1.0.0 formats it: the same header,
//     the same hunks with 3 kept lines of context, deletions before insertions in a run,
//     "%" after a line that ends its text without a newline, and the header alone when
//     the texts are identical.
//
// Everything is deterministic: no clock, no randomness, no state kept between cases.

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

const KEEP = 0;
const DEL = 1;
const INS = 2;

/** A text's lines, each with its "\n" (the last one without, when the text does not end in one),
 *  interned to small integer ids in `table`, shared with the other text. */
function tokenize(text, table) {
  const ids = [];
  const strs = [];
  const n = text.length;
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) break;
    const line = text.slice(start, nl + 1);
    let id = table.get(line);
    if (id === undefined) {
      id = table.size;
      table.set(line, id);
    }
    ids.push(id);
    strs.push(line);
    start = nl + 1;
  }
  if (start < n) {
    const line = text.slice(start);
    let id = table.get(line);
    if (id === undefined) {
      id = table.size;
      table.set(line, id);
    }
    ids.push(id);
    strs.push(line);
  }
  return { ids: Int32Array.from(ids), strs };
}

/** The runs of the edit script of a into b: [[kind, count], ...], in order, by the header's rule. */
function editRuns(a, b) {
  const n = a.length;
  const m = b.length;
  // hist: layer d starts at d*(d+1)/2 and holds d+1 entries, one per diagonal k = -d + 2j.
  // An entry holds the furthest old position reached plus one (0 when none consumed), or -1
  // when no path reaches that diagonal. Every entry is written for its layer before any later
  // layer reads it, so the array needs no initial fill; -1 is written explicitly where no
  // path reaches a diagonal.
  let capD = 4096;
  let hist = new Int32Array(((capD + 1) * (capD + 2)) / 2);

  // d = 0: the initial run of equal lines.
  let x = -1;
  let y = -1;
  while (x + 1 < n && y + 1 < m && a[x + 1] === b[y + 1]) {
    x++;
    y++;
  }
  hist[0] = x + 1;
  let D = 0;
  let kFinal = 0;
  if (x + 1 < n || y + 1 < m) {
    let done = false;
    let b0 = 1; // base(d) for the layer being written; base(d) = base(d-1) + d
    for (let d = 1; d <= n + m && !done; d++) {
      if (d > capD) {
        let nd = capD;
        while (d > nd) nd *= 2;
        const nh = new Int32Array(((nd + 1) * (nd + 2)) / 2);
        nh.set(hist);
        hist = nh;
        capD = nd;
      }
      const p0 = b0 - d; // base(d-1), the layer the parents are read from
      for (let j = 0; j <= d; j++) {
        const k = -d + 2 * j;
        // The deletion's parent is the (d-1, k-1) entry, the insertion's the (d-1, k+1) one.
        const delX = j >= 1 ? hist[p0 + j - 1] : -1;
        const insX = j < d ? hist[p0 + j] : -1;
        // A move past the end of its own text is no candidate.
        const canRemove = delX !== -1 && delX < n;
        const canAdd = insX !== -1 && insX - 1 - k < m;
        if (!canRemove && !canAdd) {
          hist[b0 + j] = -1;
          continue;
        }
        // The candidate further into the old text, and the deletion when both reach one point.
        const byDel = canRemove ? delX : -2;
        const byIns = canAdd ? insX - 1 : -2;
        let xx;
        let yy;
        if (byDel >= byIns) {
          xx = delX;
          yy = xx - k;
        } else {
          xx = insX - 1;
          yy = xx - k;
        }
        // Follow every run of lines equal in both as far as it goes.
        while (xx + 1 < n && yy + 1 < m && a[xx + 1] === b[yy + 1]) {
          xx++;
          yy++;
        }
        hist[b0 + j] = xx + 1;
        if (xx + 1 >= n && yy + 1 >= m) {
          D = d;
          kFinal = k;
          done = true;
          break;
        }
      }
      b0 += d + 1; // base(d+1) for the next layer
    }
    if (!done) throw new Error('makefun-diff: the search ended without reaching both ends');
  }

  // Walk back from the terminal diagonal, rebuilding the runs in reverse.
  const segs = [];
  x = hist[(D * (D + 1)) / 2 + (kFinal + D) / 2] - 1;
  let k = kFinal;
  for (let d = D; d >= 1; d--) {
    const p0 = ((d - 1) * d) / 2;
    const j = (k + d) / 2;
    const delX = j >= 1 ? hist[p0 + j - 1] : -1;
    const insX = j < d ? hist[p0 + j] : -1;
    const canRemove = delX !== -1 && delX < n;
    const canAdd = insX !== -1 && insX - 1 - k < m;
    const byDel = canRemove ? delX : -2;
    const byIns = canAdd ? insX - 1 : -2;
    let moveKind;
    let xAfterMove;
    let parentX;
    let parentK;
    if (byDel >= byIns) {
      moveKind = DEL;
      xAfterMove = delX;
      parentX = delX - 1;
      parentK = k - 1;
    } else {
      moveKind = INS;
      xAfterMove = insX - 1;
      parentX = insX - 1;
      parentK = k + 1;
    }
    const snake = x - xAfterMove;
    if (snake > 0) segs.push([KEEP, snake]);
    segs.push([moveKind, 1]);
    x = parentX;
    k = parentK;
  }
  const x0 = hist[0] - 1;
  if (x0 + 1 > 0) segs.push([KEEP, x0 + 1]);

  // Reverse into forward order, merging runs of one kind that touch.
  const runs = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last !== undefined && last[0] === s[0]) last[1] += s[1];
    else runs.push([s[0], s[1]]);
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? `${op}${line}` : `${op}${line}\n%\n`;
}

/** make.fun's own patch of input.old into input.new, as one JSON string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const table = new Map();
  const A = tokenize(input.old, table);
  const B = tokenize(input.new, table);
  const a = A.strs;
  const b = B.strs;
  const aIds = A.ids;
  const bIds = B.ids;
  const n = a.length;
  const m = b.length;
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  runs.push(...editRuns(aIds.subarray(prefix, n - suffix), bIds.subarray(prefix, m - suffix)));
  if (suffix > 0) runs.push([KEEP, suffix]);

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r[0] === KEEP) {
      o += r[1];
      p += r[1];
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r[0] === DEL) {
      c.dels += r[1];
      o += r[1];
      deleted += r[1];
    } else {
      c.ins += r[1];
      p += r[1];
      inserted += r[1];
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a[at]));
  }
  return out.join('');
}
