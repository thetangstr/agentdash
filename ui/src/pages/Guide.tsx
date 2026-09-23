import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { MarkdownBody } from "@/components/MarkdownBody";
import { getGuide, renderGuide, type Guide as GuideDoc } from "@/lib/guides";

/**
 * One guide, with this instance's address in place of the token.
 *
 * The address is what the instance publishes, falling back to the browser's
 * origin when nothing is published — the same rule the connect command on My
 * Agent follows, so a guide and the page it describes never disagree.
 */
export function Guide() {
  const { group, slug } = useParams<{ group: string; slug: string }>();
  const guide = group && slug ? getGuide(group, slug) : null;

  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    staleTime: 5 * 60_000,
  });
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const instanceUrl = health?.publicBaseUrl?.trim() || browserOrigin;

  if (!guide) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
        <h1 className="text-xl font-bold text-foreground">No such guide</h1>
        <p className="text-sm text-muted-foreground">
          Nothing is filed at <code className="font-mono">{group}/{slug}</code>.{" "}
          <Link to="/guides" className="underline">
            All guides
          </Link>
        </p>
      </div>
    );
  }

  return <GuideView guide={guide} instanceUrl={instanceUrl} />;
}

/** The rendering, separated so it can be tested without a router or a server. */
export function GuideView({ guide, instanceUrl }: { guide: GuideDoc; instanceUrl: string }) {
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
      <nav className="text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link to="/guides" className="hover:underline">
          Guides
        </Link>
        <span className="mx-1">/</span>
        <span>{guide.title}</span>
      </nav>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-foreground">{guide.title}</h1>
        {guide.summary ? <p className="text-sm text-muted-foreground">{guide.summary}</p> : null}
      </header>
      <MarkdownBody linkIssueReferences={false}>{renderGuide(guide.body, { instanceUrl })}</MarkdownBody>
    </article>
  );
}
