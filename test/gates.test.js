import { test } from "node:test";
import assert from "node:assert/strict";
import { gateBatch, missingCoverage, ensureChapterEnds, fixUnreadable, readableItem, storyItems, fixSetNodes, duplicatePieces,
  splitStall, STALL_REPEATS } from "../src/gates.js";
import { chapterEndDirectives, chapterEndTexts, closedChapters, fallbackText } from "../src/chapterend.js";

const chat = (id, text = "The radio crackles.") => ({ id, type: "chat", scope: "server", text });
const reaction = (id, when, then = [chat(`${id}.1`)], extra = {}) => ({ id, type: "reaction", stage: "n2", when, then, ...extra });

test("plain directives pass, unknown types and empty chat do not", () => {
  const g = gateBatch([chat("d1"), { id: "d2", type: "teleport_player" }, { id: "d3", type: "chat", text: " " }]);
  assert.deepEqual(g.accepted.map((d) => d.id), ["d1"]);
  assert.deepEqual(g.rejected.map((r) => r.id), ["d2", "d3"]);
});

test("ids are never repeated, within a batch or against what was sent", () => {
  const g = gateBatch([chat("d1"), chat("d1"), chat("d9")], { pushedIds: new Set(["d9"]) });
  assert.equal(g.accepted.length, 1);
  assert.match(g.rejected[0].reason, /duplicate/);
  assert.match(g.rejected[1].reason, /already sent/);
});

test("focal actions are clamped to a few tiles, with a note", () => {
  const d = { id: "p1", type: "place_item", item: "ZTales.NoteRed", target: { building: "b_1_1", radius: 40 } };
  const g = gateBatch([d]);
  assert.equal(g.accepted[0].target.radius, 3);
  assert.match(g.notes[0], /clamped/);
  const z = { id: "z1", type: "spawn_zombie", outfit: "Fireman", target: { building: "b_1_1", radius: 40 } };
  assert.equal(gateBatch([z]).accepted[0].target.radius, 40, "a wandering zombie may be placed wide");
});

test("no links, no overlong chat", () => {
  const g = gateBatch([chat("c1", "see www.example.com"), chat("c2", "x".repeat(241))]);
  assert.equal(g.accepted.length, 0);
});

test("leak check: a later node's names cannot appear early", () => {
  const g = gateBatch([chat("c1", "Dalton Keane was here.")], { forbidden: ["Dalton Keane"] });
  assert.match(g.rejected[0].reason, /before its time/);
});

test("reactions: event, then, once and story ids are checked", () => {
  const known = new Set(["n2_key"]);
  const ok = reaction("r1", { event: "item_picked", story_id: "n2_key" });
  const badEvent = reaction("r2", { event: "nonsense" });
  const nested = reaction("r3", { event: "signal", name: "stall", step: 1 }, [reaction("r3.1", { event: "signal" })]);
  const ghost = reaction("r4", { event: "item_picked", story_id: "nobody_has_this" });
  const badOnce = reaction("r5", { event: "signal", name: "x" }, undefined, { once: "always" });
  const innerBad = reaction("r6", { event: "signal", name: "y" }, [{ id: "r6.1", type: "chat", text: "" }]);
  const g = gateBatch([ok, badEvent, nested, ghost, badOnce, innerBad], { knownStoryIds: known });
  assert.deepEqual(g.accepted.map((d) => d.id), ["r1"]);
  assert.equal(g.rejected.length, 5);
});

test("ids inside a reaction count against duplicates", () => {
  const g = gateBatch([reaction("r1", { event: "signal", name: "a" }, [chat("x")]), chat("x")]);
  assert.equal(g.accepted.length, 1);
  assert.match(g.rejected[0].reason, /duplicate id x/);
});

