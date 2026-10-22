import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { TOOLKIT, TOOLKIT_SOUNDS, TOOLKIT_PROMPT, UNTESTED, LOUD_SINGLETONS, gateScore, arrangeScore, beatsToDirectives, splitGap, phaseWindow } from "../src/toolkit.js";
import { finalTaleDirectives } from "../src/finaltale.js";

const GAME_SOUNDS = "E:/SteamLibrary_Main/steamapps/common/ProjectZomboid/media/scripts/generated/sounds";

test("every catalog sound is one of the game's, and only the siren loops", { skip: !existsSync(GAME_SOUNDS) && "no game here" }, () => {
  const src = readdirSync(GAME_SOUNDS, { recursive: true }).filter((f) => String(f).endsWith(".txt"))
    .map((f) => readFileSync(`${GAME_SOUNDS}/${f}`, "utf8")).join("\n");
  for (const s of TOOLKIT_SOUNDS) {
    const at = src.search(new RegExp(`^\\s*sound ${s}\\s*$`, "m"));
    assert.ok(at >= 0, `${s} is not a game sound`);
    const lineEnd = src.indexOf("\n", at + 1);
    const next = src.slice(lineEnd).search(/^\s*sound \w+\s*$/m);
    const body = src.slice(at, next > 0 ? lineEnd + next : at + 1500);
    const loops = /loop\s*=\s*true/.test(body);
    const id = Object.entries(TOOLKIT.effects).find(([, e]) => e.sound === s)[0];
    assert.equal(loops, TOOLKIT.effects[id].loop === true, `${s}: loop flag`);
  }
});

test("the prompt lists what the AI may name, never the bridge's own", () => {
  assert.ok(TOOLKIT_PROMPT.includes("whisper_psst") && !TOOLKIT_PROMPT.includes("ceramic"));
  assert.ok(TOOLKIT_PROMPT.split("\n").length >= 35);
});

test("the gate drops and clamps, never refuses", () => {
  const { score, notes } = gateScore({
    mood: ["dogs"],
    opening: [{ effect: "dog", at: 2 }, { effect: "dragon", at: 1 }, { effect: "rumble", at: 99 }, { effect: "siren_wall", at: 3 },
      { effect: "helicopter", at: 4 }, { effect: "fog_pulse", at: 2, seconds: 30 }, { effect: "static", at: 1, seconds: 50 }],
    between_waves: [{ effect: "explosion", at: 5 }, { effect: "siren_wall", at: 5 }, { effect: "groan", at: 10 }, { effect: "groan", at: 11 },
      { effect: "groan", at: 12 }, { effect: "groan", at: 13 }],
    last_wave: "loud",
    end: [{ effect: "owl" }],
    weather: "hail",
  }, { waveSeconds: 60 });
  const ids = (p) => score[p].map((b) => b.effect);
  assert.ok(!ids("opening").includes("dragon"), "unknown dropped");
  assert.equal(score.opening.find((b) => b.effect === "rumble").at, 18, "at clamped into the window");
  assert.ok(!ids("opening").includes("helicopter"), "one loud cue in the whole score");
  assert.ok(!ids("opening").includes("fog_pulse"), "untested effects wait");
  assert.equal(score.opening.find((b) => b.effect === "static").seconds, 10, "params clamped");
  assert.ok(!ids("between_waves").includes("explosion") && !ids("between_waves").includes("siren_wall"), "nothing loud between waves");
  assert.equal(ids("between_waves").filter((x) => x === "groan").length, 3, "max per effect");
  assert.deepEqual(score.last_wave, [], "a phase that is not a list is empty");
  assert.deepEqual(score.end, [], "a beat without a time is dropped");
  assert.equal(score.weather, undefined);
  assert.ok(notes.length >= 8);
  assert.equal(gateScore("loud").score, null);
  const crowd = gateScore({ opening: [0, 0, 0, 0, 0].map(() => ({ effect: "scream", at: 0 })) }).score.opening;
  assert.ok(crowd.length === 4 && crowd[3].at === 2, "at most three beats in two seconds: the rest move later");
  assert.ok(!gateScore({ last_wave: [{ effect: "window", at: 1 }] }, { placeKind: "cemetery" }).score.last_wave.length, "no window on a cemetery");
});

