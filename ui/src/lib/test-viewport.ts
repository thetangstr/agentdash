// AgentDash: mobile lists — a window.matchMedia stand-in for jsdom tests, so a
// component that reads useIsPhone (or any width media query) can be rendered
// at a phone or desktop width. Test-only; nothing in the app imports it.

type Listener = (event: MediaQueryListEvent) => void;

function evaluate(query: string, width: number): boolean {
  const max = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(query);
  const min = /min-width:\s*(\d+(?:\.\d+)?)px/.exec(query);
  if (max && width > Number(max[1])) return false;
  if (min && width < Number(min[1])) return false;
  return Boolean(max || min);
}

/**
 * Makes window.matchMedia answer width queries as if the viewport were
 * `width` pixels wide. Returns a restore function.
 */
export function mockViewportWidth(width: number): () => void {
  const hadMatchMedia = Object.prototype.hasOwnProperty.call(window, "matchMedia");
  const original = window.matchMedia;
  const listeners = new Set<Listener>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: evaluate(query, width),
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList,
  });
  return () => {
    if (hadMatchMedia) {
      Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: original });
    } else {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  };
}

export const PHONE_WIDTH = 390;
export const DESKTOP_WIDTH = 1280;
