import { XMLParser } from "fast-xml-parser";
import type { NewsItem } from "./types.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return text((v as Record<string, unknown>)["#text"]);
  }
  return null;
}

function atomLink(link: unknown): string | null {
  if (typeof link === "string") return link.trim() || null;
  if (Array.isArray(link)) {
    const alt = link.find((l) => l?.["@_rel"] === "alternate") ?? link[0];
    return alt?.["@_href"] ?? null;
  }
  if (link && typeof link === "object") return (link as Record<string, string>)["@_href"] ?? null;
  return null;
}

function parseDate(v: unknown): Date | null {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function parseFeed(xml: string): NewsItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }
  const rss = (doc.rss as { channel?: Record<string, unknown> })?.channel;
  if (rss) {
    const outlet = text(rss.title);
    return toArray(rss.item as Record<string, unknown>[]).map((it) => ({
      title: text(it.title) ?? "(untitled)",
      link: text(it.link) ?? "",
      summary: text(it.description),
      publishedAt: parseDate(it.pubDate),
      outlet,
    })).filter((i) => i.link);
  }
  const feed = doc.feed as Record<string, unknown> | undefined;
  if (feed) {
    const outlet = text(feed.title);
    return toArray(feed.entry as Record<string, unknown>[]).map((e) => ({
      title: text(e.title) ?? "(untitled)",
      link: atomLink(e.link) ?? "",
      summary: text(e.summary) ?? text(e.content),
      publishedAt: parseDate(e.updated) ?? parseDate(e.published),
      outlet,
    })).filter((i) => i.link);
  }
  return [];
}
