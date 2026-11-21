/**
 * Links: his real messages from 20 Nov, 23:22–23:39.
 */
import { describe, expect, it } from "vitest";
import { asksForLink, asksToAttachLink, isGenericTitle, rankLinks, refersToLink, titleForLink } from "../src/lib/link-rules";

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
