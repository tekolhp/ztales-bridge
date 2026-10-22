/**
 * What the mod understands. Mirrors ZTales_Inbox.lua (KNOWN) and ZTales_Reactions.lua (EVENTS);
 * test/protocol.test.js reads those Lua files and fails when the lists drift apart.
 */
import { TOOLKIT_SOUNDS } from "./toolkit.js";

export const DIRECTIVE_TYPES = new Set([
  "place_item", "write_note", "write_map", "spawn_zombie", "spawn_corpse",
  "lock_door", "unlock_door", "smash_window", "barricade", "world_sound",
  "set_alarm", "weather", "chat", "define_zone", "set_node",
  "journal_status", "season_complete", "diary_entry",
  "grant_page", "close_chapter", "signal", "reaction", "diary_echo", "radio_static",
  // the finale (docs/10): written by the bridge from a fixed template, never by the AI
  "charge_pieces", "spawn_urn", "open_urn", "sequence", "spawn_wave", "play_sound", "lightning",
  "season_open",
  // the urn's score (docs/12): fog or darkness that comes and goes, the building's lights
  "climate_pulse", "lights_flicker",
]);

export const REACTION_EVENTS = new Set([
  "item_picked", "note_read", "container_opened", "zombie_killed",
  "zone_entered", "player_died", "player_spawned", "journal_entry",
  "page_granted", "node_changed", "signal", "urn_piece", "urn_filled",
]);

/** Actions that happen at one spot: their target radius stays within a few tiles (docs/04, radius by scale). */
export const FOCAL_TYPES = new Set([
  "place_item", "write_note", "write_map", "spawn_corpse", "lock_door", "unlock_door",
  "smash_window", "barricade", "set_alarm",
]);
export const FOCAL_MAX_RADIUS = 3;

export const CHAT_MAX_CHARS = 240;
/** Finale directives the bridge writes itself; an AI answer carrying one is refused (docs/10). */
export const BRIDGE_ONLY_TYPES = new Set(["charge_pieces", "spawn_urn", "open_urn", "sequence", "spawn_wave", "play_sound", "lightning",
  "climate_pulse", "lights_flicker"]);
/** Sounds a play_sound may name: the toolkit's (docs/12, toolkit.js) and the radio ones. The mod's
 *  D.SOUNDS and the client's SOUNDS_OK hold the same names (test/protocol.test.js). */
export const SOUND_WHITELIST = new Set([...TOOLKIT_SOUNDS, "RadioStatic", "TelevisionStatic"]);
/** A directive's `delay`: seconds into its step (the mod's client and pending queue honor it). */
export const DELAY_MAX_SEC = 45;
/** Mood stats a charged piece may press on (docs/10 2.1), by the AI's names. */
export const CHARGE_STATS = new Set(["panic", "stress", "unhappiness", "fatigue", "anger"]);
/** The dream on page one of a new life: a few lines, never a page of plot. */
export const ECHO_MAX_CHARS = 700;

/** Fields a player reads. Each may be a string or { lang: text } (docs/05, each player's language). */
export const TEXT_FIELDS = ["text", "title", "prompt", "epilogue", "server_line"];

/** Outbox files the bridge consumes and deletes. */
export const OUTBOX_CONSUMED = /^(events|journal)-[\w-]+\.json$/;
export const INBOX_DIRECTIVES = /^directives-[\w-]+\.json$/;
