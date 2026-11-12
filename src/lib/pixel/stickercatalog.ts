/** Sticker library definitions: categories, concepts and packs. Pure data — the asset
 *  pipeline (scripts/build-stickers.ts) renders these into animated PNG files + manifests. */
export interface Concept { n: string; k: string[]; e: string; a: string; fx?: string[]; t?: string }
export interface CategoryDef { id: string; label: string; icon: string; species: (string | [string, string])[]; concepts: Concept[]; perSpecies?: boolean }

const C = (n: string, k: string, e: string, a: string, fx: string[] = [], t?: string): Concept => ({ n, k: k.split(" ").filter(Boolean), e, a, fx, ...(t ? { t } : {}) });

export const CATEGORIES: CategoryDef[] = [
  { id: "love", label: "Love", icon: "❤️", species: ["pixo", "cat", "bunny", "bear", "heart", "panda", "mei", "kai"], concepts: [
    C("Heart beating", "heart beat love", "happy", "pulse", ["bigheart"]),
    C("Flying hearts", "hearts fly love romance", "smile", "float", ["hearts"]),
    C("Blushing", "blush shy embarrassed", "shy", "sway", ["sparkle"]),
    C("Sending kisses", "kiss mwah love", "kiss", "wave", ["kiss"]),
    C("Hugging heart", "hug heart cuddle", "happy", "hug", ["bigheart"]),
    C("Rose delivery", "rose flower gift romance", "smile", "walk", ["rose"]),
    C("Love letter", "letter note love mail", "happy", "bounce", ["letter"]),
    C("Proposal", "proposal ring marry engaged", "cute", "idle", ["ring", "sparkle"]),
    C("Heart explosion", "heart explode love burst", "love", "shake", ["heartburst"]),
    C("So shy", "shy nervous blush", "shy", "tremble", ["sweat"]),
    C("Missing you", "miss missing sad love", "teary", "sway", ["tears"], "MISS U"),
    C("I love you", "love you ily", "love", "bounce", ["hearts"], "I<U"),
    C("Forever together", "forever together always", "happy", "sway", ["sparkle"], "4EVER"),
    C("Love struck", "lovestruck crush dizzy", "love", "idle", ["orbithearts"]),
  ] },
  { id: "cute", label: "Cute", icon: "🥰", species: ["cat", "bunny", "hamster", "penguin", "duck", "pixo", "slime", "star"], concepts: [
    C("Waving hi", "hi hello wave greet", "smile", "wave", [], "HI"),
    C("Happy dance", "dance happy music", "happy", "dance", ["music"]),
    C("Sleepy", "sleep sleepy tired nap", "sleep", "sleep", ["zzz"]),
    C("Crying cutie", "cry sad tears", "cry", "sway", ["tears"]),
    C("Big smile", "smile happy joy", "smile", "bounce", ["sparkle"]),
    C("Tiny wave", "wave bye small", "cute", "wave"),
    C("Snack time", "snack food cookie eat", "happy", "chew", ["food"]),
    C("Magic sparkle", "magic sparkle wand fairy", "star", "float", ["wand", "sparkle"]),
    C("Peek blink", "blink cute look", "cute", "idle"),
    C("Hugs", "hug hugs cuddle", "happy", "hug", [], "HUGS"),
    C("Look around", "look turn curious", "neutral", "turn"),
    C("Jumping joy", "jump joy yay", "happy", "jump", ["confetti"]),
    C("Puppy eyes", "please beg puppy eyes", "teary", "idle", ["sparkle"]),
    C("Flower gift", "flower gift for you", "cute", "bounce", ["flower"]),
    C("Bubble nap", "nap bubble sleep", "sleep", "sleep", ["bubble"]),
  ] },
  { id: "memes", label: "Memes", icon: "😂", species: ["pixo", "cat", "dog", "frog", "capy", "monkey", "kai", "ghost"], concepts: [
    C("Rolling laughing", "rofl laugh lol funny", "laugh", "laugh", ["tears"], "LOL"),
    C("Facepalm", "facepalm ugh annoyed", "closed", "sway", ["sweat"], "UGH"),
    C("Unexpected", "unexpected surprise what", "wide", "jump", ["exclaim"]),
    C("Shocked", "shock shocked omg surprised", "shock", "tremble", [], "!?"),
    C("Dramatic crying", "dramatic crying sob", "cry", "shake", ["cryflood"]),
    C("Sarcastic smile", "sarcastic sure smirk", "sus", "idle"),
    C("Running away", "run away escape flee", "wide", "run", ["sweat"]),
    C("Mind blown", "mind blown wow explode", "dizzy", "idle", ["explode"]),
    C("Suspicious eyes", "suspicious sus doubt", "sus", "turn", [], "HMM"),
    C("Confused", "confused huh what", "dizzy", "sway", ["question"]),
    C("Angry reaction", "angry mad rage", "angry", "shake", ["vein"]),
    C("Laugh and fall", "laugh fall xd", "laugh", "fall", [], "XD"),
    C("Dead inside", "dead inside rip tired", "dead", "idle", ["skull"], "RIP"),
    C("No words", "speechless no words silent", "meh", "idle", [], "..."),
    C("Big brain", "idea smart brain genius", "star", "pulse", ["lightbulb"]),
  ] },
  { id: "animals", label: "Animals", icon: "🐱", perSpecies: true, species: ["cat", "dog", "panda", "fox", "bear", "bunny", "penguin", "duck", "frog", "hamster", "bird", "tiger", "lion", "monkey", "capy"], concepts: [
    C("Hello", "hello hi wave", "wink", "wave"),
    C("Happy", "happy joy", "star", "bounce"),
    C("Sleepy", "sleepy sleep nap", "sleep", "sleep", ["zzz", "moon"]),
    C("Hungry", "hungry eat food", "wide", "chew", ["food"]),
    C("Crying", "cry sad tears", "cry", "shake", ["tears"]),
    C("Angry", "angry mad grumpy", "angry", "tremble", ["vein"]),
    C("In love", "love heart crush", "love", "sway", ["hearts"]),
    C("Dancing", "dance party music", "happy", "dance", ["music", "sparkle"]),
  ] },
  { id: "couple", label: "Couple", icon: "💕", species: [["cat", "bunny"], ["bear", "panda"], ["kai", "mei"], ["pixo", "slime"], ["fox", "dog"], ["penguin", "duck"], ["hamster", "capy"], ["heart", "star"]], concepts: [
    C("Holding hands", "holding hands together date", "happy", "sway", ["handhold"]),
    C("Couple hug", "hug cuddle together", "shy", "hug", ["hearts"]),
    C("Kiss", "kiss mwah", "kiss", "idle", ["kiss"], "MWAH"),
    C("Blushing together", "blush shy together", "shy", "sway", ["sparkle"]),
    C("Sleeping together", "sleep together night", "sleep", "sleep", ["zzz"]),
    C("Sharing food", "share food pizza date", "happy", "chew", ["pizza"]),
    C("Missing you", "miss missing you", "teary", "sway", ["tears"], "MISS U"),
    C("Waiting for you", "waiting wait you", "sad", "idle", ["clock"], "..."),
    C("Sending hearts", "hearts love send", "love", "float", ["hearts"]),
    C("Romantic dance", "dance romantic waltz", "happy", "dance", ["music"]),
    C("Cute argument", "argue argument fight", "angry", "shake", ["vein"]),
    C("Making up", "sorry making up forgive", "teary", "bounce", ["hearts"], "SORRY"),
    C("Good morning", "good morning gm", "smile", "bounce", ["sun"], "GM"),
    C("Good night", "good night gn sleep", "sleep", "sleep", ["moon"], "GN"),
  ] },
  { id: "friends", label: "Friends", icon: "🤝", species: [["dog", "cat"], ["frog", "duck"], ["monkey", "tiger"], ["kai", "pixo"], ["robot", "ghost"], ["lion", "bear"], ["bird", "hamster"], ["mei", "bunny"]], concepts: [
    C("Best friends", "best friends bff bestie", "happy", "sway", ["sparkle"], "BFF"),
    C("High five", "high five clap", "happy", "jump", ["clap"]),
    C("Group celebration", "celebrate group yay", "happy", "jump", ["confetti"]),
    C("Friendship hug", "hug friendship", "happy", "hug", []),
    C("Laughing together", "laugh together lol", "laugh", "laugh", ["tears"]),
    C("Party time", "party balloon fun", "happy", "dance", ["music"]),
    C("Supporting you", "support cheer you can", "smile", "nod", [], "GO GO"),
    C("Congrats", "congrats congratulations", "star", "bounce", ["confetti"], "YAY"),
    C("Thank you", "thanks thank you", "cute", "nod", ["sparkle"], "THX"),
    C("Let's go", "lets go hype", "happy", "run", [], "LETS GO"),
    C("Bestie reaction", "omg bestie reaction", "shock", "tremble", [], "OMG"),
    C("Friends forever", "forever friends", "happy", "sway", ["hearts"], "4EVER"),
    C("Cheers", "cheers drink toast", "happy", "bounce", ["drinks"]),
  ] },
  { id: "reactions", label: "Reactions", icon: "🎭", species: ["pixo", "cat", "dog", "bunny", "frog", "robot", "mei"], concepts: [
    C("Yes", "yes yep agree", "happy", "nod", [], "YES"),
    C("No", "no nope", "angry", "no", [], "NO"),
    C("Okay", "ok okay fine", "smile", "wave", [], "OK"),
    C("Really?", "really doubt", "sus", "turn", [], "REALLY?"),
    C("Wow", "wow amazing", "wide", "jump", ["sparkle"], "WOW"),
    C("OMG", "omg shock", "shock", "tremble", [], "OMG"),
    C("What?", "what huh confused", "dizzy", "sway", ["question"], "WHAT?"),
    C("Sorry", "sorry apology", "sad", "sway", ["sweat"], "SORRY"),
    C("Thanks", "thanks thank you", "happy", "bounce", [], "THANKS"),
    C("Welcome", "welcome you're welcome", "smile", "wave", ["sparkle"], "WELCOME"),
    C("Good job", "good job well done", "star", "bounce", [], "GOOD JOB"),
    C("Perfect", "perfect great", "cool", "idle", ["sparkle"], "PERFECT"),
    C("Wait", "wait hold on", "neutral", "idle", ["dots"], "WAIT"),
    C("Seriously?", "seriously srsly annoyed", "meh", "idle", [], "SRSLY?"),
    C("Agreed", "agree i agree", "smile", "nod", [], "AGREED"),
    C("Not interested", "not interested nope bored", "meh", "turn", [], "NOPE"),
  ] },
  { id: "daily", label: "Daily Life", icon: "☕", species: ["kai", "mei", "cat", "bear", "pixo", "panda", "capy"], concepts: [
    C("Good morning", "good morning gm wake", "smile", "bounce", ["sun"], "GM"),
    C("Good night", "good night gn sleep", "sleep", "sleep", ["moon"], "GN"),
    C("Eating", "eat eating food lunch", "happy", "chew", ["pizza"]),
    C("Coffee time", "coffee drink morning", "smile", "idle", ["coffee"]),
    C("Working", "work working busy laptop", "neutral", "tremble", ["laptop"]),
    C("Studying", "study studying book exam", "neutral", "idle", ["book"]),
    C("Sleeping", "sleep sleeping bed", "sleep", "sleep", ["zzz", "bubble"]),
    C("Exercising", "exercise gym workout", "angry", "jump", ["dumbbell"]),
    C("Travelling", "travel trip vacation", "happy", "walk", ["suitcase"]),
    C("Shopping", "shopping shop buy", "star", "bounce", ["bag"]),
    C("Celebrating", "celebrate party", "happy", "dance", ["confetti"]),
    C("Feeling lazy", "lazy meh bored", "meh", "sway", [], "MEH"),
  ] },
  { id: "gaming", label: "Gaming", icon: "🎮", species: ["pixo", "robot", "kai", "ghost", "slime", "dino", "fox"], concepts: [
    C("Victory", "victory win winner", "star", "jump", ["trophy"], "WIN"),
    C("Game over", "game over lose dead", "dead", "fall", ["skull"], "OVER"),
    C("Level up", "level up lvl", "star", "jump", ["sparkle"], "LVL UP"),
    C("Player one", "player one p1 ready", "cool", "idle", ["controller"], "P1"),
    C("Respawn", "respawn 1up revive", "happy", "float", ["sparkle"], "1UP"),
    C("Achievement unlocked", "achievement unlocked medal", "star", "bounce", ["medal"], "UNLOCK"),
    C("Rage quit", "rage quit angry", "angry", "shake", ["controller", "vein"], "RAGE"),
    C("GG", "gg good game", "happy", "nod", [], "GG"),
    C("Power up", "power up boost fire", "angry", "pulse", ["fire"]),
    C("Boss defeated", "boss defeated ko sword", "cool", "bounce", ["sword"], "KO"),
    C("Pixel explosion", "explosion boom", "dizzy", "shake", ["explode"]),
    C("Coin collect", "coin collect gold", "happy", "jump", ["coin"]),
  ] },
  { id: "festivals", label: "Festivals", icon: "🎉", species: ["pixo", "cat", "bunny", "bear", "mei", "kai", "panda"], concepts: [
    C("Birthday", "birthday hbd cake", "happy", "bounce", ["cake"], "HBD"),
    C("Anniversary", "anniversary love", "love", "sway", ["bigheart"], "1 YEAR"),
    C("New Year", "new year hny fireworks", "star", "jump", ["fireworks"], "HNY"),
    C("Diwali", "diwali diya lights festival", "smile", "idle", ["diya", "sparkle"], "DIWALI"),
    C("Holi", "holi colors festival", "happy", "dance", ["holi"], "HOLI"),
    C("Christmas", "christmas xmas tree", "happy", "bounce", ["tree"], "XMAS"),
    C("Valentine's Day", "valentine love heart", "love", "pulse", ["hearts"], "LOVE"),
    C("Congratulations", "congratulations congrats", "star", "jump", ["confetti"], "CONGRATS"),
    C("Fireworks", "fireworks night sky", "wide", "idle", ["fireworks"]),
    C("Party", "party balloon", "happy", "dance", ["balloon"]),
    C("Celebration", "celebration yay", "happy", "jump", ["confetti"], "YAY"),
    C("Festival greetings", "festival greetings lantern", "smile", "wave", ["lantern"], "JOY"),
  ] },
];

