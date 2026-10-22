/**
 * A scripted "AI" for rehearsals (AI_PROVIDER = "rehearsal"). It receives exactly the context the
 * real AI receives and answers with a short, hand-written two-chapter story (one piece per
 * chapter, docs/13), picking real
 * buildings from the places it was offered by their rooms. Every rule still applies: the answer
 * goes through the same gates as a real one. Never used in production; it costs nothing.
 */

const T = (en, pt) => ({ en, "pt-br": pt });

// How a place reads in a sentence, per language (room types from the catalog).
const PLACE = {
  laundry: ["the laundromat", "a lavanderia"], church: ["the church", "a igreja"], office: ["the office", "o escritório"],
  library: ["the library", "a biblioteca"], lobby: ["that lobby", "aquele saguão"], pharmacy: ["the pharmacy", "a farmácia"],
  medical: ["the clinic", "a clínica"], gasstore: ["the gas station", "o posto"], grocery: ["the grocery", "o mercado"],
};
const place = (b, fallback = ["that place", "aquele lugar"]) => PLACE[(b?.rooms || [])[0]] || fallback;
const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);

/** Keep only the languages in use (a plain map works for one language too). */
function only(langs, v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const out = {};
  for (const l of langs) if (v[l]) out[l] = v[l];
  return Object.keys(out).length ? out : v;
}

function localize(langs, x) {
  if (Array.isArray(x)) return x.map((y) => localize(langs, y));
  if (x && typeof x === "object") {
    if (typeof x.en === "string" && typeof x["pt-br"] === "string") return only(langs, x);
    const o = {};
    for (const [k, v] of Object.entries(x)) o[k] = localize(langs, v);
    return o;
  }
  return x;
}

function pick(places, prefs, used) {
  for (const p of prefs) {
    const hit = places.find((b) => !used.has(b.id) && (b.rooms || []).includes(p));
    if (hit) { used.add(hit.id); return hit; }
  }
  const any = places.find((b) => !used.has(b.id));
  if (any) used.add(any.id);
  return any || null;
}

const clue = (ctx, family) => (ctx.catalog?.clue_items || []).find((i) => i.includes(family)) || `ZTales.${family}Yellow`;

const stall = (node, sfx = "") => [1, 2, 3, 4].map((s) => ({
  id: `rh_${node}_stall${s}${sfx}`, type: "reaction", stage: node, once: "server",
  when: { event: "signal", name: "stall", step: s },
  then: [{ id: `rh_${node}_stall${s}.1${sfx}`, type: "chat", scope: "server", color: "yellow", text: [
    T("Static on the radio, then a woman counting. Eight. Eight. Six.", "Chiado no rádio, depois uma mulher contando. Oito. Oito. Seis."),
    T("Someone painted 88.6 on a mailbox, then painted over it.", "Alguém pintou 88.6 numa caixa de correio, depois cobriu com tinta."),
    T("At seven o'clock every dog in town goes quiet at once.", "Às sete horas todos os cães da cidade se calam ao mesmo tempo."),
    T("A radio left on somewhere nearby. You can almost hear it.", "Um rádio ligado em algum lugar por perto. Quase dá pra ouvir."),
  ][s - 1] }],
}));