test("coverage: a stage is complete only with every piece, its closing and four stall steps", () => {
  const stage = { id: "n2", pieces: [{ story_id: "n2_key" }, { story_id: "n2_note" }] };
  const rs = [
    // the pieces as things in the world (rule 2, docs/10): one placed, one on a corpse
    { id: "p1", type: "place_item", story_id: "n2_key", item: "ZTales.KeyYellow", target: { building: "b_1_1" } },
    { id: "p2", type: "spawn_corpse", target: { building: "b_1_1" }, inventory: [{ item: "ZTales.NoteYellow", story_id: "n2_note" }] },
    reaction("a", { event: "item_picked", story_id: "n2_key" }),
    reaction("b", { event: "node_changed", from: "n2" }),
    ...[1, 2, 3].map((s) => reaction(`s${s}`, { event: "signal", name: "stall", step: s })),
  ];
  assert.deepEqual(missingCoverage(stage, rs), ["piece n2_note", "stall step 4"]);
  rs.push(reaction("c", { event: "note_read", story_id: "n2_note" }), reaction("s4", { event: "signal", name: "stall", step: 4 }));
  assert.deepEqual(missingCoverage(stage, rs), []);
  // a piece that is only a reaction, never an item: refused by name
  const noItem = rs.filter((d) => d.id !== "p2");
  assert.deepEqual(missingCoverage(stage, noItem), ["piece n2_note has no item placed in the world"]);
  // a declared supply must be placed too, in full
  const withSupply = { ...stage, supplies: [{ item: "Base.CannedBeans", count: 2 }] };
  assert.deepEqual(missingCoverage(withSupply, rs), ["supply Base.CannedBeans x2 (placed 0)"]);
  rs.push({ id: "sup", type: "place_item", item: "Base.CannedBeans", count: 2, target: { building: "b_1_1" } });
  assert.deepEqual(missingCoverage(withSupply, rs), []);
});

test("languages: with players in two languages, every text they read must hold both", async () => {
  const { missingLanguages } = await import("../src/gates.js");
  const langs = ["pt-br", "en"];
  const g = gateBatch([
    { id: "a", type: "chat", scope: "server", text: { en: "Static.", "pt-br": "Chiado." } },
    { id: "b", type: "chat", scope: "server", text: "Static." },
    { id: "c", type: "write_note", text: { en: "Seven." }, title: { en: "page", "pt-br": "página" } },
  ], { languages: langs });
  assert.deepEqual(g.accepted.map((d) => d.id), ["a"]);
  assert.match(g.rejected[0].reason, /text lacks pt-br, en/);
  assert.match(g.rejected[1].reason, /text lacks pt-br/);
  assert.deepEqual(missingLanguages("plain", ["en"]), [], "one language: a plain string is fine");
  assert.equal(gateBatch([{ id: "d", type: "chat", scope: "server", text: { en: "x".repeat(241), "pt-br": "ok" } }],
    { languages: langs }).accepted.length, 0, "the longest version counts for the chat cap");
});

test("item names start with a capital, in every language", () => {
  const g = gateBatch([{ id: "p", type: "place_item", item: "ZTales.PhotoYellow", target: { x: 1, y: 1 },
    title: { en: "photo of a woman at a radio", "pt-br": "foto de uma mulher num rádio" } }]);
  assert.deepEqual(g.accepted[0].title, { en: "Photo of a woman at a radio", "pt-br": "Foto de uma mulher num rádio" });
});

test("a stage must lead on: set_node to the next node, or season_complete on the last", () => {
  const r = (then) => ({ id: "r", type: "reaction", stage: "n1", when: { event: "item_picked", story_id: "a" }, then });
  const base = (extra) => [{ id: "pa", type: "place_item", story_id: "a", item: "ZTales.NoteYellow", target: { building: "b_1_1" } },
    r([{ id: "c", type: "chat", text: "x" }, ...extra]),
    { id: "cl", type: "reaction", stage: "n1", when: { event: "node_changed", from: "n1" }, then: [{ id: "c2", type: "chat", text: "x" }] },
    ...[1, 2, 3, 4].map((s) => ({ id: `s${s}`, type: "reaction", stage: "n1", when: { event: "signal", name: "stall", step: s }, then: [{ id: `s${s}.1`, type: "chat", text: "x" }] }))];
  const stage = { id: "n1", pieces: [{ story_id: "a" }], next: "n2" };
  assert.match(missingCoverage(stage, base([])).join(";"), /moves the story on \(set_node to n2\)/);
  assert.deepEqual(missingCoverage(stage, base([{ id: "m", type: "set_node", node: "n2" }])), []);
  const last = { id: "n1", pieces: [{ story_id: "a" }], final: true };
  assert.match(missingCoverage(last, base([])).join(";"), /ends the story/);
  assert.deepEqual(missingCoverage(last, base([{ id: "e", type: "season_complete", epilogue: "x" }])), []);
});