test("the arranger: seeded, full, within every limit", () => {
  const a = arrangeScore(null, { seed: "s1|1|b_1_1", waveSeconds: 77, gaps: 4 });
  assert.deepEqual(a, arrangeScore(null, { seed: "s1|1|b_1_1", waveSeconds: 77, gaps: 4 }), "the same urn sounds the same");
  assert.notDeepEqual(a.opening, arrangeScore(null, { seed: "s1|1|b_2_2", waveSeconds: 77, gaps: 4 }).opening, "two urns differ");
  for (let n = 0; n < 40; n++) {
    const s = arrangeScore(null, { seed: `x${n}`, waveSeconds: 50, gaps: 4 });
    assert.ok(s.opening.length >= 6 && s.opening.length <= 8, `opening ${s.opening.length}`);
    assert.ok(s.opening.some((b) => b.effect === "rumble"), "the world answers");
    assert.ok(s.gaps.every((g) => g.length >= 2 && g.length <= 4), "each gap 2 to 4");
    assert.ok(s.last_wave.length >= 4 && s.last_wave.length <= 6);
    assert.ok(s.end.length <= 3);
    const all = [...s.opening, ...s.gaps.flat(), ...s.last_wave, ...s.end];
    const count = {};
    for (const b of all) count[b.effect] = (count[b.effect] || 0) + 1;
    for (const [id, c] of Object.entries(count)) assert.ok(c <= TOOLKIT.effects[id].max, `${id} ${c} > max`);
    assert.ok(all.filter((b) => LOUD_SINGLETONS.has(b.effect)).length <= 1, "one loud cue at most");
    assert.ok(!all.some((b) => b.effect === "siren_wall"), "no siren from the pools (Teko)");
    assert.ok(!all.some((b) => UNTESTED.has(b.effect)), "untested effects are not drawn");
    assert.ok(new Set(s.gaps.map((g) => JSON.stringify(g))).size === s.gaps.length, "no two gaps alike");
  }
  // tested fog: never in two gaps in a row
  for (let n = 0; n < 40; n++) {
    const s = arrangeScore(null, { seed: `f${n}`, waveSeconds: 60, gaps: 4, tested: ["fog_pulse", "darken"] });
    for (let i = 1; i < s.gaps.length; i++) {
      assert.ok(!(s.gaps[i].some((b) => b.effect === "fog_pulse") && s.gaps[i - 1].some((b) => b.effect === "fog_pulse")), "fog not twice in a row");
    }
  }
  // the AI's bank is dealt in rotation
  const bank = ["owl", "rats_wall", "claw_wood", "whisper_hey"].map((effect, i) => ({ effect, at: 5 + i }));
  const dealt = arrangeScore({ between_waves: bank }, { seed: "k", waveSeconds: 60, gaps: 2 });
  assert.ok(dealt.gaps[0].some((b) => b.effect === "owl") && dealt.gaps[0].some((b) => b.effect === "claw_wood"));
  assert.ok(dealt.gaps[1].some((b) => b.effect === "rats_wall") && dealt.gaps[1].some((b) => b.effect === "whisper_hey"));
  assert.ok(phaseWindow("between_waves", 60) === 50);
});

test("beats become directives; an older mod gets only what it can do", () => {
  const beats = [{ effect: "groan", at: 5 }, { effect: "window", at: 3, count: 2 }, { effect: "fog_pulse", at: 2, seconds: 20, intensity: 0.5 },
    { effect: "lights_out", at: 1, times: 3 }];
  const now = beatsToDirectives(beats, { idOf: (i) => `b${i}`, urn: [1, 2], building: "b_1_2" });
  assert.deepEqual(now.map((d) => d.type), ["play_sound", "smash_window", "climate_pulse", "lights_flicker"]);
  assert.equal(now[0].delay, 5);
  assert.equal(now[1].delay, 3, "a world beat waits in the queue");
  assert.equal(now[2].kind, "fog");
  const old = beatsToDirectives(beats.slice(0, 2), { idOf: (i) => `b${i}`, urn: [1, 2], building: "b_1_2", modVersion: "0.1.0" });
  assert.equal(old[1].delay, undefined, "an older mod lands it at the step itself");
  assert.equal(beatsToDirectives([{ effect: "alarm", at: 0 }], { idOf: () => "a", building: null }).length, 0, "no building, no alarm");
  const [first, second] = splitGap([{ effect: "dog", at: 10 }, { effect: "owl", at: 40 }], 60);
  assert.ok(first.length === 1 && second.length === 1 && second[0].at === 40);
  const old2 = arrangeScore(null, { seed: "o", gaps: 3, modVersion: "0.1.0", tested: ["fog_pulse", "darken"] });
  assert.ok(![...old2.opening, ...old2.gaps.flat()].some((b) => ["fog_pulse", "darken", "lights_out"].includes(b.effect)), "an older mod is never sent them");
});

test("the Final Tale's night: two places differ, a cemetery has no building effects", () => {
  const seqOf = (place) => finalTaleDirectives({ place, packer: "ana" }).find((d) => d.id === "final_filled").then[0];
  const a = seqOf({ id: "b_5_5", x: 9, y: 9, kind: "church" });
  const b = seqOf({ id: "b_7_7", x: 9, y: 9, kind: "church" });
  assert.notDeepEqual(a.steps[0].then.map((d) => d.sound), b.steps[0].then.map((d) => d.sound), "each place opens its own way");
  const cem = seqOf({ id: "cem_1_1", kind: "cemetery", cell: [1, 1], x: 300, y: 300 });
  const types = cem.steps.flatMap((s) => s.then.map((d) => d.type));
  assert.ok(!types.includes("set_alarm") && !types.includes("smash_window") && !types.includes("lights_flicker"));
  assert.ok(cem.steps.length <= 12);
  for (const st of cem.steps) for (const d of st.then) if (d.delay !== undefined) assert.ok(d.delay >= 0 && d.delay <= 45, `${d.id} delay ${d.delay}`);
});
