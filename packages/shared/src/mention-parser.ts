export interface AgentDirEntry {
  id: string;
  name: string;
  role: string;
}

export interface Mention {
  agentId: string | null;
  matchText: string;
  startIndex: number;
  ambiguous?: boolean;
}

export function parseMentions(text: string, dir: AgentDirEntry[]): Mention[] {
  const mentions: Mention[] = [];
  const codeBlockRanges = findCodeRanges(text);
  const re = /@([A-Za-z][A-Za-z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (codeBlockRanges.some(([s, e]) => match!.index >= s && match!.index < e)) continue;
    const token = match[1].toLowerCase();
    const byName = dir.filter((a) => a.name.toLowerCase() === token);
    if (byName.length === 1) {
      mentions.push({ agentId: byName[0].id, matchText: match[0], startIndex: match.index });
      continue;
    }
    if (byName.length > 1) {
      mentions.push({ agentId: null, matchText: match[0], startIndex: match.index, ambiguous: true });
      continue;
    }
    const byRole = dir.filter((a) => a.role.toLowerCase() === token);
    if (byRole.length === 1) {
      mentions.push({ agentId: byRole[0].id, matchText: match[0], startIndex: match.index });
    } else if (byRole.length > 1) {
      mentions.push({ agentId: null, matchText: match[0], startIndex: match.index, ambiguous: true });
    } else {
      mentions.push({ agentId: null, matchText: match[0], startIndex: match.index });
    }
  }
  return mentions;
}

function findCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fenced = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenced.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  const inline = /`[^`\n]+`/g;
  while ((m = inline.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
