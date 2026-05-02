/**
 * AgentDash: Markdown -> .docx renderer for project assessments.
 *
 * Walks the markdown line-by-line and emits Word paragraphs, headings, and
 * bullet/numbered lists. Deliberately simple — we only need to handle the 7
 * locked sections produced by buildReportSystemPrompt() (## headings, ###
 * subheadings, paragraphs, **bold**, *italic*, `inline code`, `- ` bullets,
 * and `1. ` numbered lists).
 *
 * No persistence. The route calls this on demand and streams the buffer back
 * as a download.
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
  type IRunOptions,
} from "docx";

export interface BuildDocxInput {
  markdown: string;
  projectName: string;
  companyName: string;
}

const NUMBERING_REF = "agentdash-numbered-list";

export async function buildProjectDocx(input: BuildDocxInput): Promise<Buffer> {
  const { markdown, projectName, companyName } = input;

  const children: Paragraph[] = [];

  // Title page lines
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 480, after: 120 },
      children: [
        new TextRun({
          text: `${companyName} — ${projectName}`,
          bold: true,
          size: 40,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
      children: [
        new TextRun({
          text: "AgentDash · Project Assessment",
          size: 24,
          color: "777777",
        }),
      ],
    }),
  );

  // Body
  children.push(...renderMarkdownToParagraphs(markdown));

  const doc = new Document({
    creator: "AgentDash",
    title: `${companyName} — ${projectName}`,
    description: "AgentDash project assessment",
    numbering: {
      config: [
        {
          reference: NUMBERING_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [{ properties: {}, children }],
  });

  const buf = await Packer.toBuffer(doc);
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

/* ------------------------------------------------------------------ */
/*  Markdown walker                                                     */
/* ------------------------------------------------------------------ */

function renderMarkdownToParagraphs(md: string): Paragraph[] {
  const out: Paragraph[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (trimmed.length === 0) { i++; continue; }

    // ATX headings
    if (/^#{1,6}\s+/.test(trimmed)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(trimmed)!;
      const level = m[1].length;
      const text = m[2].trim();
      out.push(makeHeading(text, level));
      i++;
      continue;
    }

    // Bullet list block — collect consecutive lines starting with - or *
    if (/^[-*+]\s+/.test(trimmed)) {
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        const itemText = lines[i].trim().replace(/^[-*+]\s+/, "");
        out.push(makeBullet(itemText));
        i++;
      }
      continue;
    }

    // Numbered list block — collect consecutive lines like "1. foo"
    if (/^\d+\.\s+/.test(trimmed)) {
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const itemText = lines[i].trim().replace(/^\d+\.\s+/, "");
        out.push(makeNumbered(itemText));
        i++;
      }
      continue;
    }

    // Horizontal rule — render as a thin separator paragraph (skip for now)
    if (/^[-*_]{3,}$/.test(trimmed)) {
      out.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
      i++;
      continue;
    }

    // Default: paragraph (collect until blank line or block start)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !/^#{1,6}\s+/.test(lines[i].trim()) &&
      !/^[-*+]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    if (paraLines.length > 0) {
      out.push(makeParagraph(paraLines.join(" ")));
    }
  }

  return out;
}

function makeHeading(text: string, level: number): Paragraph {
  // h1 -> Heading1, h2 -> Heading1, h3 -> Heading2, h4+ -> Heading3
  let heading: (typeof HeadingLevel)[keyof typeof HeadingLevel];
  if (level <= 2) heading = HeadingLevel.HEADING_1;
  else if (level === 3) heading = HeadingLevel.HEADING_2;
  else heading = HeadingLevel.HEADING_3;
  return new Paragraph({
    heading,
    spacing: { before: 280, after: 120 },
    children: parseInline(text),
  });
}

function makeParagraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 160 },
    children: parseInline(text),
  });
}

function makeBullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 80 },
    children: parseInline(text),
  });
}

function makeNumbered(text: string): Paragraph {
  return new Paragraph({
    numbering: { reference: NUMBERING_REF, level: 0 },
    spacing: { after: 80 },
    children: parseInline(text),
  });
}

/* ------------------------------------------------------------------ */
/*  Inline formatting (bold, italic, code)                              */
/* ------------------------------------------------------------------ */

interface RunSpec {
  text: string;
  bold?: boolean;
  italics?: boolean;
  code?: boolean;
}

function parseInline(text: string): TextRun[] {
  const specs = splitInline(text);
  return specs.map(toTextRun);
}

function toTextRun(spec: RunSpec): TextRun {
  const opts: IRunOptions = {
    text: spec.text,
    bold: spec.bold,
    italics: spec.italics,
    ...(spec.code
      ? {
          font: "Consolas",
          shading: { type: "clear", fill: "F2F2F2", color: "auto" },
        }
      : {}),
  };
  return new TextRun(opts);
}

/**
 * Tokenize inline markdown into runs. Handles:
 *   **bold**, __bold__
 *   *italic*, _italic_
 *   `code`
 * Falls back to literal text on malformed input.
 */
function splitInline(input: string): RunSpec[] {
  const out: RunSpec[] = [];
  let i = 0;
  let buf = "";

  const flush = () => {
    if (buf.length > 0) {
      out.push({ text: buf });
      buf = "";
    }
  };

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    // Code: `...`
    if (ch === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ text: input.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }

    // Bold: **...** or __...__
    if ((ch === "*" && next === "*") || (ch === "_" && next === "_")) {
      const marker = ch + next;
      const end = input.indexOf(marker, i + 2);
      if (end > i + 1) {
        flush();
        // Recurse to handle italic/code inside bold
        const inner = splitInline(input.slice(i + 2, end));
        for (const r of inner) {
          out.push({ ...r, bold: true });
        }
        i = end + 2;
        continue;
      }
    }

    // Italic: *...* or _..._  (single)
    if ((ch === "*" || ch === "_") && next !== ch) {
      const end = input.indexOf(ch, i + 1);
      if (end > i) {
        flush();
        const inner = splitInline(input.slice(i + 1, end));
        for (const r of inner) {
          out.push({ ...r, italics: true });
        }
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}
