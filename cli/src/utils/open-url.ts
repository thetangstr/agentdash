// Cross-platform "open this URL in the user's default browser".
// We avoid the `open` npm package to keep CLI deps minimal — the platform-
// native commands cover macOS/Linux/Windows + WSL.
import { spawn } from "node:child_process";

const PLATFORM_COMMAND: { command: string; args: (url: string) => string[] } = (() => {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: (url) => [url] };
    case "win32":
      // `start ""` requires an empty title arg before the URL.
      return { command: "cmd", args: (url) => ["/c", "start", "", url] };
    default:
      // Linux / WSL / FreeBSD — xdg-open routes through the desktop registry.
      return { command: "xdg-open", args: (url) => [url] };
  }
})();

/**
 * Best-effort open a URL in the user's default browser.
 * Returns true if the spawn was issued cleanly, false if it failed
 * (no DE on a headless server, missing xdg-utils, etc.).
 */
export function openUrlInBrowser(url: string): boolean {
  try {
    const child = spawn(PLATFORM_COMMAND.command, PLATFORM_COMMAND.args(url), {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // Swallow. Caller already prints the URL — the user can copy/paste.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
