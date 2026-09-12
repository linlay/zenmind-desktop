import { z } from "zod";

export { SYSTEM_WINDOW_MESSAGE, SYSTEM_WINDOW_EVENT } from "./system-window-channels";
const handle = z.string().uuid();
const coordinate = z.number().int().min(-100000).max(100000);
export const systemWindowBoundsSchema = z.strictObject({ x: coordinate, y: coordinate,
  width: z.number().int().min(100).max(16000), height: z.number().int().min(80).max(16000) });
export const systemWindowCreateSchema = z.strictObject({
  entry: z.string().min(1).max(512),
  title: z.string().max(200),
  bounds: systemWindowBoundsSchema,
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
  frame: z.boolean(),
  layer: z.enum(["normal", "desktop"]),
  data: z.unknown().optional()
});
export const systemWindowHandleSchema = z.strictObject({ windowId: handle });
export const systemWindowUpdateSchema = z.strictObject({ windowId: handle,
  title: z.string().max(200).optional(),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional(),
  bounds: systemWindowBoundsSchema.optional()
});
export const systemWindowPostSchema = z.strictObject({ windowId: handle, data: z.unknown() });
export type SystemWindowCreate = z.infer<typeof systemWindowCreateSchema>;
