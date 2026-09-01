/**
 * Copying text, including where the browser refuses to give us a clipboard.
 *
 * `navigator.clipboard` exists only in a secure context: HTTPS, or localhost.
 * An on-prem instance served over plain HTTP at a LAN name — `mkmini.local`,
 * an IP, a Tailscale host — is NOT a secure context, so the whole async
 * Clipboard API is simply `undefined` there. Every copy button on the product
 * silently did nothing for exactly the customers who self-host, which is most
 * of them.
 *
 * The old `document.execCommand("copy")` path still works in that situation.
 * It is deprecated and it is ugly, and it is also the only thing that works,
 * so it stays until on-prem installs get TLS.
 *
 * Returns whether the text actually made it to the clipboard, because the
 * failure that started this was a `catch {}` that swallowed the error and left
 * the button looking like it had worked.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied, or a browser that lies about having the API. Fall
    // through rather than give up: the legacy path often still succeeds.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Off-screen but focusable — `display: none` cannot be selected, and
    // scrolling the page under the user is worse than a hidden element.
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.setAttribute("readonly", "");
    document.body.appendChild(textarea);
    try {
      textarea.select();
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  } catch {
    return false;
  }
}