export interface StickerMeta { id: string; name: string; cat: string; keywords: string[]; species: string[]; expr: string; action: string; fx: string[]; text?: string; pair?: boolean; packs: string[] }

const WHO: Record<string, [string, string]> = {
  cat: ["Mochi", "cat"], dog: ["Biscuit", "dog"], panda: ["Bao", "panda"], fox: ["Ember", "fox"], bear: ["Cocoa", "bear"], bunny: ["Momo", "bunny rabbit"],
  penguin: ["Pip", "penguin"], duck: ["Quackers", "duck"], frog: ["Lilypad", "frog"], hamster: ["Nibbles", "hamster"], bird: ["Chirp", "bird"], tiger: ["Stripe", "tiger"],
  lion: ["Sunny", "lion"], monkey: ["Bongo", "monkey"], capy: ["Capy", "capybara"], pixo: ["Pixo", "pixo mascot"], ghost: ["Boo", "ghost"], slime: ["Gloop", "slime"],
  robot: ["Bolt", "robot"], kai: ["Kai", "boy"], mei: ["Mei", "girl"], heart: ["Lovey", "heart"], star: ["Twinkle", "star"], dino: ["Rexy", "dino dinosaur"],
};
export const characterName = (sp: string) => WHO[sp]?.[0] ?? sp;
const EMO: Record<string, string> = { happy: "happy joy", smile: "smile happy", cute: "cute", love: "love heart", shy: "shy blush", sleep: "sleepy", sad: "sad", cry: "cry sad", angry: "angry mad", shock: "shocked surprised", wide: "surprised", dizzy: "confused dizzy", dead: "dead", star: "excited", wink: "wink", meh: "bored meh", sus: "suspicious", cool: "cool", kiss: "kiss", neutral: "", closed: "", teary: "emotional teary" };