test("a chapter closing or page without its chapter takes the node (the AI names the node)", () => {
  const out = gateBatch([
    { id: "r1", type: "reaction", stage: "n1", when: { event: "item_picked" }, then: [
      { id: "r1.1", type: "close_chapter", player: "$player", node: "n1" },
      { id: "r1.2", type: "grant_page", player: "$player" },
    ] },
  ]);
  assert.equal(out.rejected.length, 0, JSON.stringify(out.rejected));
  const then = out.accepted[0].then;
  assert.equal(then[0].chapter, "n1");
  assert.equal(then[1].chapter, "n1", "a page in a reaction staged on n1 belongs to n1");
});

test("every chapter ends with its closing and a titled page, even when the AI forgets them", () => {
  const T = { en: "The Annex", "pt-br": "O Anexo" };
  const dirs = [
    { id: "r1", type: "reaction", stage: "n2", when: { event: "item_picked" }, then: [{ id: "r1.1", type: "set_node", node: "n3" }] },
    { id: "r2", type: "reaction", stage: "n2", when: { event: "note_read" }, then: [{ id: "r2.1", type: "close_chapter", chapter: "n2" }, { id: "r2.2", type: "grant_page", player: "$player", chapter: "n2" }] },
    { id: "r3", type: "reaction", stage: "n2", when: { event: "zone_entered" }, then: [{ id: "r3.1", type: "chat", text: "x" }] },
  ];
  ensureChapterEnds(dirs, { id: "n2", title: T });
  for (const r of dirs.slice(0, 2)) {
    const close = r.then.find((t) => t.type === "close_chapter");
    const page = r.then.find((t) => t.type === "grant_page");
    assert.ok(close && page, `${r.id} closes and gives a page`);
    assert.equal(close.chapter, "n2");
    assert.deepEqual(close.title, T, "titled from the bible");
  }
  assert.equal(dirs[2].then.length, 1, "a reaction that does not end the chapter is left alone");
});

