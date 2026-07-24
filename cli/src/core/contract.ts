import { z } from "zod";

export const ENTRY_TYPES = [
  "decision",
  "shipped",
  "note",
  "discovery",
  "content",
  "training",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

const Base = z.object({
  title: z.string().min(1),
  body: z.string().default(""),
  project: z.string().min(1).optional(),
  ticket: z
    .string()
    .regex(/^[A-Z0-9]+-\d+$/)
    .optional(), // brain board card id e.g. PROJ-123
  labels: z.array(z.string().min(1)).optional(),
});

export const RegisterInput = z.discriminatedUnion("type", [
  Base.extend({ type: z.literal("decision"), project: z.string().min(1) }),
  Base.extend({
    type: z.literal("shipped"),
    project: z.string().min(1),
    ticket: z.string().regex(/^[A-Z0-9]+-\d+$/),
  }),
  Base.extend({
    type: z.literal("note"),
    labels: z.array(z.string().min(1)).min(1),
  }),
  Base.extend({
    type: z.literal("discovery"),
    labels: z.array(z.string().min(1)).min(1),
  }),
  Base.extend({
    type: z.literal("content"),
    labels: z.array(z.string().min(1)).min(1),
  }),
  Base.extend({
    type: z.literal("training"),
    labels: z.array(z.string().min(1)).min(1),
  }),
]);
export type RegisterInput = z.infer<typeof RegisterInput>;
