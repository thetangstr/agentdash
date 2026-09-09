import { useEffect } from "react";

/**
 * Per-page <title> and description for the marketing surface. The app shell
 * owns index.html, so pages set their own meta at mount and restore the
 * defaults on unmount so the dashboard never inherits marketing copy.
 */
export function useDocumentMeta(title: string, description: string) {
  useEffect(() => {
    const previousTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    const previousDescription = meta.getAttribute("content");
    document.title = title;
    meta.setAttribute("content", description);
    return () => {
      document.title = previousTitle;
      if (created) meta?.remove();
      else if (previousDescription !== null) meta?.setAttribute("content", previousDescription);
    };
  }, [title, description]);
}
