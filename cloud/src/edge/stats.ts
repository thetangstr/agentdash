// AgentDash (SC-10, GH #771): the edge router's request counts for the 5xx
// alert (spec §6.3 "router 5xx above 1 percent"). Each replica counts the
// responses it serves on box hosts and flushes the counts every minute
// through edge_record_stats() (the router's role has no table privilege).
// A 5xx counts when the visitor got one: the box's own 5xx passed through,
// a 502 when the box did not answer, a 500 edge error, or the 503 served
// while the route table is stale. The deliberate 503 pages (waking a
// suspended box, a box still being set up) are not errors.
export class EdgeStats {
  #requests = 0;
  #serverErrors = 0;

  record(serverError: boolean): void {
    this.#requests += 1;
    if (serverError) this.#serverErrors += 1;
  }

  get pending(): { requests: number; serverErrors: number } {
    return { requests: this.#requests, serverErrors: this.#serverErrors };
  }

  /** Hands the counts to `write` and resets them; on failure they are kept for the next flush. */
  async flush(write: (requests: number, serverErrors: number) => Promise<void>): Promise<boolean> {
    if (this.#requests === 0) return false;
    const requests = this.#requests;
    const serverErrors = this.#serverErrors;
    this.#requests = 0;
    this.#serverErrors = 0;
    try {
      await write(requests, serverErrors);
      return true;
    } catch (err) {
      this.#requests += requests;
      this.#serverErrors += serverErrors;
      throw err;
    }
  }
}