function seed(ctx) {
  const places = ctx.catalog?.places || [];
  // a next story in the rehearsal: the same tale, its ids suffixed so nothing repeats
  const n = ctx.state?.story_number || 1;
  const sfx = n > 1 ? `_${n}` : "";
  const used = new Set();
  const a = pick(places, ["laundry", "pharmacy", "medical", "gasstore", "grocery"], used);
  if (!a) return { directives: [], note: "rehearsal: not enough places offered" };
  const bible = {
    season: `rh${n}`, title: n > 1 ? T(`The Seven O'Clock Signal ${n}`, `O Sinal das Sete Horas ${n}`) : T("The Seven O'Clock Signal", "O Sinal das Sete Horas"),
    premise: "Before the phones died on the first of July, a ham operator in Knox County caught a broadcast that counted numbers at seven o'clock. She kept listening after the cordon. She is not the only one who started to.",
    ending: { text: "In the church office the radio is still on, tuned to 88.6. The last page of her log is the same three digits, hundreds of times. The counting voice is hers." },
    forbidden_entities: ["Ruth Calloway", "church office", "her own voice"],
    marks: ["88.6", "seven o'clock", "the counting"],
    difficulty: { color: "yellow" },
    chapters: [{ id: "c1", title: "Eighty-Eight Six", closes_on: "n1" }, { id: "c2", title: "The Radio That Stayed On", closes_on: "n2" }],
    // the finale (docs/10): the urn, what each piece does to its carrier, the event's colour
    finale: {
      rooms_wanted: ["church", "office"],
      urn: { title: T("Clay urn, sealed with wax, lid loose", "Urna de barro, selada com cera, tampa solta") },
      charges: { [`rh_n1_photo${sfx}`]: [{ stat: "unhappiness", level: 1 }], [`rh_n2_radio${sfx}`]: [{ stat: "panic", level: 2 }, { stat: "stress", level: 2 }] },
      weather: "storm", sounds: ["MetaScream", "MetaDogBark"],
      reward: [{ item: "Base.Shotgun", count: 1 }, { item: "Base.ShotgunShellsBox", count: 2 }, { item: "Base.Bag_ALICEpack", count: 1 }],
    },
    axis: [
      { id: "n1", question: "What is 88.6?", anchor: `rh_n1_photo${sfx}`, location_fn: a.rooms?.[0] || "shop",
        pieces: [{ story_id: `rh_n1_photo${sfx}`, item: clue(ctx, "Photo") }] },
      { id: "n2", question: "Who left the radio on?", anchor: `rh_n2_radio${sfx}`, location_fn: "church or office", ending: true,
        pieces: [{ story_id: `rh_n2_radio${sfx}`, item: clue(ctx, "Walkie") }] },
    ],
  };
  const resolved = (who, sid) => [
    { id: `rh_n1_found_${sid}${sfx}.1`, type: "chat", scope: "player", player: "$player", color: "yellow",
      text: T("Eighty-eight point six. You have heard that number before.", "Oitenta e oito ponto seis. Você já ouviu esse número antes.") },
    { id: `rh_n1_found_${sid}${sfx}.2`, type: "grant_page", player: "$player", chapter: "c1",
      title: T("Eighty-Eight Six", "Oitenta e Oito Seis"),
      prompt: T("Write what the number did to you. It is still counting, somewhere behind the wall.",
        "Escreva o que o número fez com você. Ele ainda está contando, em algum lugar atrás da parede.") },
    { id: `rh_n1_found_${sid}${sfx}.3`, type: "set_node", node: "n2" },
  ];
  const directives = [
    { id: `rh_n1_photo${sfx}`, type: "place_item", story_id: `rh_n1_photo${sfx}`, item: clue(ctx, "Photo"), target: { building: a.id },
      title: T("photo of a woman at a radio", "foto de uma mulher num rádio"),
      text: T("On the back: 'R. — 88.6, 7 o'clock, every night since the 1st.'", "No verso: 'R. — 88.6, 7 horas, toda noite desde o dia 1º.'") },
    { id: `rh_n1_pick_photo${sfx}`, type: "reaction", stage: "n1", once: "server", when: { event: "item_picked", story_id: `rh_n1_photo${sfx}` },
      then: resolved("$player", "photo"), reveals: ["f_rh_888"] },
    { id: `rh_n1_close${sfx}`, type: "reaction", stage: "n1", when: { event: "node_changed", from: "n1" },
      then: [{ id: `rh_n1_close.1${sfx}`, type: "close_chapter", chapter: "c1", title: T("Eighty-Eight Six", "Oitenta e Oito Seis"), next: "c2" },
        { id: `rh_n1_close.3${sfx}`, type: "radio_static", scope: "server", seconds: 5 },
        { id: `rh_n1_close.2${sfx}`, type: "chat", scope: "server", color: "yellow",
          text: T("For a moment every radio in the county hisses the same number.", "Por um instante todo rádio do condado chia o mesmo número.") }] },
    ...stall("n1", sfx),
  ];
  return localize(ctx.state?.languages || ["en"], {
    bible, directives,
    // the chapter's end for everyone else (docs/13): a record for those who took part, an echo for the rest
    chapter_end: {
      record: T("I was near when somebody found the photograph. Eighty-eight point six. I caught myself counting on the way back.",
        "Eu estava perto quando alguém achou a fotografia. Oitenta e oito ponto seis. Me peguei contando no caminho de volta."),
      echo: T("Someone found a photo of a woman at a radio, they say. I keep hearing a number I never learned.",
        "Dizem que alguém achou a foto de uma mulher num rádio. Fico ouvindo um número que nunca aprendi."),
    },
    hints: { n1: { full: { text: T(`Someone kept a photo in the ${a.rooms?.[0] || "shop"}. Seven o'clock.`, `Alguém guardou uma foto no(a) ${a.rooms?.[0] || "loja"}. Sete horas.`) },
      echo: { text: "88.6" } },
    openers: { default: [T("Before all this, I was the kind of person who", "Antes de tudo isso, eu era o tipo de pessoa que"),
      T("The last normal thing I remember is", "A última coisa normal de que me lembro é")] } },
    proximity: (() => {
      const [en, pt] = place(a);
      return {
        far: T("That side of town sits wrong with me. It smells the way everything smelled the week the phones died: hot dust, wet paper, something sweet underneath. I washed my hands twice tonight and I can still smell it.",
          "Aquele lado da cidade não me desce. Tem o cheiro que tudo tinha na semana em que os telefones morreram: poeira quente, papel molhado, alguma coisa doce por baixo. Lavei as mãos duas vezes hoje e ainda sinto."),
        mid: T(`${cap(en)} again, behind my eyes. A machine stopped mid-turn, a door left open. Someone left in a hurry and meant to come back for something. I keep counting while I think about it. I don't know what I'm counting.`,
          `${cap(pt)} de novo, atrás dos olhos. Uma máquina parada no meio do giro, uma porta deixada aberta. Alguém saiu às pressas e pretendia voltar por alguma coisa. Fico contando enquanto penso nisso. Não sei o que estou contando.`),
        near: T(`It was there. In ${en}. I walked right past it, and it let me. I've been rubbing my fingers together all evening as if there's something on them I can't see. Seven o'clock came and I was already listening.`,
          `Estava lá. Em ${pt}. Passei bem do lado, e deixou eu passar. Fiquei a noite toda esfregando os dedos, como se tivesse alguma coisa neles que eu não vejo. Deu sete horas e eu já estava escutando.`),
      };
    })(),
    motifs_used: [], creativity_score: 0.4,
  });
}

