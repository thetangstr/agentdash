// AgentDash: what a box runs (spec §3.3 step 6, GH #732, #763).
//   image  (default) ghcr.io/thetangstr/agentdash:<tag>, pinned BY DIGEST so a
//          retagged image can never change a box;
//   source (fallback) the release tag's commit, built by Railway from the
//          public repository, for a tag with no image.
// Outbound calls go to GHCR and GitHub's public API only, anonymously.
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

export const RELEASE_TAG_RE = /^v\d{4}\.\d{3,4}\.\d+$/;

export class ImageNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageNotFound";
  }
}

/** `ghcr.io/<owner>/<repo>` → the digest of `<tag>`, or ImageNotFound. */
export async function resolveImageDigest(
  imageRepo: string,
  tag: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const f = opts.fetch ?? fetch;
  if (!imageRepo.startsWith("ghcr.io/")) throw new Error(`only ghcr.io images are supported, got ${imageRepo}`);
  if (!RELEASE_TAG_RE.test(tag)) throw new Error(`not a release tag: ${tag}`);
  const repo = imageRepo.slice("ghcr.io/".length);
  const tokenRes = await f(`https://ghcr.io/token?scope=repository:${repo}:pull`, { signal: opts.signal });
  if (!tokenRes.ok) throw new Error(`GHCR token request answered HTTP ${tokenRes.status}`);
  const { token } = (await tokenRes.json()) as { token?: string };
  const res = await f(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${token ?? ""}`, accept: MANIFEST_ACCEPT },
    signal: opts.signal,
  });
  if (res.status === 404) throw new ImageNotFound(`no image at ${imageRepo}:${tag}`);
  if (!res.ok) throw new Error(`GHCR manifest request for ${imageRepo}:${tag} answered HTTP ${res.status}`);
  const digest = res.headers.get("docker-content-digest");
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`GHCR returned no usable digest for ${imageRepo}:${tag}`);
  return digest;
}

/** The commit a release tag points at, from GitHub's public API (annotated tags are dereferenced). */
export async function resolveTagCommit(
  sourceRepo: string,
  tag: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const f = opts.fetch ?? fetch;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepo)) throw new Error(`not an owner/repo: ${sourceRepo}`);
  if (!RELEASE_TAG_RE.test(tag)) throw new Error(`not a release tag: ${tag}`);
  const get = async (url: string) => {
    const res = await f(url, { headers: { accept: "application/vnd.github+json", "user-agent": "agentdash-cloud-control" }, signal: opts.signal });
    if (res.status === 404) throw new ImageNotFound(`no tag ${tag} in ${sourceRepo}`);
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${url}`);
    return (await res.json()) as { object?: { sha?: string; type?: string } };
  };
  let ref = await get(`https://api.github.com/repos/${sourceRepo}/git/ref/tags/${tag}`);
  for (let i = 0; i < 3 && ref.object?.type === "tag"; i++) {
    ref = await get(`https://api.github.com/repos/${sourceRepo}/git/tags/${ref.object.sha}`);
  }
  const sha = ref.object?.sha;
  if (ref.object?.type !== "commit" || !sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`tag ${tag} does not resolve to a commit`);
  return sha;
}