export const PACKS: { id: string; name: string; desc: string; test: (m: StickerMeta) => boolean }[] = [
  { id: "pixel-love", name: "Pixel Love", desc: "Hearts, kisses and blushing Pixo-style love.", test: (m) => m.cat === "love" },
  { id: "cute-cat-world", name: "Cute Cat World", desc: "Everything Mochi the cat.", test: (m) => m.species.includes("cat") },
  { id: "funny-reactions", name: "Funny Reactions", desc: "Memes and quick replies.", test: (m) => (m.cat === "memes" || m.cat === "reactions") && ["pixo", "frog", "dog"].includes(m.species[0]!) },
  { id: "bestie-forever", name: "Bestie Forever", desc: "Friendship moments.", test: (m) => m.cat === "friends" },
  { id: "couple-moments", name: "Couple Moments", desc: "Cute pairs together.", test: (m) => m.cat === "couple" },
  { id: "happy-animals", name: "Happy Animals", desc: "Animals being happy and dancing.", test: (m) => m.cat === "animals" && ["happy", "dancing", "hello"].some((w) => m.name.toLowerCase().startsWith(w)) },
  { id: "gaming-legends", name: "Gaming Legends", desc: "GG, level ups and boss fights.", test: (m) => m.cat === "gaming" },
  { id: "daily-mood", name: "Daily Mood", desc: "Coffee, work, naps and more.", test: (m) => m.cat === "daily" },
  { id: "little-bunny", name: "Little Bunny", desc: "Momo the bunny in every mood.", test: (m) => m.species.includes("bunny") },
  { id: "party-time", name: "Party Time", desc: "Confetti, balloons and fireworks.", test: (m) => m.fx.some((f) => ["confetti", "balloon", "fireworks", "music"].includes(f)) },
  { id: "emotional-expressions", name: "Emotional Expressions", desc: "Big feelings, tiny pixels.", test: (m) => ["cry", "teary", "shock", "angry", "dizzy"].includes(m.expr) && !m.pair },
  { id: "pixel-panda", name: "Pixel Panda", desc: "Bao the panda.", test: (m) => m.species.includes("panda") },
  { id: "romantic-hearts", name: "Romantic Hearts", desc: "Love and couple hearts.", test: (m) => (m.cat === "love" || m.cat === "couple") && m.fx.some((f) => f.includes("heart")) },
  { id: "crazy-friends", name: "Crazy Friends", desc: "Laughing, partying friends.", test: (m) => m.cat === "friends" && ["laugh", "dance", "jump", "run", "tremble"].includes(m.action) },
  { id: "sleepy-characters", name: "Sleepy Characters", desc: "Naps and good nights.", test: (m) => m.action === "sleep" },
];

