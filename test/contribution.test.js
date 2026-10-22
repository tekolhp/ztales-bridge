import { test } from "node:test";
import assert from "node:assert/strict";
import { notePages, readContributions, planExtras, checkExtraChapter, scoreMin } from "../src/contribution.js";
import { modelFor } from "../src/models.js";

const FAMILIES = ["Note", "Map", "Key", "Photo", "Cassette", "VHS", "Walkie", "PartA", "PartB", "PartC"];

test("chapter pages are kept until scored, per story", () => {
  const pages = notePages([{ id: "old", player: "x", chapter: "n1", season: "s0" }], [
    { type: "journal", id: "j1", player: "ana", kind: "chapter", chapter: "n1", text: "The number is a time." },
    { type: "journal", id: "j2", player: "ana", kind: "free", text: "Not a page." },
    { type: "journal", id: "j3", player: "bob", kind: "chapter", chapter: "n1", text: "  " },
  ], "s1");
  assert.deepEqual(pages, [{ id: "j1", player: "ana", chapter: "n1", season: "s1" }]);
});

test("a score counts only for a page that reached the AI, 0 to 3, one per chapter", () => {
  const pages = [{ id: "j1", player: "ana", chapter: "n1" }, { id: "j2", player: "bob", chapter: "n2" }];
  assert.deepEqual(readContributions({ player: "ana", score: 3, why: "links" }, pages), [{ player: "ana", chapter: "n1", page: "j1", score: 3, why: "links" }]);
  assert.deepEqual(readContributions({ player: "ana", score: 4 }, pages), []);
  assert.deepEqual(readContributions({ player: "cid", score: 2 }, pages), []);
  assert.equal(readContributions([{ player: "ana", score: 1 }, { player: "bob", score: 2 }, { player: "ana", score: 3 }], pages).length, 2);
  assert.equal(scoreMin(undefined), 3);
  assert.equal(scoreMin(2), 2);
  assert.equal(scoreMin(9), 3);
});

test("the AI decides a chapter's extras when it scored the page; the tally only when it could not", () => {
  const ai = [{ chapter: "n1", player: "ana", score: 3, why: "" }];
  assert.deepEqual(planExtras({ closed: ["n1"], pages: [{ chapter: "n1" }], contribs: ai }).map((p) => [p.chapter, p.by]), [["n1", "ai"]]);
  assert.deepEqual(planExtras({ closed: ["n1"], pages: [{ chapter: "n1" }], contribs: [] }).map((p) => p.by), ["collab"], "page given, no score");
  assert.deepEqual(planExtras({ closed: ["n1"], pages: [], contribs: [] }), [], "the latest chapter's page may still come");
  assert.deepEqual(planExtras({ closed: ["n1", "n2"], pages: [], contribs: [] }).map((p) => p.chapter), ["n1"], "an older one: the page never came");
  assert.deepEqual(planExtras({ closed: ["n1"], pages: [], contribs: [], final: true }).map((p) => p.by), ["collab"], "the last stage call");
  assert.deepEqual(planExtras({ closed: ["n1"], decided: { n1: {} }, pages: [{ chapter: "n1" }], contribs: ai }), [], "once");
});

test("the extra chapter the AI grew: its question in every language; the piece's family, title and building checked", () => {
  const both = (x) => ({ en: x, "pt-br": x });
  const free = new Map([["b_1_1", { id: "b_1_1", rooms: ["kitchen", "bedroom"] }]]);
  const ctx = { languages: ["en", "pt-br"], forbidden: ["Dalton Keane"], axisIds: ["n1", "n2"], freePlaces: free, families: FAMILIES };
  const good = checkExtraChapter({ question: both("Why seven?"), way_back: "n2",
    piece: { item: "ZTales.MapRed", title: both("A folded map"), text: both("Seven."), target: { building: "b_1_1", room: "bedroom" } } }, ctx);
  assert.deepEqual(good.errs, []);
  assert.deepEqual({ ...good.ok, question: null }, { question: null, family: "Map", title: both("A folded map"), text: both("Seven."),
    building: "b_1_1", room: "bedroom", way_back: "n2" });
  const loose = checkExtraChapter({ question: both("Why seven?"), way_back: "urn", piece: { item: "Base.Axe", title: { en: "x" }, target: { building: "b_9_9" } } }, ctx);
  assert.equal(loose.ok.family, "Photo");
  assert.equal(loose.ok.title, null);
  assert.equal(loose.ok.building, null);
  assert.equal(loose.ok.way_back, null);
  assert.equal(loose.errs.length, 4);
  assert.equal(checkExtraChapter({ question: both("Dalton Keane knew.") }, ctx).ok, null);
  assert.equal(checkExtraChapter({ question: both("Go to 10650, 9650.") }, ctx).ok, null);
  assert.equal(checkExtraChapter({ question: { en: "Only English." } }, ctx).ok, null);
  assert.equal(checkExtraChapter(null, ctx).ok, null);
});

test("the watch look runs on the chapter model the owner chose", () => {
  assert.equal(modelFor("watch", "anthropic", { stage: "claude-haiku-5-5", story: "claude-opus-5-5" }, "env"), "claude-haiku-5-5");
  assert.equal(modelFor("watch", "anthropic", { stage: null }, "env"), "env");
});
