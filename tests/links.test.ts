/**
 * Links: his real messages from 20 Nov, 23:22–23:39.
 */
import { describe, expect, it } from "vitest";
import { asksForLink, asksToAttachLink, carriesMedia, isGenericTitle, ownWords, rankLinks, refersToLink, titleForLink, wordsAround } from "../src/lib/link-rules";

describe("'Send me the video' is a request for the link", () => {
  it("spots it", () => {
    expect(asksForLink("send me the video to just to check")).toBe(true);
    expect(asksForLink("can u send it even now the link o podcast and wevrhthing i told")).toBe(true);
    expect(asksForLink("what was the link?")).toBe(true);
    expect(asksForLink("send me the forum poster picture")).toBe(false);
    expect(asksForLink("just send me tasks for tmr")).toBe(false);
    // A task, not a request to Tony.
    expect(asksForLink("remind me to send the video to Aziz tomorrow")).toBe(false);
  });
  it("finds the one he means", () => {
    const candidates = [
      { url: "https://youtu.be/SaiTtbRJwic", title: "Watch: Instagram Masterclass (Brock Johnson)", context: "", at: 2 },
      { url: "https://www.youtube.com/watch?v=Ch4Sl0POBhU", title: "Watch podcast and take notes", context: "Caleb Ralston, How to Build a Personal Brand", at: 1 },
      { url: "https://www.instagram.com/reel/DfoBspQhNjO/", title: "Instagram reel (saved link)", context: "", at: 3 },
    ];
    expect(rankLinks("send me the podcast link", candidates)[0].url).toBe("https://www.youtube.com/watch?v=Ch4Sl0POBhU");
    expect(rankLinks("send me the masterclass", candidates)[0].url).toBe("https://youtu.be/SaiTtbRJwic");
    expect(rankLinks("send me the reel", candidates)[0].url).toBe("https://www.instagram.com/reel/DfoBspQhNjO/");
    // No words to go on: the newest.
    expect(rankLinks("send me the video to just to check", candidates)[0].url).toBe("https://www.instagram.com/reel/DfoBspQhNjO/");
  });
  it("means the task Tony just reminded him of (21 Nov: 'Send me link' got the podcast)", () => {
    const candidates = [
      { url: "https://www.youtube.com/watch?v=Ch4Sl0POBhU", title: "Watch podcast and take notes", context: "", at: 9 },
      { url: "https://www.instagram.com/reel/DfoBspQhNjO/", title: "Instagram reel (saved link)", context: "", at: 1 },
    ];
    expect(asksForLink("Send me link")).toBe(true);
    expect(rankLinks("Send me link", candidates, ["Sir, a reminder: Instagram reel (saved link)."])[0].url).toBe("https://www.instagram.com/reel/DfoBspQhNjO/");
    expect(rankLinks("send me the instagram link", candidates)[0].url).toBe("https://www.instagram.com/reel/DfoBspQhNjO/");
  });
});

describe("Never asking whether to attach a link he just sent", () => {
  it("spots the question (23:23, 23:25)", () => {
    expect(asksToAttachLink("Shall I add the link to the notes of that task, sir?")).toBe(true);
    expect(asksToAttachLink("Which should I attach to Watch the video on Monday, sir?")).toBe(true);
    expect(asksToAttachLink("Attach the screenshot and link to Watch the video?")).toBe(true);
    expect(asksToAttachLink("✓ **Watch the video** → Mon 23 Nov **10:00**, sir.")).toBe(false);
  });
  it("knows when his words point at the link", () => {
    expect(refersToLink("Remind me to watch this video in the upcoming Monday.")).toBe(true);
    expect(refersToLink("I want you to save it as a task for me to watch in the Monday.")).toBe(true);
  });
});

describe("Titles from the page", () => {
  it("replaces a title that says nothing", () => {
    expect(isGenericTitle("Watch the video")).toBe(true);
    expect(isGenericTitle("Watch: Mosseri AI setup")).toBe(false);
    expect(titleForLink("Watch the video", "https://youtu.be/SaiTtbRJwic", "THE Instagram Masterclass: How To Grow in 2027 - YouTube")).toBe("Watch: THE Instagram Masterclass: How To Grow in 2027");
    expect(titleForLink("Read this", "https://example.com/post", "How to plan a week")).toBe("Read: How to plan a week");
    expect(titleForLink("Watch: Mosseri AI setup", "https://youtu.be/CN8c1edTCew", "Head of Instagram Reveals…")).toBe("Watch: Mosseri AI setup");
  });
});

