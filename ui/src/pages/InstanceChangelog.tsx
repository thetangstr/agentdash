import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listReleaseNotes } from "@/lib/release-notes";

const MAX_RELEASES = 8;
const MAX_ITEMS_PER_SECTION = 5;

export function InstanceChangelog() {
  const notes = listReleaseNotes().slice(0, MAX_RELEASES);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-bold text-foreground">Changelog</h1>
      </div>

      <div className="flex flex-col gap-4">
        {notes.map((note) => (
          <Card key={note.version}>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{note.version}</CardTitle>
                {note.releasedAt ? <Badge variant="secondary">{note.releasedAt}</Badge> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {note.sections.slice(0, 4).map((section) => (
                <section key={`${note.version}-${section.title}`} className="space-y-2">
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    {section.title}
                  </h2>
                  <ul className="space-y-1 text-sm text-foreground">
                    {section.items.slice(0, MAX_ITEMS_PER_SECTION).map((item) => (
                      <li key={item} className="leading-6">
                        {item}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
