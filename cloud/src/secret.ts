// AgentDash: a wrapper that keeps a secret out of every serialisation path.
// `String(secret)`, `JSON.stringify(secret)` and `util.inspect(secret)` all
// print a fixed marker; only `.reveal()` returns the value, and it should be
// called at the one place the value is sent (e.g. an Authorization header).
import { inspect } from "node:util";

export const REDACTED = "[REDACTED]";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
