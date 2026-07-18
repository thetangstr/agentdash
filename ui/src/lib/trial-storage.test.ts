// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TRIAL_STATE_KEY,
  TRIAL_TOKEN_KEY,
  clearTrialStorage,
  readPersistedState,
  readStoredToken,
  writePersistedState,
  writeStoredToken,
} from "./trial-storage";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("trial token storage", () => {
  it("returns null when nothing is stored", () => {
    expect(readStoredToken()).toBeNull();
  });

  it("round-trips a token through localStorage", () => {
    writeStoredToken("tok_abc");
    expect(window.localStorage.getItem(TRIAL_TOKEN_KEY)).toBe("tok_abc");
    expect(readStoredToken()).toBe("tok_abc");
  });

  it("clears the token when written null", () => {
    writeStoredToken("tok_abc");
    writeStoredToken(null);
    expect(window.localStorage.getItem(TRIAL_TOKEN_KEY)).toBeNull();
    expect(readStoredToken()).toBeNull();
  });

  it("migrates a legacy sessionStorage token to localStorage on first read", () => {
    window.sessionStorage.setItem(TRIAL_TOKEN_KEY, "tok_legacy");
    // First read migrates it.
    expect(readStoredToken()).toBe("tok_legacy");
    expect(window.localStorage.getItem(TRIAL_TOKEN_KEY)).toBe("tok_legacy");
    expect(window.sessionStorage.getItem(TRIAL_TOKEN_KEY)).toBeNull();
    // Subsequent reads come straight from localStorage.
    expect(readStoredToken()).toBe("tok_legacy");
  });

  it("prefers the localStorage token over a stale sessionStorage one", () => {
    window.localStorage.setItem(TRIAL_TOKEN_KEY, "tok_new");
    window.sessionStorage.setItem(TRIAL_TOKEN_KEY, "tok_old");
    expect(readStoredToken()).toBe("tok_new");
  });

  it("removes any legacy session copy when writing a token", () => {
    window.sessionStorage.setItem(TRIAL_TOKEN_KEY, "tok_old");
    writeStoredToken("tok_new");
    expect(window.sessionStorage.getItem(TRIAL_TOKEN_KEY)).toBeNull();
    expect(readStoredToken()).toBe("tok_new");
  });
});

describe("trial in-progress state", () => {
  it("returns null when nothing is persisted", () => {
    expect(readPersistedState()).toBeNull();
  });

  it("round-trips intake fields and view", () => {
    writePersistedState({
      view: "intake",
      whatYouDo: "we sell widgets",
      goal: "double revenue",
      blocker: "no sdrs",
    });
    expect(readPersistedState()).toEqual({
      view: "intake",
      whatYouDo: "we sell widgets",
      goal: "double revenue",
      blocker: "no sdrs",
    });
  });

  it("ignores corrupt JSON gracefully", () => {
    window.localStorage.setItem(TRIAL_STATE_KEY, "{not json");
    expect(readPersistedState()).toBeNull();
  });

  it("drops non-string fields", () => {
    window.localStorage.setItem(
      TRIAL_STATE_KEY,
      JSON.stringify({ view: 3, whatYouDo: "x", goal: null }),
    );
    expect(readPersistedState()).toEqual({
      view: undefined,
      whatYouDo: "x",
      goal: undefined,
      blocker: undefined,
    });
  });
});

describe("clearTrialStorage", () => {
  it("removes the token and persisted state from both storages", () => {
    window.localStorage.setItem(TRIAL_TOKEN_KEY, "tok");
    window.localStorage.setItem(TRIAL_STATE_KEY, JSON.stringify({ view: "fleet" }));
    window.sessionStorage.setItem(TRIAL_TOKEN_KEY, "tok");
    clearTrialStorage();
    expect(window.localStorage.getItem(TRIAL_TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(TRIAL_STATE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(TRIAL_TOKEN_KEY)).toBeNull();
    expect(readStoredToken()).toBeNull();
    expect(readPersistedState()).toBeNull();
  });
});
