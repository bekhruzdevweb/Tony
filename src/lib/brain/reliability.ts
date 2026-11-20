/**
 * Reliability rules (pure, no database): what the brain checks in code
 * instead of trusting the model. Each rule comes from a real failure in his
 * chat history (20 Nov), and each is covered in tests/reliability.test.ts
 * and the eval suite in evals/.
 */

const TZ_OFFSET_MS = 5 * 60 * 60_000; // Asia/Tashkent, no daylight saving

// ── 2. Several requests in one message ──────────────────────────────────

/** Verbs that open a request to Tony ("send me…", "remind me…", "clean the chat"). */
const REQUEST_VERB = "send|show|tell|give|clean|clear|remind|move|reschedule|cancel|delete|remove|drop|mark|schedule|add|put|set|plan|list|make|create|save|note";

/**
 * His message as separate requests, split only where he clearly started a
 * new one: "…? And also, tomorrow remind me…", "…. Also move IELTS prep…",
 * "clean the chat and send me the overdue tasks". Anything less clear stays
 * whole ("remind me to call mum and send flowers", "presentation at 13:00
 * and the Zoom tutorial at 18:00"): the model then sees it as one request.
 */
export function splitIntents(text: string): string[] {
  const clean = text.replace(/[“”]/g, '"').trim();
  if (!clean) return [];
  // Sentence ends: punctuation, space, then a capital (so "8.30 a.m. in the morning" stays whole).
  const sentences = clean.split(/(?<=[.?!])\s+(?=["(]?[A-Z])/);
  const opensNew = /^(and\s+)?(also|plus|additionally|another (thing|task|one))\b[,:]?\s*/i;
  const parts: string[] = [];
  for (const sentence of sentences) {
    // Within a sentence: "…, and also …", "…; also …".
    const pieces = sentence.split(/\s*(?:[,;]\s*and also|\band also|[,;]\s*also)\b[,:]?\s+/i).filter((piece) => piece.trim());
    const fresh = opensNew.test(sentence);
    pieces.forEach((piece, index) => {
      if (parts.length === 0 || index > 0 || fresh || opensNew.test(piece)) parts.push(piece);
      else parts[parts.length - 1] = `${parts[parts.length - 1]} ${piece}`;
    });
  }
  // "Can you clean the chat and send me…": a second request verb after "and",
  // unless the first part is a "to …" phrase the second one continues.
  const split = parts.flatMap((part) => {
    const match = new RegExp(`^(.{8,}?)\\s+and\\s+((?:${REQUEST_VERB})\\b.{4,})$`, "i").exec(part);
    if (!match) return [part];
    const [, left, right] = match;
    const asks = new RegExp(`\\b(${REQUEST_VERB})\\b`, "i").test(left);
    const infinitive = /\bto\s+\w+/i.test(left.replace(/^.*?\b(remind|tell|ask)\s+me\s+/i, "to "));
    return asks && !infinitive ? [left, right] : [part];
  });
  const tidy = split.map((part) => part.replace(opensNew, "").replace(/^[,;:\s]+/, "").trim()).filter((part) => part.split(/\s+/).length >= 2);
  // At most four: beyond that it is one long request, not a list of them.
  return tidy.length > 1 && tidy.length <= 4 ? tidy : [clean];
}

// ── 6. Times he gave are final ──────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, fifty: 50 };

/** One time he named: a clock time (minutes after local midnight, with am/pm alternatives) or a moment from now. */
export type GivenTime = { minutes: number[] } | { at: Date };

/**
 * The times in his words: "at 2 p.m." , "8.30 a.m.", "13:00", "1 and a half p.m.",
 * "at 6" (06:00 or 18:00), "after 20 minutes", "in half an hour", "after three hours".
 * Counts ("15 pages", "4 images") are not times.
 */
export function givenTimes(text: string, now: Date): GivenTime[] {
  const found: { index: number; time: GivenTime }[] = [];
  const lower = text.toLowerCase();
  const half = /\b(in|after)\s+(half an hour|an hour and a half|(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|fifty|\d{1,3})\s*(hours?|hrs?|minutes?|mins?))\b/g;
  for (const match of lower.matchAll(half)) {
    let minutes: number;
    if (match[2] === "half an hour") minutes = 30;
    else if (match[2] === "an hour and a half") minutes = 90;
    else {
      const amount = NUMBER_WORDS[match[3]] ?? Number(match[3]);
      minutes = /^h/.test(match[4]) ? amount * 60 : amount;
    }
    found.push({ index: match.index!, time: { at: new Date(Math.round((now.getTime() + minutes * 60_000) / 60_000) * 60_000) } });
  }
  const ampm = (hour: number, suffix: string | undefined): number[] => {
    if (suffix?.startsWith("p")) return [((hour % 12) + 12) * 60];
    if (suffix?.startsWith("a")) return [(hour % 12) * 60];
    if (hour > 12) return [hour * 60];
    return hour === 12 ? [12 * 60] : [hour * 60, (hour + 12) * 60];
  };
  const SUFFIX = "(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)";
  const taken: [number, number][] = [];
  const add = (index: number, length: number, minutes: number[]) => {
    if (taken.some(([start, end]) => index < end && index + length > start)) return;
    taken.push([index, index + length]);
    found.push({ index, time: { minutes } });
  };
  // "1 and a half p.m."
  for (const match of lower.matchAll(new RegExp(`\\b(\\d{1,2}) and a half\\s*${SUFFIX}?`, "g"))) {
    add(match.index!, match[0].length, ampm(Number(match[1]), match[2]?.replace(/[\s.]/g, "")).map((m) => m + 30));
  }
  // "8.30 a.m.", "13:00", "6.30 p.m."
  for (const match of lower.matchAll(new RegExp(`\\b([01]?\\d|2[0-3])[:.]([0-5]\\d)\\b\\s*${SUFFIX}?`, "g"))) {
    add(match.index!, match[0].length, ampm(Number(match[1]), match[3]?.replace(/[\s.]/g, "")).map((m) => m + Number(match[2])));
  }
  // "2 p.m.", "7 AM"
  for (const match of lower.matchAll(new RegExp(`\\b(1[0-2]|0?[1-9])\\s*${SUFFIX}(?![a-z])`, "g"))) {
    add(match.index!, match[0].length, ampm(Number(match[1]), match[2].replace(/[\s.]/g, "")));
  }
  // "at 6"
  for (const match of lower.matchAll(/\bat ([01]?\d|2[0-3])\b(?![:.]\d|\s*(?:and a half|a\.?\s?m|p\.?\s?m|%|pages?|images?|minutes?|hours?))/g)) {
    add(match.index! + 3, match[0].length - 3, ampm(Number(match[1]), undefined));
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.time);
}

const localMinute = (date: Date) => {
  const local = new Date(date.getTime() + TZ_OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
};

/**
 * A due time the model chose, held to the time he named. With exactly one
 * time in his words and the model's time not matching it, his time wins (on
 * the day the model chose). Returns the corrected time, or undefined when
 * the model's is right or his words do not settle it ("remind me one hour
 * before" moves a reminder, not his time).
 */
export function heldToGivenTime(due: Date, said: string, now: Date): Date | undefined {
  const times = givenTimes(said, now);
  if (times.length !== 1) return undefined;
  const [time] = times;
  if ("at" in time) return Math.abs(time.at.getTime() - due.getTime()) <= 2 * 60_000 ? undefined : time.at;
  const minute = localMinute(due);
  if (time.minutes.includes(minute)) return undefined;
  const dayStart = due.getTime() - minute * 60_000;
  const options = time.minutes.map((m) => new Date(dayStart + m * 60_000));
  // "At 6": the one still ahead, closest to the model's pick.
  const ahead = options.filter((option) => option.getTime() >= now.getTime() - 60_000);
  return (ahead.length ? ahead : options).sort((a, b) => Math.abs(a.getTime() - due.getTime()) - Math.abs(b.getTime() - due.getTime()))[0];
}

// ── 6. One question at most ─────────────────────────────────────────────

/**
 * A reply with at most one question to him: any question after the first, in
 * its prose, is dropped. Lists, headings, tables and quotes are content, not
 * questions to answer, and stay as they are ("- Beginners: what stops them?").
 */
export function oneQuestion(reply: string): string {
  let seen = false;
  return reply
    .split("\n")
    .map((line) => {
      if (/^\s*([-*•]|\d+\.|#|\||>)/.test(line)) return line;
      const kept = line.replace(/[^.?!\n]*\?+/g, (question) => {
        if (!seen) {
          seen = true;
          return question;
        }
        return "";
      });
      return kept === line ? line : kept.replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?])/g, "$1").trim();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The model asking for a time or day instead of saving the task ("What time should I set?"). */
export function asksForTime(reply: string): boolean {
  return /\b(what|which) (times?|days?|hours?)\b|\bat what times?\b|\bwhen (should|shall|would|do|will) (i|you|we)\b|\bwhen (is|does) (it|the)\b/i.test(reply) && /\?/.test(reply);
}

/** His words ask for something to be written down (not a question to Tony). */
export function isCapture(text: string): boolean {
  const asksTony = /^\s*(what|which|how|why|who|where|when|is|are|do|does|did|can you (show|tell|send|list))\b/i.test(text) && /\?\s*$/.test(text);
  return !asksTony && /\b(remind me|add\b|i (have|need|got|must) to|i should|schedule|don't let me forget|note to self|make (a|it a) task|put .{1,40} (on|in) (the|my) (list|inbox))/i.test(text);
}

// ── 1. Replies only from verified results ───────────────────────────────

/**
 * A reply that says something was done ("Noted, sir. Your reminder is set",
 * "Corrected, sir", "Saved"). Only allowed when a write was verified.
 */
export function claimsAction(reply: string): boolean {
  const plain = reply.replace(/[*_`]/g, "");
  return (
    /^\s*(done|saved|noted|added|moved|removed|dropped|corrected|updated|scheduled|rescheduled|set|marked|remembered|cancelled|deleted)\b[,.!:]/im.test(plain) ||
    /\b(i('ve| have)?|i'll) (set|saved|added|moved|scheduled|rescheduled|marked|removed|dropped|updated|corrected|created|put|noted|attached|cancelled|deleted|remembered)\b/i.test(plain) ||
    /\b(is|are|was|were|now|been) (set|saved|scheduled|rescheduled|moved|marked( as)? (done|complete)|added|removed|dropped|updated|cancelled|deleted)\b/i.test(plain) ||
    /\breminder (is )?set\b|\bset for (today|tomorrow|\d)|\b(now|also) (notes?|carr(y|ies))\b/i.test(plain)
  );
}

/** The reply without its sentences that claim an action; its lines and lists stay as they were. */
export function withoutClaims(reply: string): string {
  return filterSentences(reply, (sentence) => !claimsAction(sentence));
}

/** Which of the fields a tool meant to write did not end up stored. */
export function unsaved(stored: Record<string, unknown> | undefined, wrote: Record<string, unknown>): string[] {
  if (!stored) return ["the task"];
  return Object.entries(wrote).flatMap(([field, value]) => {
    const have = stored[field];
    if (value === null || value === undefined) return have === null || have === undefined ? [] : [field];
    if (field.endsWith("_at")) return typeof have === "string" && new Date(have).getTime() === new Date(String(value)).getTime() ? [] : [field];
    if (field === "notes") return typeof have === "string" && have.includes(String(value)) ? [] : [field];
    return have === value ? [] : [field];
  });
}

// ── 4. Every link and detail from his message ───────────────────────────

/** Every link in his words. */
export function linksIn(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []).map((url) => url.replace(/[).,!?]+$/, "")))];
}

/** Words that carry no detail of their own: requests, times, filler. */
const FILLER = new Set(
  "remind reminder please tony jarvis also maybe upcoming next dont didnt check touch thist task tasks inbox okay alright thanks thank tomorrow today tonight morning afternoon evening night monday tuesday wednesday thursday friday saturday sunday minutes minute hours hour half after before about would could should will shall want need have make sure just like really that this those these there their them they with from into your yours mine some something things thing task tasks schedule scheduled list inbox later again time times when what which then also well yeah gonna going been being doing does sir please save saved keep hello days week weeks month months three four five seven eight nine twelve twenty thirty".split(
    " ",
  ),
);

/** Detail words: four letters or more, not filler, compared by their first five letters. */
const detailWords = (text: string) =>
  [...new Set((text.toLowerCase().replace(/https?:\/\/\S+/g, " ").match(/\p{L}{4,}/gu) ?? []).filter((word) => !FILLER.has(word)).map((word) => word.slice(0, 5)))];

/**
 * The details of his message that no task kept: words in his request that
 * are in no title, note or part saved for it. Two or more missing means
 * something he said was dropped ("for international students").
 */
export function lostDetails(message: string, saved: string[]): string[] {
  const kept = new Set(detailWords(saved.join(" ")));
  return detailWords(message).filter((word) => !kept.has(word));
}

/**
 * What to add to a new task's notes so nothing he said is lost: any link not
 * yet kept, and his own words when two or more details were dropped.
 */
/** His words to Tony about how to handle the task ("put this task to inbox", "remind me if I don't check it for 2 days") are not details of the task. */
export function withoutInstructions(message: string): string {
  return message
    .replace(/\b(?:and\s+)?(?:please\s+)?remind me if i\b[^.?!]*?\b(?:days?|weeks?)\b/gi, " ")
    .replace(/\b(?:please\s+)?(?:put|add|save|keep|move)\s+(?:this|thist|it|that)?\s*(?:task\s+)?(?:to|in|into|on)\s+(?:the\s+|my\s+)?(?:inbox|list)\b/gi, " ")
    .replace(/\b(?:can|could|would) you\b|\b(?:i want|i need) you to\b|\bremind me (?:to|about|of)\b|\bschedule (?:it|this|that)\b|\bsave (?:it|this|that) as a task\b/gi, " ")
    .replace(/^\s*(?:hey|hi|hello|ok(?:ay)?)?,?\s*tony\b[,!.]?/i, " ")
    .replace(/\bsave (?:this|it|that)(?: (?:youtube |instagram )?(?:video|link|reel|post|photo))?\b/gi, " ")
    .replace(/\b(?:after|in|within|for) (?:a|an|one|two|three|four|five|six|seven|ten|\d{1,2}) (?:days?|weeks?|hours?|minutes?)\b/gi, " ")
    .replace(/\bremind me(?: about it| of it)?\b[.!]?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function notesToKeep(message: string, saved: { title: string; notes: string | null; parts?: string[] }[]): string | undefined {
  const all = saved.map((task) => [task.title, task.notes ?? "", ...(task.parts ?? [])].join(" "));
  const missingLinks = linksIn(message).filter((url) => !all.some((text) => text.includes(url)));
  // What is quoted is his request without its instructions ("remind me to", "save this"): details, never orders to Tony.
  const words = withoutInstructions(message.replace(/https?:\/\/\S+/g, "")).replace(/\s+/g, " ").trim();
  const quote = lostDetails(withoutInstructions(message), all).length >= 2 && words.length > 0 ? `From your message: "${words}"` : undefined;
  const lines = [...missingLinks, quote].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

// ── 5. Voice notes in English, Uzbek or Russian ─────────────────────────

const LANGUAGES: Record<string, string> = { en: "en", english: "en", uz: "uz", uzbek: "uz", ru: "ru", russian: "ru" };

/** "en", "uz" or "ru" for a language Whisper reports (a code or a name); undefined for any other. */
export function allowedLanguage(language: string | undefined): string | undefined {
  return language ? LANGUAGES[language.trim().toLowerCase()] : undefined;
}

export type Transcript = { language: string; text: string; logprob: number };

/** Of several readings of one voice note, the most confident (then the longest). */
export function bestTranscript(readings: Transcript[]): Transcript | undefined {
  return [...readings].filter((reading) => reading.text.trim()).sort((a, b) => b.logprob - a.logprob || b.text.length - a.text.length)[0];
}

// ── 4. Notes are added to, never replaced ──────────────────────────────

/** A task's notes with new words added: nothing he said before is lost (task 11 lost its first link). */
export function mergeNotes(existing: string | null | undefined, incoming: string): string {
  const old = (existing ?? "").trim();
  const add = incoming.trim();
  if (!old) return add;
  if (!add || old.includes(add)) return old;
  // The model wrote everything again, with something new: keep its fuller version.
  if (add.includes(old)) return add;
  return `${old}\n${add}`;
}

// ── 8. The night: "tomorrow" is the day after he sleeps ────────────────

const DAY_MS = 24 * 60 * 60_000;
const localYmd = (at: Date) => new Date(at.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Between 00:00 and 05:00, "tomorrow" means the coming morning. A time the
 * model put on the next calendar day for "tomorrow" is brought back a day.
 * Undefined when there is nothing to correct.
 */
export function nightTomorrow(due: Date, said: string, now: Date): Date | undefined {
  if (new Date(now.getTime() + TZ_OFFSET_MS).getUTCHours() >= 5) return undefined;
  if (!/\b(tomorrow|tmrw?|tomm?orr?ow)\b/i.test(said) || /\bday after\b/i.test(said)) return undefined;
  if (localYmd(due) !== localYmd(new Date(now.getTime() + DAY_MS))) return undefined;
  const back = new Date(due.getTime() - DAY_MS);
  return back.getTime() > now.getTime() ? back : undefined;
}

// ── 9. Memory: only what he said ───────────────────────────────────────

const FACT_FILLER = new Set(
  "he his him himself user behruzbek they their them that this these those with from into about should would could always never also likes like prefers prefer wants want lives live works work does doing done have has had been being will shall the and for are was were sir tony".split(" "),
);
const factStems = (text: string) => [...new Set((text.toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter((word) => !FACT_FILLER.has(word)).map((word) => word.slice(0, 4)))];

/**
 * Whether a fact is his: most of its words are in what he wrote (in any
 * form: "works out" meets "work out"). Facts from Tony's own replies, or
 * guessed ("Khiva area" when he said Khanqa), are not.
 */
export function statedByHim(fact: string, hisWords: string): boolean {
  const wanted = factStems(fact);
  if (wanted.length === 0) return true;
  const his = new Set(factStems(hisWords));
  return wanted.filter((stem) => his.has(stem)).length / wanted.length >= 0.6;
}

// ── 10. Nothing about Tony's machinery ─────────────────────────────────

const INTERNAL = [
  /\b(my|the|an?)\s+(overdue\s+|task\s+|list\s+|search\s+|date\s+|day\s+)?filter\b/i,
  /\b(i have no|i don'?t have (a|any)|there is no|there'?s no|without (a|the))\s+tools?\b/i,
  /\bmy\s+tools?\b/i,
  /\b(tool|function|api|lookup|query|search)\s+(calls?|failed|returned|came back|errored|errors?)\b/i,
  /\b(came back empty|returned (an? )?(error|nothing|empty)|internal error|error code|stack trace)\b/i,
  /\b(add_task|update_task|complete_task|list_tasks|set_reminder|save_link|offer_task|web_search|web_fetch|runTool)\b/,
];

/**
 * Each line, split into sentences, kept only where `keep` says so. A line
 * nothing was taken from stays exactly as it was (indentation, list marker),
 * blank lines between sections stay, and a line emptied by the filter goes.
 */
const filterSentences = (reply: string, keep: (sentence: string) => boolean) =>
  reply
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      const marker = /^\s*(?:[-*•]|\d+\.)\s+(?:\[[ xX]\]\s+)?/.exec(line)?.[0] ?? "";
      const sentences = line.slice(marker.length).split(/(?<=[.!?])\s+/);
      const kept = sentences.filter((sentence) => sentence.trim() && keep(sentence));
      if (kept.length === sentences.length) return line;
      return kept.length ? `${marker}${kept.join(" ")}` : null;
    })
    .filter((line): line is string => line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** The reply without sentences about tools, filters or errors (22:38: "The overdue filter came back empty"). */
export function withoutInternals(reply: string): string {
  return filterSentences(reply, (sentence) => !INTERNAL.some((pattern) => pattern.test(sentence)));
}

// ── 1. Never claim a send that did not happen ──────────────────────────

const SEND_CLAIM = /\b(here (it is|is|'s|you go|they are)|attached|i('ve| have) sent|sending (it|you))\b/i;

/** The reply without "Here it is, sir" and the like, for when nothing was sent (15:41, 22:39). */
export function withoutSendClaims(reply: string): string {
  return filterSentences(reply, (sentence) => !SEND_CLAIM.test(sentence));
}

// ── Phase 2: Tony's own words stay, with the receipt under them ─────────

/** Clock times in some words, as "HH:MM" ("8.30" → "08:30"). */
export function clockTimes(text: string): string[] {
  return [...text.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)].map((match) => `${match[1].padStart(2, "0")}:${match[2]}`);
}

/**
 * What Tony says as himself, around a task he has just handled: kept as he
 * said it, except sentences that claim an action ("Done, sir, set for 9:00":
 * the receipt says what was done), name a time that is in none of his words
 * nor stored, mention tools or errors. Lists, headings and blank lines stay.
 */
export function keepWords(words: string, allowed: { times: string[] }): string {
  const times = new Set(allowed.times);
  return filterSentences(words, (sentence) => !claimsAction(sentence) && !INTERNAL.some((pattern) => pattern.test(sentence)) && clockTimes(sentence).every((time) => times.has(time)));
}

/**
 * Advice and discussion ("help me plan my course launch", "what do you
 * think…") get more thought and room to answer; a task or a quick question
 * does not.
 */
export function wantsThought(text: string): boolean {
  const t = text.toLowerCase();
  if (isCapture(text)) return false;
  return (
    /\b(help me (plan|think|decide|figure|grow|write|prepare|choose|understand|improve)|how (do|can|should|would|could) i\b|what do you think|what would you (do|suggest)|should i\b|any (ideas|advice|tips|suggestions)|ideas? for\b|advice|strategy|brainstorm|pros and cons|compare\b|explain\b|why (do|does|is|are|did|would)\b|what'?s the best way|plan (my|a|the) (course|launch|business|content|channel|week|month|year|lessons?)|grow my\b)/.test(t) ||
    (t.length > 240 && /\?/.test(t))
  );
}

/** Words that are Uzbek: o'/g' (in any of their spellings), or endings an English word does not have. */
const UZ_MARK = /^(?!o['‘’ʻ`]?clock)[a-z]*[og]['‘’ʻ`][a-z]{2,}$/i;
const UZ_ENDING = /^[a-z]{3,}(ish|moq|lar|lari|ning|ni|ga|dan|lik|chi|gan|siz|imni|ingiz)$/i;
const NOT_UZ = new Set("english finish publish polish wish fish dish british spanish selfish establish cherish flourish punish vanish radish foolish childish stylish furnish nourish perish garnish rubbish dollar dollars cellar collar pillar regular popular similar solar polar lunar sugar cigar again began organ vegan logan slogan woman human german roman cardigan".split(" "));
const isUzbekWord = (word: string) => UZ_MARK.test(word) || (UZ_ENDING.test(word) && !NOT_UZ.has(word.toLowerCase()));
/** Time words in Uzbek and Russian that do not belong in a title. */
const TRAILING = /[\s,.-]+(в|во|на|к|до|завтра|сегодня|утром|вечером|ertaga|bugun|kechqurun|ertalab|soat)$/i;

/**
 * His own Uzbek or Russian words in the message ("Zamokli ko'ynak olish"),
 * as he wrote them: a run of Cyrillic, or a clause with an o'/g' word or
 * two Uzbek-looking words. Undefined for an English message.
 */
export function foreignPhrase(text: string): string | undefined {
  const tidy = (phrase: string) => {
    let out = phrase.trim().replace(/[\s,.;:!?-]+$/, "");
    while (TRAILING.test(out)) out = out.replace(TRAILING, "").trim();
    return out || undefined;
  };
  const cyrillic = /[Ѐ-ӿ][Ѐ-ӿ\s,'’-]*/.exec(text)?.[0];
  if (cyrillic && cyrillic.replace(/[^Ѐ-ӿ]/g, "").length >= 3) return tidy(cyrillic);
  for (const clause of text.split(/\s*[.!?;\n]+\s*|\s+(?=\b(?:put|remind|add|and remind|please|save)\b)/i)) {
    const words = clause.match(/[\p{L}'‘’ʻ`]+/gu) ?? [];
    const uzbek = words.filter(isUzbekWord);
    if (uzbek.length >= 2 || (uzbek.some((word) => UZ_MARK.test(word)) && words.length <= 6)) return tidy(clause);
  }
  return undefined;
}

/** The model's title, unless it translated his Uzbek or Russian words: then his words are the title (23:17). */
export function hisTitle(modelTitle: string, said: string): string {
  const phrase = foreignPhrase(said);
  if (!phrase) return modelTitle;
  const stems = (text: string) => new Set((text.toLowerCase().match(/[\p{L}'‘’ʻ`]{3,}/gu) ?? []).map((word) => word.slice(0, 4)));
  const his = stems(phrase);
  if ([...stems(modelTitle)].some((stem) => his.has(stem))) return modelTitle;
  return phrase.length <= 80 ? phrase[0].toUpperCase() + phrase.slice(1) : modelTitle;
}
