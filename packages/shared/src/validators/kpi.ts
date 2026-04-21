import { z } from "zod";

// AgentDash: Manual KPIs validators (AGE-45)

// Accept numbers or numeric strings and coerce to a finite number.
const numericInput = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number().finite(),
);

export const createKpiSchema = z.object({
  name: z.string().min(1).max(200),
  unit: z.string().max(50).optional().default(""),
  targetValue: numericInput,
  currentValue: numericInput.optional().nullable(),
  priority: z.number().int().optional().default(0),
});

export type CreateKpi = z.infer<typeof createKpiSchema>;

export const updateKpiSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  unit: z.string().max(50).optional(),
  targetValue: numericInput.optional(),
  currentValue: numericInput.optional().nullable(),
  priority: z.number().int().optional(),
});

export type UpdateKpi = z.infer<typeof updateKpiSchema>;

export const setKpiValueSchema = z.object({
  value: numericInput,
});

export type SetKpiValue = z.infer<typeof setKpiValueSchema>;