describe("21 Nov 18:11: 'send me this video when i needed motivation' with a forwarded video", () => {
  const message =
    "send me this video when i needed motivation\n\n[He forwarded this to you]\n«««\nA video forwarded from Save As Bot — скачать\nСпасибо, что пользуетесь - @SaveAsBot'ом\n(A video; you cannot see inside it.)\n(Saved. It can be attached to a task or filed under a label.)\n»»»";
  it("is a rule with his own video, not a request for an old link", async () => {
    const { isRuleRequest } = await import("../src/lib/smart-rules");
    expect(ownWords(message)).toBe("send me this video when i needed motivation");
    expect(carriesMedia(message)).toBe(true);
    expect(isRuleRequest(ownWords(message))).toBe(true);
    expect(isRuleRequest("send me that video")).toBe(false);
    expect(isRuleRequest("can you send it to me with this image?")).toBe(false);
  });
  it("'this video' means the link he sent last, not old ones sharing filler words", () => {
    const candidates = [
      { url: "https://youtu.be/SaiTtbRJwic", title: "Watch: Instagram Masterclass (Brock Johnson)", context: "THE Instagram Masterclass: How To Grow in 2027", at: 1 },
      { url: "https://www.instagram.com/reel/DfoBspQhNjO/", title: "instagram.com", context: "I can't open this reel from here, sir, so I can't tell you what it covers. I haven't saved anything.", at: 2 },
      { url: "https://www.instagram.com/reel/Df6Ja3OR_PK/", title: "Shoot videos like this reel", context: "the style of video he wants to shoot", at: 3 },
    ];
    const ranked = rankLinks(message, candidates);
    expect(ranked[0].url).toBe("https://www.instagram.com/reel/Df6Ja3OR_PK/");
    // The boilerplate ("you", "can", "saved") no longer counts as his words.
    expect(ranked.find((item) => item.url.includes("DfoBspQhNjO"))!.words).toBe(0);
  });
});

describe("the brain's list of his links", () => {
  it("names each link by what he said and its task, never by a downloader's thank-you", async () => {
    const { isPromoCaption, libraryLine } = await import("../src/lib/library-rules");
    const now = new Date("2026-11-21T13:20:00Z");
    const line = libraryLine({ source: "library", id: 1, kind: "link", url: "https://www.instagram.com/reel/Df6Ja3OR_PK/", title: "Sevara on Instagram", description: "i have to shoot this type of videos", task_id: 48, created_at: "2026-11-21T13:10:16Z" }, now, "Shoot videos like this reel");
    expect(line).toBe('library:1 ▶️ Sevara on Instagram · today 18:10 · Instagram reel · he said: "i have to shoot this type of videos" · task #48 Shoot videos like this reel');
    expect(isPromoCaption("​​Спасибо, что пользуетесь - @SaveAsBot'ом")).toBe(true);
    expect(isPromoCaption("Downloaded via @SaveAsBot")).toBe(true);
    expect(isPromoCaption("add this feature to webstie")).toBe(false);
    expect(wordsAround("https://www.instagram.com/reel/Df6Ja3OR_PK/?jplx=1\n\ni have to shoot this type of videos")).toBe("i have to shoot this type of videos");
  });
});

describe("a task's link rides on its reminder", () => {
  it("names the button by what the link is", async () => {
    const { openButton } = await import("../src/lib/link-rules");
    expect(openButton("https://www.instagram.com/reel/DfoBspQhNjO/?fqnt=MW9saDhkYjlwNDB1ag==")).toEqual({ text: "▶️ Watch the reel", url: "https://www.instagram.com/reel/DfoBspQhNjO/?fqnt=MW9saDhkYjlwNDB1ag==" });
    expect(openButton("https://youtu.be/SaiTtbRJwic?si=QDE5KH85brvKxVVi — THE Instagram Masterclass")?.text).toBe("▶️ Watch the video");
    expect(openButton("https://behruznrl-nurullayevbehruzbek185-4463s-projects.vercel.app")?.text).toBe("🔗 Open the link");
    expect(openButton("English File Elementary")).toBeUndefined();
  });
});
