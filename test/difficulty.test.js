import test from "node:test";
import assert from "node:assert/strict";
import { tier, waveParams, FINAL_TIER, TIER_FRACTION } from "../src/difficulty.js";
import { finaleSequence } from "../src/finale.js";
import { finalTaleDirectives } from "../src/finaltale.js";

const ORDER = ["final", "red", "yellow", "green"];

test("the Final Tale is the top of the table and every story difficulty is a fraction of it", () => {
  assert.deepEqual(tier("final"), { name: "final", ...FINAL_TIER });
  for (let i = 1; i < ORDER.length; i++) {
    const harder = tier(ORDER[i - 1]), easier = tier(ORDER[i]);
    assert.ok(TIER_FRACTION[ORDER[i]] < TIER_FRACTION[ORDER[i - 1]], `${ORDER[i]} is a smaller fraction`);
    assert.ok(easier.per_player < harder.per_player && easier.min < harder.min && easier.max < harder.max, `${ORDER[i]}: fewer dead than ${ORDER[i - 1]}`);
    assert.ok(easier.wave_seconds > harder.wave_seconds, `${ORDER[i]}: slower than ${ORDER[i - 1]}`);
    easier.lure_reach.forEach((r, k) => assert.ok(r < harder.lure_reach[k], `${ORDER[i]}: a shorter call in third ${k + 1}`));
  }
});

test("every tier stays inside what the mod accepts", () => {
  for (const name of ORDER) {
    const t = tier(name);
    assert.ok(t.per_player >= 1 && t.per_player <= 30, `${name} per_player`);
    assert.ok(t.min >= 0 && t.max <= 50 && t.min <= t.max, `${name} min/max`);
    assert.ok(t.wave_seconds >= 10 && t.wave_seconds <= 600, `${name} interval`);
    assert.equal(t.lure_reach.length, 3);
    assert.ok(t.lure_reach.every((r) => r >= 10 && r <= 200), `${name} reaches`);
    assert.ok(t.lure_reach[0] > t.lure_reach[1] && t.lure_reach[1] > t.lure_reach[2], `${name}: the call pulls inward`);
  }
  assert.equal(tier("purple").name, "yellow", "an unknown difficulty is yellow");
});

test("each urn's waves carry its difficulty: a story's colour, the Final Tale the top", () => {
  const nodes = [{ node: "n1", ids: ["a"] }, { node: "n2", ids: ["b"] }];
  const fin = { lines: { hush: "h", scream: "s", last_wave: "l", silence: "x" }, weather: "fog" };
  for (const color of ["red", "yellow", "green"]) {
    const seq = finaleSequence({ bible: { difficulty: { color } }, fin, urnCenter: [1, 2], urnBuilding: "b_1_2", nodes, reward: [], epilogue: { en: "e" } });
    const wave = seq.steps.flatMap((s) => s.then).find((d) => d.type === "spawn_wave");
    assert.deepEqual({ per_player: wave.per_player, min: wave.min, max: wave.max, lure_period: wave.lure_period, lure_reach: wave.lure_reach },
      (({ factor, ...p }) => p)(waveParams(color)), color);
    assert.equal(wave.factor, 1, "the colour is folded into the numbers");
  }
  const ft = finalTaleDirectives({ place: { id: "b_1_1", x: 5, y: 5, name: "X" }, packer: "ana" }).find((d) => d.id === "final_filled").then[0];
  const fw = ft.steps.flatMap((s) => s.then).find((d) => d.type === "spawn_wave");
  assert.equal(fw.per_player, FINAL_TIER.per_player);
  assert.deepEqual(fw.lure_reach, FINAL_TIER.lure_reach);
  assert.equal(fw.lure_period, FINAL_TIER.wave_seconds);
});