// live AI run 2026-10-22: chapter 2's closing waited for the walkie to be read; a walkie is never
// read, only the chat on item_picked fired, and the story stood still
test("a reaction waiting for a piece nobody can read waits for it to be picked up instead", () => {
  assert.equal(readableItem("ZTales.NoteYellow"), true);
  assert.equal(readableItem("ZTales.PhotoRed"), true);
  assert.equal(readableItem("ZTales.WalkieYellow"), false);
  assert.equal(readableItem("ZTales.PartAGreen"), false);
  assert.equal(readableItem("Base.Notebook"), null, "not ours: left alone");
  const dirs = [
    { id: "s2_walkie", type: "place_item", story_id: "n2_walkie", item: "ZTales.WalkieYellow", target: { building: "b_1" } },
    { id: "s2_note", type: "write_note", story_id: "n2_note", text: "x", target: { building: "b_2" } },
    { id: "s2_key", type: "spawn_zombie", inventory: [{ item: "ZTales.KeyYellow", story_id: "n2_key" }], target: { building: "b_3" } },
    reaction("r_n2_walkie", { event: "note_read", story_id: "n2_walkie" }, [{ id: "r_n2_walkie.1", type: "set_node", node: "n3" }]),
    reaction("r_n2_walkie_pick", { event: "item_picked", story_id: "n2_walkie" }),
    reaction("r_n2_note", { event: "note_read", story_id: "n2_note" }),
    reaction("r_n2_key", { event: "note_read", story_id: "n2_key" }),
    reaction("r_old", { event: "note_read", story_id: "n1_photo" }),
  ];
  const itemOf = storyItems(dirs, storyItems([{ type: "place_item", story_id: "n1_photo", item: "ZTales.PhotoYellow" }]));
  const notes = fixUnreadable(dirs, itemOf);
  const when = Object.fromEntries(dirs.filter((d) => d.type === "reaction").map((r) => [r.id, r.when.event]));
  assert.deepEqual(when, { r_n2_walkie: "item_picked", r_n2_walkie_pick: "item_picked", r_n2_note: "note_read", r_n2_key: "item_picked", r_old: "note_read" });
  assert.equal(notes.length, 2);
  assert.match(notes[0], /r_n2_walkie: waits for item_picked \(n2_walkie is a ZTales.WalkieYellow/);
});

// live run 2026-10-22: the last chapter's reaction sent set_node "urn"
test("a set_node outside the axis goes to the next chapter, or is dropped on the last", () => {
  const axis = new Set(["n1", "n2"]);
  const mid = [reaction("r", { event: "item_picked", story_id: "a" }, [{ id: "r.1", type: "set_node", node: "urn" }]), { id: "top", type: "set_node", node: "n9" }];
  const notes = fixSetNodes(mid, axis, { id: "n1", next: "n2" });
  assert.equal(mid[0].then[0].node, "n2");
  assert.equal(mid[1].node, "n2");
  assert.equal(notes.length, 2);
  const last = [reaction("r", { event: "item_picked", story_id: "b" }, [chat("r.0"), { id: "r.1", type: "set_node", node: "urn" }]), { id: "top", type: "set_node", node: "urn" }];
  fixSetNodes(last, axis, { id: "n2", next: null, final: true });
  assert.deepEqual(last.map((d) => d.id), ["r"], "a top-level one is taken out");
  assert.deepEqual(last[0].then.map((t) => t.id), ["r.0"]);
  const ok = [reaction("r", { event: "item_picked", story_id: "a" }, [{ id: "r.1", type: "set_node", node: "n2" }])];
  assert.deepEqual(fixSetNodes(ok, axis, { id: "n1", next: "n2" }), []);
});

test("one piece per chapter: a second copy of a piece is refused, the bridge's put-back is not", () => {
  const ids = new Set(["n1_photo"]);
  const place = (id, extra = {}) => ({ id, type: "place_item", story_id: "n1_photo", item: "ZTales.PhotoYellow", target: { building: "b_1" }, ...extra });
  assert.deepEqual(duplicatePieces([place("a")], ids), []);
  assert.deepEqual(duplicatePieces([place("a"), place("b")], ids).map((x) => x.id), ["b"]);
  assert.deepEqual(duplicatePieces([reaction("st", { event: "signal", name: "stall", step: 1 }, [place("st.1")])], ids, [{ story_id: "n1_photo" }]).map((x) => x.id), ["st"],
    "stall help never places the piece again");
  assert.deepEqual(duplicatePieces([place("relost", { relost: true })], ids, [{ story_id: "n1_photo" }]), []);
  assert.deepEqual(duplicatePieces([{ id: "z", type: "spawn_zombie", inventory: [{ item: "ZTales.PhotoYellow", story_id: "n1_photo" }] }], ids, [{ story_id: "n1_photo" }]).map((x) => x.id), ["z"]);
});

test("stall help is split: the world once, what everyone hears each cycle, what a player is told each player each cycle", () => {
  const list = [
    reaction("s1", { event: "signal", name: "stall", step: 1 }, [
      { id: "s1.1", type: "place_item", item: "ZTales.NoteYellow", target: { building: "b_1" } },
      chat("s1.2"),
      { id: "s1.3", type: "diary_entry", player: "$player", text: "x" },
    ], { once: "server" }),
    reaction("s2", { event: "signal", name: "stall", step: 2 }, [chat("s2.1")]),
    reaction("other", { event: "item_picked", story_id: "a" }),
  ];
  const notes = splitStall(list);
  const by = Object.fromEntries(list.map((r) => [r.id, r]));
  assert.deepEqual(list.map((r) => r.id), ["s1", "s1~r", "s1~p", "s2", "other"]);
  assert.deepEqual([by.s1.once, by.s1.when.per, by.s1.then.map((t) => t.id)], ["server", "server", ["s1.1"]]);
  assert.deepEqual([by["s1~r"].once, by["s1~r"].when.per, by["s1~r"].then.map((t) => t.id)], [STALL_REPEATS, "server", ["s1.2"]]);
  assert.deepEqual([by["s1~p"].once, by["s1~p"].when.per, by["s1~p"].then.map((t) => t.id)], ["player", "player", ["s1.3"]]);
  assert.equal(by["s1~p"].when.step, 1);
  assert.deepEqual([by.s2.once, by.s2.when.per], [STALL_REPEATS, "server"], "a chat alone repeats every cycle under the AI's id");
  assert.equal(by.other.when.per, undefined);
  assert.equal(notes.length, 2);
  assert.deepEqual(splitStall(list), [], "already split: left alone");
  assert.equal(list.length, 5);
  // the coverage still sees every step
  const cov = missingCoverage({ id: "n2", pieces: [], stall_steps: 2 }, [...list, reaction("c", { event: "node_changed", from: "n2" })]);
  assert.deepEqual(cov, []);
});

test("the chapter's end: who found it, who took part, who heard, and everyone's mark", () => {
  const events = [
    { type: "item_picked", story_id: "x_clue", player: "bob" },
    { type: "item_picked", story_id: "n1_photo", player: "ana" },
    { type: "node_changed", from: "n1", to: "n2" },
    { type: "node_changed", from: "n2", to: "n3" },
    { type: "node_changed", from: "", to: "n1" },
  ];
  const pbn = [{ node: "n1", ids: ["n1_photo"] }, { node: "n2", ids: ["n2_key"] }, { node: "n3", ids: ["n3_tape"] }];
  assert.deepEqual(closedChapters(events, pbn, "s1"), [{ node: "n1", finder: "ana" }, { node: "n2", finder: null }]);
  assert.deepEqual(closedChapters(events, pbn, "s1", ["s1:n1"]), [{ node: "n2", finder: null }], "once per chapter");
  assert.deepEqual(closedChapters([{ type: "node_changed", from: "n3", to: "urn" }], pbn, "s1"), [], "the last chapter ends at the urn");
  const dirs = chapterEndDirectives({ season: "s1", node: "n1", finder: "ana", near: ["ana", "bob"], seen: ["ana", "bob", "cid"],
    texts: { record: null, echo: { en: "heard" }, title: { en: "The Count", "pt-br": "A Contagem" } }, languages: ["en", "pt-br"] });
  assert.deepEqual(dirs.map((d) => [d.id, d.player]), [["s1_end_n1_rec_bob", "bob"], ["s1_end_n1_echo_cid", "cid"], ["s1_end_n1_mark", "$all"]]);
  assert.deepEqual(dirs[0].text, fallbackText("record", ["en", "pt-br"]), "no record written: the bridge's line");
  assert.match(dirs[2].text["pt-br"], /A Contagem/);
  assert.match(dirs[2].text.en, /The Count/);
  assert.equal(gateBatch(dirs).rejected.length, 0);
  // the AI's lines: every language, short, no link, no name kept for later
  const L = ["en", "pt-br"];
  assert.deepEqual(chapterEndTexts({ record: { en: "a", "pt-br": "b" }, echo: { en: "only english" } }, L), { record: { en: "a", "pt-br": "b" }, echo: null });
  assert.equal(chapterEndTexts({ echo: { en: "Dalton was here", "pt-br": "Dalton" } }, L, ["Dalton"]).echo, null);
  assert.equal(chapterEndTexts({ echo: { en: "x".repeat(500), "pt-br": "y" } }, L).echo, null);
});

test("a forbidden word is looked for in what players read, never in ids or event names", () => {
  const out = gateBatch([
    { id: "r_n1_stall1", type: "reaction", stage: "n1", when: { event: "signal", name: "stall", step: 1 },
      then: [{ id: "r_n1_stall1.1", type: "chat", text: { en: "Something moves.", "pt-br": "Algo se mexe." } }] },
    { id: "r2", type: "reaction", stage: "n1", when: { event: "item_picked" },
      then: [{ id: "r2.1", type: "chat", text: { en: "The stall keeper knew.", "pt-br": "O dono da banca sabia." } }] },
  ], { forbidden: ["stall"] });
  assert.deepEqual(out.rejected.map((r) => r.id), ["r2"], "only the text that names it");
});