function stage(ctx) {
  if (ctx.stage?.id !== "n2") return { directives: [] };
  const places = ctx.catalog?.places || [];
  const used = new Set();
  const c = pick(places, ["church", "office", "library", "lobby"], used);
  if (!c) return { directives: [] };
  const directives = [
    { id: "rh_n2_radio", type: "place_item", story_id: "rh_n2_radio", item: clue(ctx, "Walkie"), target: { building: c.id },
      title: T("radio, still warm", "rádio, ainda morno") },
    // the last node does not end the story any more: the urn does (the bridge's template)
    { id: "rh_n2_pick_radio", type: "reaction", stage: "n2", once: "server", when: { event: "item_picked", story_id: "rh_n2_radio" },
      then: [{ id: "rh_n2_radio.1", type: "chat", scope: "player", player: "$player", color: "yellow",
        text: T("The dial is stuck on 88.6. It is still warm. You know where it has to go.", "O dial está travado em 88.6. Ainda está morno. Você sabe para onde ele tem que ir.") }],
      reveals: ["f_rh_end"] },
    { id: "rh_n2_close", type: "reaction", stage: "n2", when: { event: "node_changed", from: "n2" },
      then: [{ id: "rh_n2_close.1", type: "close_chapter", chapter: "c2", title: T("The Radio That Stayed On", "O Rádio Que Ficou Ligado") }] },
    ...stall("n2"),
  ];
  // the finale texts: the nightmare names the urn's place unmistakably, the rest is the event
  const u = ctx.stage?.urn || {};
  const room = (u.rooms || []).find((r) => PLACE[r] && ["church", "office", "library", "lobby"].includes(r)) || (u.rooms || []).find((r) => PLACE[r]);
  const [roomEn, roomPt] = PLACE[room] || ["the last building", "o último prédio"];
  const placeEn = u.name || (u.region ? `${roomEn} in ${u.region}` : `${roomEn} past the last houses`);
  const placePt = u.name || (u.region ? `${roomPt} de ${u.region}` : `${roomPt} depois das últimas casas`);
  const finale = {
    where: T(`I dreamt her hands were mine. I carried the radio and the photograph, all of it, to ${placeEn}, and there was a clay urn on the floor, lid loose, waiting like a mouth. She counted while I put them in. I woke up before the number. I know the way now. I have always known it.`,
      `Sonhei que as mãos dela eram as minhas. Levei o rádio e a foto, tudo, até ${placePt}, e havia uma urna de barro no chão, tampa solta, esperando como uma boca. Ela contava enquanto eu colocava tudo dentro. Acordei antes do número. Agora eu sei o caminho. Sempre soube.`),
    epilogue: T("I am writing this with the lights off. Last night the storm came the moment the urn closed, and then they came, out of the dark from every side, walking straight to it as if someone had called them by name. I do not know how long it lasted. The radios hissed. Something screamed past the houses. One by one the things we found went quiet inside the clay, and when the last one was gone the urn simply opened, like a hand. It is quiet now. I do not trust it. On the way back I passed a window with a candle in it, still burning, in a house where nobody has lived since July. I did not stop. I think I am supposed to.",
      "Escrevo isto com a luz apagada. Ontem à noite a tempestade veio no instante em que a urna fechou, e então eles vieram, do escuro, de todos os lados, andando direto para ela como se alguém os chamasse pelo nome. Não sei quanto tempo durou. Os rádios chiaram. Algo gritou depois das casas. Uma a uma, as coisas que achamos foram se calando dentro do barro, e quando a última se foi a urna simplesmente se abriu, como uma mão. Agora está quieto. Eu não confio nisso. Na volta, passei por uma janela com uma vela acesa, ainda queimando, numa casa onde ninguém mora desde julho. Não parei. Acho que eu devia."),
    // as the urn takes each piece, everyone reads its line
    vanish: {
      rh_n1_photo: T("The woman in the photograph is no longer looking at the camera.", "A mulher da fotografia não olha mais para a câmera."),
      rh_n2_radio: T("A radio somewhere in the county switches itself off.", "Um rádio em algum lugar do condado se desliga sozinho."),
    },
    lines: {
      hush: T("Every radio in the county takes a breath at once.", "Todo rádio do condado prende a respiração ao mesmo tempo."),
      scream: T("Somewhere past the last houses, someone screams the number.", "Em algum lugar depois das últimas casas, alguém grita o número."),
      last_wave: T("They are not coming for you. They are coming for what you carry.", "Eles não vêm atrás de você. Vêm atrás do que você carrega."),
      silence: T("At seven o'clock, the counting stopped.", "Às sete horas, a contagem parou."),
    },
    weather: "storm",
    tale: T("This book has no author. Whoever opens it should know that much before turning the page.\n\nThey say the first week of July had no sound of its own. The phones gave a tone and then nothing, the television showed a still image of a flag, and the county learned to listen to what was left. On the eighty-eight point six, between one hiss and another, there was a voice.\n\nIt counted.\n\nNot to a hundred, not backwards. It counted the way someone counts the steps of a staircase in the dark: slowly, as if the next number could be missing. And it always began at seven.\n\nA woman listened. Her name does not matter here; what matters is that she wrote. Every night, in the same tired hand, the same numbers, one under the other, until the paper ran out and she wrote on the back. Beside the set she left a photograph of herself, as if she needed proof that she had been in that room. \"She counts,\" says the only page that came loose from the log, \"and I write it down, and I do not know why.\"\n\nThen the voice came closer.\n\nNo one carried the radio out of her house. And yet it was found far away, in a room no one used, with the dial stuck and the casing warm, as if it had been switched off a minute before. In a kitchen, a tape waited with a label written in pencil: seven at night. On the tape, the same woman, very calm, says only this: \"If you are hearing this, you are already counting.\"\n\nThose who found the pieces did not know one another. Each carried a part without knowing it was a part. Some slept badly. Some heard their own name inside the hiss. All of them, at some point, caught themselves counting something that did not need to be counted: tiles, steps, breaths.\n\nThe last page of the log is still the same three numbers, hundreds of times. Whoever reads it slowly notices that the hand changes halfway down. It is no longer hers.\n\nWhat was found went into the clay urn. The radios held their breath. The dead came to listen. And at seven o'clock, for the first time since July, nobody counted.\n\nThis book has no author. But if you have read this far, count with me, very quietly, just once.\n\nSeven.",
      "Este livro não tem autor. Quem o abre deve saber disso antes de virar a página.\n\nDizem que a primeira semana de julho não teve som próprio. Os telefones deram sinal e depois nada, a televisão mostrou a imagem parada de uma bandeira, e o condado aprendeu a escutar o que sobrou. No oitenta e oito ponto seis, entre um chiado e outro, havia uma voz.\n\nEla contava.\n\nNão até cem, não de trás para frente. Contava como quem conta os degraus de uma escada no escuro: devagar, como se o próximo número pudesse faltar. E começava sempre às sete.\n\nUma mulher escutou. O nome dela não importa aqui; importa que ela escrevia. Toda noite, com a mesma letra cansada, os mesmos números, um embaixo do outro, até o papel acabar e ela escrever no verso. Ao lado do aparelho deixou uma fotografia de si mesma, como quem precisa de prova de que esteve naquele quarto. \"Ela conta\", diz a única página que se soltou do registro, \"e eu anoto, e não sei por quê.\"\n\nDepois a voz chegou mais perto.\n\nNinguém levou o rádio da casa dela. E mesmo assim ele foi achado longe, numa sala que ninguém usava, com o dial travado e a carcaça morna, como se tivesse sido desligado um minuto antes. Numa cozinha, uma fita esperava com uma etiqueta escrita a lápis: sete da noite. Na fita, a mesma mulher, muito calma, diz só isto: \"Se você está ouvindo isto, já está contando.\"\n\nOs que acharam as peças não se conheciam. Cada um carregou uma parte sem saber que era uma parte. Alguns dormiram mal. Alguns ouviram o próprio nome dentro do chiado. Todos, em algum momento, se pegaram contando alguma coisa que não precisava ser contada: azulejos, passos, respirações.\n\nA última página do registro ainda é a mesma sequência de três números, centenas de vezes. Quem lê com calma percebe que a letra muda no meio da página. Não é mais a dela.\n\nO que foi encontrado foi para a urna de barro. Os rádios prenderam a respiração. Os mortos vieram escutar. E às sete horas, pela primeira vez desde julho, ninguém contou.\n\nEste livro não tem autor. Mas se você leu até aqui, conte comigo, bem baixinho, uma vez só.\n\nSete."),
  };
  return localize(ctx.state?.languages || ["en"], {
    directives, finale,
    hints: { n2: { full: { text: T("A radio was left on somewhere quiet. Seven o'clock.", "Um rádio ficou ligado em algum lugar silencioso. Sete horas.") }, echo: { text: "88.6" } } },
    proximity: (() => {
      const [en, pt] = place(c, ["a quiet room", "um lugar quieto"]);
      return {
        far: T("I haven't slept right since that number. Last night I counted the ceiling tiles until I lost the count, and the counting went on without me. Somewhere past the last houses a room is waiting. I don't know how I know that.",
          "Não durmo direito desde aquele número. Ontem contei as placas do teto até perder a conta, e a contagem seguiu sem mim. Em algum lugar depois das últimas casas tem um lugar esperando. Não sei como eu sei disso."),
        mid: T(`${cap(en)}. My head keeps going back there the way a tongue goes back to a bad tooth. Quiet places are wrong now. The quiet in there had a shape, and it was facing me.`,
          `${cap(pt)}. Minha cabeça volta lá do jeito que a língua volta num dente ruim. Lugar quieto agora é errado. O silêncio lá dentro tinha forma, e estava virado pra mim.`),
        near: T(`I was close. I know I was. Under everything there was a hiss, like a radio left on in another room, and for one second it said my name in her voice. My hand won't stop shaking while I write this. I'm going back. I don't want to go back.`,
          `Eu estava perto. Eu sei que estava. Debaixo de tudo tinha um chiado, como um rádio esquecido ligado em outro cômodo, e por um segundo ele disse meu nome com a voz dela. Minha mão não para de tremer enquanto escrevo. Eu vou voltar. Eu não quero voltar.`),
      };
    })(),
    motifs_used: [], creativity_score: 0.4,
  });
}

