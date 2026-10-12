/**
 * Co-worker slice 5: files sent through the bridge or attached by an agent are
 * versions of one name on their issue (`plan v2 (Person A).docx`). The issue
 * marks the newest version of each name as current and the others as older.
 * A file a person attached on the page has no version and no marker.
 */
export type AttachmentVersionMarker = { text: string; current: boolean; title: string };

export function attachmentVersionMarker(attachment: {
  version?: number | null;
  isCurrent?: boolean;
}): AttachmentVersionMarker | null {
  if (typeof attachment.version !== "number") return null;
  if (attachment.isCurrent === false) {
    return {
      text: "older version",
      current: false,
      title: `Version ${attachment.version}; a newer version of this file is on the issue.`,
    };
  }
  return { text: "current", current: true, title: `Version ${attachment.version}, the current version of this file.` };
}
