// Types for forbidden-tokens.mjs, so the UI's tests can import it under tsc.
export interface ForbiddenToken {
  length: number;
  sha256: string;
}
export declare const FORBIDDEN_TOKENS: ReadonlyArray<ForbiddenToken>;
export declare function sha256(text: string): string;
export declare function forbiddenTokenOffsets(text: string, tokens?: ReadonlyArray<ForbiddenToken>): number[];