/** A dream for each new life, from where the last one went (task "echo"). */
function echo(ctx) {
  const langs = ctx.state?.languages || ["en"];
  return { directives: (ctx.echo_for || []).map((x) => {
    const last = (ctx.journeys?.[x.player] || []).slice(-1)[0] || {};
    const where = (last.named_places || last.regions || [])[0];
    const text = where
      ? T(`I dreamt of ${where}, but the doors were in the wrong places and someone I never met kept saying "you were here". I woke up with my hands cold, as if I had been holding something that wasn't mine.`,
        `Sonhei com ${where}, mas as portas estavam nos lugares errados e alguém que eu nunca conheci repetia "você esteve aqui". Acordei com as mãos frias, como se estivesse segurando algo que não era meu.`)
      : T(`A dream I can't shake: a radio hissing in a room I have never seen, and a voice that was almost mine saying it was not finished.`,
        `Um sonho que não me larga: um rádio chiando num cômodo que eu nunca vi, e uma voz quase igual à minha dizendo que ainda não tinha acabado.`);
    return { id: `rh_echo_${x.player}_${x.life}`, type: "diary_echo", player: x.player, life: x.life, text: only(langs, text) };
  }) };
}

/** A look at each player's block of play (task "watch"): a hint from where they went, plainer at a later stall step. */
function watch(ctx) {
  const langs = ctx.state?.languages || ["en"];
  const plain = (ctx.stall?.step || 0) >= 2;
  return { directives: (ctx.watch_for || []).map((b) => {
    const where = (b.places || b.regions || [])[0];
    const text = where
      ? T(`${where} keeps coming back to me. Not that place: one like it, ${plain ? "with a radio left on inside" : "somewhere quieter"}.`,
        `${where} não sai da minha cabeça. Não aquele lugar: um parecido, ${plain ? "com um rádio esquecido ligado lá dentro" : "em algum canto mais quieto"}.`)
      : T("I have walked a lot and found little. Maybe I am looking at the wrong kind of place.",
        "Andei muito e achei pouco. Talvez eu esteja olhando o tipo errado de lugar.");
    return { id: `rh_watch_${b.player}`, type: "diary_entry", player: b.player, kind: "hint", text: only(langs, text) };
  }) };
}

/** Same signature as brain.ask's result. Handles the one-writer seed and the two-writer split
 * (task "bible" by the story model, then "stage" for n1 by the stage model). */
export function rehearsalAnswer(contextJson) {
  const ctx = typeof contextJson === "string" ? JSON.parse(contextJson) : contextJson;
  let doc;
  if (ctx.task === "bible") doc = { bible: seed(ctx).bible };
  else if (ctx.task === "seed") doc = seed(ctx);
  else if (ctx.task === "echo") doc = echo(ctx);
  else if (ctx.task === "watch") doc = watch(ctx);
  else if (ctx.stage?.id === "n1") { const { bible: _b, ...rest } = seed(ctx); doc = rest; }
  else doc = stage(ctx);
  return { doc, model: "rehearsal", usage: { input: 0, output: 0, cached: 0 }, cost: 0 };
}
