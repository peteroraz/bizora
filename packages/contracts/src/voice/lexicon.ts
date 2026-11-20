import { unitFromText, type UnitCode } from "../stock-units.js";

/**
 * The words a spoken sale is read with (ADR-040). One pack per language; only English is tested today. A new language
 * (Pidgin, Yoruba, Igbo, Hausa…) adds a pack with its own number words and market words, and the parser stays the same.
 */
export type VoiceLexicon = {
  code: string;
  /** Number words: "five" → 5, "seventeen" → 17. */
  units: Record<string, number>;
  tens: Record<string, number>;
  /** "hundred" → 100, "thousand" → 1000… */
  scales: Record<string, number>;
  /** Words that join a number's parts: "three hundred and fifty". */
  numberJoin: string[];
  /** "a hundred", "an hour". */
  one: string[];
  half: string[];
  point: string[];
  /** A unit a product is sold in, as a unit code, or a market unit with no code ("tray", "mudu"). */
  unit: (word: string) => UnitCode | "other" | null;
  /** Words that come between a quantity and a product: "five bags OF rice". */
  of: string[];
  /** Price markers: "AT 75k", "FOR 36k", "@ 500". */
  at: string[];
  forTotal: string[];
  each: string[];
  per: string[];
  /** Sale verbs before a customer's name: "Emeka COLLECTED…". */
  customerVerbs: string[];
  /** "sold … TO Emeka". */
  to: string[];
  customerWord: string[];
  honorifics: string[];
  paid: string[];
  paidInFull: string[][];
  unpaid: string[][];
  balance: string[];
  total: string[][];
  methods: Record<string, "cash" | "transfer" | "pos">;
  /** Words that carry no meaning here: "he", "the", "me". */
  filler: string[];
  /**
   * Words speech-to-text writes for a number that sounds the same, used only right before a unit word and not after
   * another number: "sold TO bags of rice" → 2 bags, "FOR cartons" → 4 cartons.
   */
  numberSoundAlikes?: Record<string, string>;
  /** Words misheard for a unit or market word: "backs" of rice → "bags". */
  soundAlikes?: Record<string, string>;
  /** Currency words and the currency they mean. "naira" → NGN. */
  currencies: Record<string, string>;
  /** The smallest coin: "kobo", "pesewas", "cents". Amounts said in these are not whole money units. */
  minorCoins: string[];
};

const MARKET_UNITS = new Set([
  "tray", "trays", "keg", "kegs", "gallon", "gallons", "jerrycan", "jerrycans", "basket", "baskets", "tuber", "tubers",
  "heap", "heaps", "bunch", "bunches", "derica", "dericas", "mudu", "mudus", "congo", "congos", "cup", "cups", "plate",
  "plates", "wrap", "wraps", "ball", "balls", "drum", "drums", "loaf", "loaves", "packets", "pallet", "pallets",
]);

export const ENGLISH: VoiceLexicon = {
  code: "en",
  units: {
    zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19,
  },
  tens: { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 },
  scales: { hundred: 100, thousand: 1000, k: 1000, million: 1_000_000, billion: 1_000_000_000 },
  numberJoin: ["and"],
  one: ["a", "an"],
  half: ["half"],
  point: ["point", "dot"],
  unit: (word) => {
    if (word === "each") return null;
    const code = unitFromText(word);
    if (code) return code;
    return MARKET_UNITS.has(word) ? "other" : null;
  },
  of: ["of"],
  at: ["at", "@", "price", "priced", "costing", "cost"],
  forTotal: ["for"],
  each: ["each", "apiece", "a piece", "per one", "one one"],
  per: ["per", "a", "an", "every", "for each", "for one"],
  customerVerbs: ["collected", "collect", "took", "take", "bought", "buy", "picked", "carried", "purchased", "ordered", "got", "came for", "came and took"],
  to: ["to"],
  customerWord: ["customer", "customer's", "client", "buyer"],
  honorifics: ["mr", "mrs", "miss", "ms", "mama", "papa", "baba", "iya", "alhaji", "alhaja", "madam", "oga", "chief", "aunty", "auntie", "uncle", "bros", "brother", "sister", "dr", "mallam", "hajia", "mummy", "daddy"],
  paid: ["paid", "pay", "pays", "paying", "gave", "give", "deposited", "deposit", "brought", "sent", "transferred", "settled"],
  paidInFull: [["in", "full"], ["full"], ["complete"], ["completely"], ["everything"], ["all"], ["fully"], ["finish"], ["the", "whole"]],
  unpaid: [["on", "credit"], ["credit"], ["nothing"], ["not", "paid"], ["did", "not", "pay"], ["didn't", "pay"], ["no", "payment"], ["will", "pay", "later"], ["pay", "later"]],
  balance: ["balance", "remaining", "remain", "remains", "owes", "owe", "owing", "outstanding", "debt", "left"],
  total: [["total"], ["altogether"], ["all", "together"], ["grand", "total"], ["in", "all"], ["sum", "total"]],
  methods: {
    cash: "cash", transfer: "transfer", transferred: "transfer", bank: "transfer", "bank transfer": "transfer", trf: "transfer",
    pos: "pos", "p.o.s": "pos", card: "pos", swipe: "pos", swiped: "pos", atm: "pos",
  },
  numberSoundAlikes: { to: "two", too: "two", for: "four" },
  soundAlikes: { backs: "bags", back: "bag", bax: "bags", cartoons: "cartons", cartoon: "carton", creates: "crates", create: "crate", tens: "tins" },
  filler: ["he", "she", "they", "him", "her", "me", "us", "i", "we", "the", "it", "is", "was", "will", "has", "have", "just", "only", "so", "then", "also", "um", "uh", "eh", "oh", "okay", "ok", "sum", "amount", "money", "already", "about", "around", "like"],
  currencies: {
    naira: "NGN", nairas: "NGN", "₦": "NGN", "#": "NGN", n: "NGN",
    cedi: "GHS", cedis: "GHS", "₵": "GHS",
    shilling: "KES", shillings: "KES", bob: "KES",
    rand: "ZAR", rands: "ZAR",
    dollar: "USD", dollars: "USD", "$": "USD",
    pound: "GBP", pounds: "GBP", "£": "GBP",
    euro: "EUR", euros: "EUR", "€": "EUR",
    cfa: "XOF", franc: "XOF", francs: "XOF",
    birr: "ETB", kwacha: "ZMW", dirham: "AED", dirhams: "AED", rupee: "INR", rupees: "INR",
  },
  minorCoins: ["kobo", "pesewa", "pesewas", "cent", "cents", "pence", "penny"],
};
