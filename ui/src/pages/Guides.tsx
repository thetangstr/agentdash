import { Link } from "@/lib/router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listGuides, type Guide } from "@/lib/guides";

/**
 * The index. Two groups, in the order a new person meets them: what they do,
 * then what their admin does. Nothing here is gated — an admin page a steward
 * can read is how they find out what to ask for.
 */
export function Guides() {
  const guides = listGuides();
  const forYou = guides.filter((guide) => guide.audience === "steward");
  const forAdmins = guides.filter((guide) => guide.audience !== "steward");

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-foreground">Guides</h1>
        <p className="text-sm text-muted-foreground">
          How to work with your agent from your own terminal, and how to bring someone else on.
          Every address below is this instance's own.
        </p>
      </div>

      <GuideGroup title="For you" guides={forYou} />
      <GuideGroup title="For admins" guides={forAdmins} />
    </div>
  );
}

function GuideGroup({ title, guides }: { title: string; guides: Guide[] }) {
  if (guides.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {guides.map((guide) => (
        <Card key={`${guide.group}/${guide.slug}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              <Link to={`/guides/${guide.group}/${guide.slug}`} className="hover:underline">
                {guide.title}
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-sm text-muted-foreground">{guide.summary}</CardContent>
        </Card>
      ))}
    </section>
  );
}
