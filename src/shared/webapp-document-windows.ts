import { z } from "zod";

export const documentIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,80}$/u);
export const documentWindowRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("open"), id: documentIdSchema }),
  z.strictObject({ operation: z.literal("restore"), ids: z.array(documentIdSchema) }),
  z.strictObject({ operation: z.literal("close"), id: documentIdSchema }),
  z.strictObject({ operation: z.literal("minimize"), id: documentIdSchema }),
  z.strictObject({ operation: z.literal("list") }),
  z.strictObject({ operation: z.literal("library") }),
  z.strictObject({
    operation: z.literal("update"), id: documentIdSchema,
    title: z.string().max(120).optional(),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/u).optional(),
    alwaysOnTop: z.boolean().optional()
  })
]);
export type DocumentWindowRequest = z.infer<typeof documentWindowRequestSchema>;
export type DocumentWindowResult = {
  platform: string;
  windows: { id: string; open: boolean; alwaysOnTop: boolean }[];
};
