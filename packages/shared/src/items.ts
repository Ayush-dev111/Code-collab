import { z } from "zod";
import { projectIdSchema } from "./projects.js";
import { codeLanguageSchema } from "./code.js";

export const itemIdSchema = z.cuid();
export const itemTypeSchema = z.enum(["PAGE", "CODE", "FOLDER"]);
export const itemTitleSchema = z.string().trim().min(1).max(120);
export const itemParamsSchema = z.strictObject({
  projectId: projectIdSchema,
  itemId: itemIdSchema,
});
export const itemPageParamsSchema = itemParamsSchema;
export const createItemSchema = z
  .strictObject({
    type: itemTypeSchema,
    title: itemTitleSchema,
    parentId: itemIdSchema.nullable().default(null),
    language: codeLanguageSchema.optional(),
  })
  .refine((input) => input.type === "CODE" || input.language === undefined, {
    message: "Only code files have a language.",
    path: ["language"],
  });
export const updateItemSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("language"),
    language: codeLanguageSchema,
  }),
  z.strictObject({ action: z.literal("rename"), title: itemTitleSchema }),
  z.strictObject({
    action: z.literal("move"),
    parentId: itemIdSchema.nullable(),
    index: z.number().int().min(0).max(10000),
  }),
]);
export const treeItemSchema = z.object({
  id: itemIdSchema,
  projectId: projectIdSchema,
  parentId: itemIdSchema.nullable(),
  type: itemTypeSchema,
  title: itemTitleSchema,
  language: codeLanguageSchema.nullable(),
  order: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const itemsResponseSchema = z.object({ items: z.array(treeItemSchema) });
export const itemResponseSchema = z.object({
  item: treeItemSchema,
  notificationPending: z.boolean().optional(),
});
export const deleteItemsResponseSchema = z.object({
  deletedIds: z.array(itemIdSchema),
  notificationPending: z.boolean().optional(),
});
export const treeChangedSchema = z.strictObject({
  projectId: projectIdSchema,
  changedAt: z.iso.datetime(),
});
export const imageKeySchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/,
  );
export const imageParamsSchema = itemParamsSchema.extend({
  imageKey: imageKeySchema,
});
export const imageUploadResponseSchema = z.object({
  url: z
    .string()
    .regex(
      /^\/api\/projects\/[a-z0-9]+\/items\/[a-z0-9]+\/images\/[0-9a-f-]+\.(?:png|jpg|gif|webp)$/,
    ),
});
export const imageUploadInputSchema = z.strictObject({
  name: z.string().min(1).max(255),
  type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  size: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
});
export const imageUploadFormSchema = z.strictObject({
  file: z
    .file()
    .min(1)
    .max(8 * 1024 * 1024)
    .mime(["image/png", "image/jpeg", "image/gif", "image/webp"]),
});
export const imageStorageHeadersSchema = z.strictObject({
  contentLength: z.coerce
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
});
export const imageUploadHeadersSchema = z.strictObject({
  contentType: z
    .string()
    .max(200)
    .regex(
      /^multipart\/form-data\s*;\s*boundary=(?:"[a-zA-Z0-9'()+_,.\/:=?-]{1,70}"|[a-zA-Z0-9'()+_,.\/:=?-]{1,70})$/i,
    ),
  contentLength: z.coerce
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024 + 65536)
    .optional(),
});
export type TreeItem = z.infer<typeof treeItemSchema>;
export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
