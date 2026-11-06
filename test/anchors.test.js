import { test } from "node:test";
import assert from "node:assert/strict";
import { adviceFor, hintRecord, memoryFrom, remember, repeatErrors, wordsOf, HINT_MEMORY } from "../src/anchors.js";

const pt = (x) => ({ "pt-br": x });

test("anchors: words are compared plain by stem; names and common words never count", () => {
  const w = wordsOf("Riverside de novo. Senti cheiro de goma quente, e a Gabriele passava as camisas.");
  assert.ok(w.has("goma") && w.has("quent") && w.has("cheir") && w.has("passa"));
  assert.ok(!w.has("gabri"), "a name inside a sentence");
  assert.ok(!w.has("novo"), "a common word");
  // a town first in a sentence is a name when the text names it inside a sentence too
  const r = hintRecord("ana", pt("Riverside de novo. Algo me puxa para Riverside, goma."), null);
  assert.ok(r.names.includes("river"));
});

test("anchors: the memory keeps the chapter's last hints and starts over in a new chapter", () => {
  let m = { node: "n2", recent: [] };
  for (let i = 0; i < HINT_MEMORY + 3; i++) m = remember(m, "n2", hintRecord("ana", pt(`linha ${i}`), pt("linha")));
  assert.equal(m.recent.length, HINT_MEMORY);
  m = remember(m, "n3", hintRecord("ana", pt("vapor"), pt("vapor")));
  assert.equal(m.recent.length, 1);
  const sent = [
    { type: "diary_entry", kind: "watch_hint", node: "n2", player: "ana", text: pt("goma quente") },
    { type: "diary_entry", kind: "watch_hint", node: "n1", player: "ana", text: pt("outra coisa") },
    { type: "reaction", id: "x" },
  ];
  assert.equal(memoryFrom("n2", sent).recent.length, 1);
});

test("anchors: a hint must declare its anchor, not the player's last ones, and not lean on worn words", () => {
  let m = { node: "n2", recent: [] };
  const say = (player, text, anchor) => { m = remember(m, "n2", hintRecord(player, pt(text), anchor ? pt(anchor) : null)); };
  say("ana", "Cheiro de goma quente nas ruas, as mãos tremem.", "goma");
  say("bob", "Goma quente outra vez, as mãos ásperas.", "goma");
  say("cid", "Um cheiro de goma quente e algodão.", null);
  say("ana", "As mãos procuram uma linha solta.", "linha");
  const a = adviceFor(m, "ana");
  assert.ok(a.avoid_anchors.includes("goma") && a.avoid_anchors.includes("linha"), JSON.stringify(a));
  assert.ok(a.worn_words.includes("goma") && a.worn_words.includes("quente"));
  assert.match(repeatErrors(pt("Uma agulha no chão."), null, m, "ana")[0], /declare "anchor"/);
  assert.match(repeatErrors(pt("Goma de novo."), pt("goma"), m, "ana").join(" "), /anchor "goma" was used/);
  assert.match(repeatErrors(pt("A agulha e a goma."), pt("agulha"), m, "ana").join(" "), /the text uses "goma"/);
  assert.match(repeatErrors(pt("A agulha, as mãos quentes."), pt("agulha"), m, "ana").join(" "), /worn/);
  assert.deepEqual(repeatErrors(pt("Hoje limpamos duas casas. Mas não é aqui: penso numa agulha esquecida, num número bordado."),
    pt("agulha"), m, "ana"), []);
});
