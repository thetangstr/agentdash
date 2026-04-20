// AgentDash: Smart model routing types

export type SkillVerificationType = "schema" | "effect" | "none";

export interface SkillVerificationSchema {
  type: "schema";
  zodSchema: string;
}

export interface SkillVerificationEffect {
  type: "effect";
  command: string;
}

export interface SkillVerificationNone {
  type: "none";
}

export type SkillVerification =
  | SkillVerificationSchema
  | SkillVerificationEffect
  | SkillVerificationNone;
