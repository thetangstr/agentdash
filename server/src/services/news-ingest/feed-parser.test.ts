import { describe, it, expect } from "vitest";
import { parseFeed } from "./feed-parser.js";

const RSS = `<?xml version="1.0"?><rss><channel>
<title>Example Wire</title>
<item><title>War breaks out in Country X</title>
<link>https://ex.com/a</link>
<description>Fighting began today.</description>
<pubDate>Sun, 14 Jun 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Wire</title>
<entry><title>New particle discovered</title>
<link href="https://ex.com/b"/>
<summary>Physicists report a find.</summary>
<updated>2026-06-14T09:00:00Z</updated></entry></feed>`;

describe("parseFeed", () => {
  it("parses RSS items", () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("War breaks out in Country X");
    expect(items[0].link).toBe("https://ex.com/a");
    expect(items[0].outlet).toBe("Example Wire");
    expect(items[0].publishedAt?.getUTCFullYear()).toBe(2026);
  });
  it("parses Atom entries", () => {
    const items = parseFeed(ATOM);
    expect(items[0].title).toBe("New particle discovered");
    expect(items[0].link).toBe("https://ex.com/b");
  });
  it("returns [] on garbage", () => {
    expect(parseFeed("not xml")).toEqual([]);
  });
});