function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

/** Deterministic full catalog (order defines IDs). */
export function buildCatalog(): StickerMeta[] {
  const out: StickerMeta[] = [];
  for (const cat of CATEGORIES) {
    let n = 0;
    for (const concept of cat.concepts) for (const spx of cat.species) {
      const species = Array.isArray(spx) ? spx : [spx];
      const pair = Array.isArray(spx);
      const who = species.map((s) => characterName(s)).join(" & ");
      const name = cat.perSpecies ? `${concept.n} ${WHO[species[0]!]?.[1].split(" ")[0]}` : `${concept.n} · ${who}`;
      const keywords = Array.from(new Set([
        ...concept.k, ...slug(concept.n).split("-"), cat.label.toLowerCase(), ...cat.label.toLowerCase().split(" "),
        ...species.flatMap((s) => [characterName(s).toLowerCase(), ...(WHO[s]?.[1].split(" ") ?? [])]),
        ...(EMO[concept.e] ?? "").split(" "), concept.a, ...(concept.t ? [concept.t.toLowerCase()] : []), ...(pair ? ["couple", "pair", "together"] : []),
      ].filter(Boolean)));
      const meta: StickerMeta = { id: `${cat.id}.${String(n).padStart(3, "0")}`, name, cat: cat.id, keywords, species, expr: concept.e, action: concept.a, fx: concept.fx ?? [], packs: [], ...(concept.t ? { text: concept.t } : {}), ...(pair ? { pair } : {}) };
      meta.packs = PACKS.filter((p) => p.test(meta)).map((p) => p.id);
      out.push(meta);
      n++;
    }
  }
  return out;
}
