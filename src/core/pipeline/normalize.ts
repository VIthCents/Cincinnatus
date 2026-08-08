import type { Hasher } from "../ports.ts";
import type { SourceId } from "../types.ts";

/**
 * Text normalisation shared by every source.
 *
 * ON CONSTRAINT 1. This file contains an HTML entity decoder and a tag
 * stripper, which deserves an explicit note so nobody has to guess later.
 *
 * The constraint forbids fetching and parsing *job sites' pages*. What happens
 * here is different in kind: the only HTML we ever touch is a text field inside
 * a JSON document returned by a documented public API on an allowlisted host.
 * We never issue a request whose response is a web page — the allowlist in
 * src/core/net/allowlist.ts makes that a runtime error, and it deliberately
 * excludes job-boards.greenhouse.io, which is the HTML host of boards we
 * otherwise use.
 *
 * So: decoding a JSON string field, yes. Fetching or parsing a page, never.
 * Do not use anything here as licence to add an HTML fetcher.
 */

// -----------------------------------------------------------------------------
// HTML entities
// -----------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  trade: "™",
  reg: "®",
  copy: "©",
  deg: "°",
  plusmn: "±",
  frac12: "½",
  eacute: "é",
  egrave: "è",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  ccedil: "ç",
  ntilde: "ñ",
};

/** One decode pass. Call twice for double-encoded input. */
export function decodeEntities(input: string): string {
  return input.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const isHex = body[1] === "x" || body[1] === "X";
        const digits = isHex ? body.slice(2) : body.slice(1);
        const code = Number.parseInt(digits, isHex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/** Remove tags, turning block boundaries into newlines so words do not fuse. */
export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
}

export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Remove Greenhouse's per-board `content-intro` block.
 *
 * Greenhouse lets an employer set one intro blurb that is prepended to *every*
 * posting on their board. On a board like Anduril's, that identical paragraph
 * can be a third of the text we embed, so every job on the board ends up with a
 * vector dominated by the same tokens and the cosine spread within the board
 * collapses toward a constant. That is a ranking bug that raises no error and
 * fails no test — the list just quietly stops discriminating.
 *
 * Depth-counted rather than regex-matched because the blurb often contains
 * nested divs.
 */
export function stripContentIntro(html: string): string {
  const openTag = /<div\b[^>]*class\s*=\s*["'][^"']*\bcontent-intro\b[^"']*["'][^>]*>/i;
  const match = openTag.exec(html);
  if (match === null) return html;

  const start = match.index;
  let cursor = start + match[0].length;
  let depth = 1;

  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = cursor;

  for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) {
      cursor = m.index + m[0].length;
      return html.slice(0, start) + html.slice(cursor);
    }
  }

  // Unbalanced markup: drop from the marker to the end rather than guess.
  return html.slice(0, start);
}

/**
 * Greenhouse `content` to plain text.
 *
 * The field is **double** HTML-entity-encoded — the raw JSON contains no
 * literal `<` at all, and contains `&amp;nbsp;`. One decode pass leaves visible
 * `&nbsp;` and `&amp;` in the text, which then get embedded as if they were
 * words.
 */
export function greenhouseContentToText(rawContent: string): string {
  const once = decodeEntities(rawContent);
  const twice = decodeEntities(once);
  return collapseWhitespace(stripTags(stripContentIntro(twice)));
}

/** For sources that ship real HTML (single-encoded). */
export function htmlToText(html: string): string {
  return collapseWhitespace(stripTags(decodeEntities(html)));
}

// -----------------------------------------------------------------------------
// Identity and dedupe keys
// -----------------------------------------------------------------------------

export function makeJobId(
  hasher: Hasher,
  source: SourceId,
  externalId: string,
): string {
  return hasher.sha256Hex(`${source}:${externalId}`);
}

/** Lower-case, strip punctuation and legal suffixes, collapse spaces. */
export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(
      /\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|labs|holdings|group|the)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lower-case, drop punctuation, and fold Roman numerals and spelled-out level
 * numbers so "Maintenance Technician II" and "Maintenance Technician 2" agree.
 */
export function normalizeTitle(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const ROMAN: Readonly<Record<string, string>> = {
    i: "1",
    ii: "2",
    iii: "3",
    iv: "4",
    v: "5",
    vi: "6",
  };

  return base
    .split(" ")
    .map((word) => ROMAN[word] ?? word)
    .join(" ");
}

/**
 * Coarse location key. Two postings only collapse if they are in the same
 * place, and "same place" here means the first comma-separated component plus
 * any state code — enough to keep Austin and Boston apart without pretending we
 * can geocode.
 */
export function metroKey(location: string | null): string {
  if (location === null) return "";
  const lower = location.toLowerCase();
  if (/\bremote\b/.test(lower)) return "remote";
  const parts = lower
    .split(/[,|/]/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const city = parts[0] ?? "";
  const state = parts[1] ?? "";
  return `${city.replace(/[^a-z0-9 ]+/g, "").trim()}|${state.replace(/[^a-z0-9 ]+/g, "").trim()}`;
}

export function makeDedupeKey(
  company: string,
  title: string,
  location: string | null,
): string {
  return `${normalizeCompany(company)}::${normalizeTitle(title)}::${metroKey(location)}`;
}
