import { test } from "node:test";
import assert from "node:assert/strict";
import { kFor, nextCreativity, horizon, makeAllowItem, rewardCandidates } from "../src/loot.js";
import { gateBatch } from "../src/gates.js";

// real values read from the vanilla tables on a test server (2026-10-12)
const P = { "Base.Hammer": 0.00636122, "Base.Axe": 0.00148025, "Base.AssaultRifle": 0.000767634, "Base.Katana": 3.70045e-6,
  "Base.WaterBottle": 0.022469, "Base.WaterBottleFull": 0.02 };

test("horizons keep the game's order: hammer, axe, rifle, katana", () => {
  const hs = ["Base.Hammer", "Base.Axe", "Base.AssaultRifle", "Base.Katana"].map((i) => horizon(P[i]));
  assert.deepEqual([...hs].sort((a, b) => a - b), hs);
});

test("k starts at 3, falls with creativity, never below 1", () => {
  assert.equal(kFor(0), 3);
  assert.equal(kFor(0.5), 2);
  assert.equal(kFor(1), 1);
  assert.equal(kFor(7), 1);
  let c = null;
  for (let i = 0; i < 3; i++) c = nextCreativity(c, 1);
  assert.ok(c < 0.8, "three good windows do not drop k to the floor");
});

test("an item is allowed once opened >= horizon * k; clue items always", () => {
  const allow = makeAllowItem(P, 500, 3);
  assert.equal(allow("Base.Hammer"), true);            // 157 * 3 = 471
  assert.match(allow("Base.Axe"), /horizon 676, opened 500/);
  assert.match(allow("Base.Unknown"), /never found as loot/);
  assert.equal(allow("ZTales.KeyRed"), true);
});

test("the gate rejects a reward too early, with the numbers the AI needs to replan", () => {
  const g = gateBatch([
    { id: "r1", type: "place_item", item: "Base.Katana", target: { x: 1, y: 1 } },
    { id: "r2", type: "spawn_zombie", outfit: "Police", inventory: [{ item: "Base.Hammer" }], target: { x: 1, y: 1 } },
  ], { allowItem: makeAllowItem(P, 500, 3) });
  assert.deepEqual(g.accepted.map((d) => d.id), ["r2"]);
  assert.match(g.rejected[0].reason, /Base.Katana, horizon 270237/);
});

test("rewards offered: only allowed ones, rarest first, one per kind", () => {
  const r = rewardCandidates(P, 2500, 3);
  assert.deepEqual(r.map((x) => x.item), ["Base.Axe", "Base.Hammer", "Base.WaterBottleFull", "Base.WaterBottle"]);
});

test("server loot settings: the lowest multiplier slows every reward; abundant loot never speeds it up", async () => {
  const { lootFactor, scaleLoot } = await import("../src/loot.js");
  assert.equal(lootFactor({ FoodLootNew: 0.6, WeaponLootNew: 0.2, AmmoLootNew: 1.5, CommonLootFactor: 2 }), 0.2);
  assert.equal(lootFactor({ FoodLootNew: 2, WeaponLootNew: 3 }), 1, "generous settings: never more generous than the tables");
  assert.equal(lootFactor({}), 1);
  const scaled = scaleLoot(P, 0.5);
  assert.equal(horizon(scaled["Base.Hammer"]), horizon(P["Base.Hammer"]) * 2);
});
