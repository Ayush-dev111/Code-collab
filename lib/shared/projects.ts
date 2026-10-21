import { z } from "zod";

export const roleSchema = z.enum(["OWNER", "EDITOR", "VIEWER"]);
export type Role = z.infer<typeof roleSchema>;
const roleLevels: Readonly<Record<Role, number>> = {
  VIEWER: 0,
  EDITOR: 1,
  OWNER: 2,
};

export function hasMinimumRole(role: Role, minimumRole: Role): boolean {
  return roleLevels[role] >= roleLevels[minimumRole];
}
export const roleAtLeast = hasMinimumRole;

export const projectIdSchema = z.cuid();
export const inviteCodeSchema = z.uuid();
export const projectParamsSchema = z.strictObject({
  projectId: projectIdSchema,
});
export const inviteParamsSchema = z.strictObject({ code: inviteCodeSchema });
export const createProjectSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
});
export const updateProjectSchema = createProjectSchema;
export const createInviteSchema = z.strictObject({
  role: z.enum(["EDITOR", "VIEWER"]),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export const projectSummarySchema = z.object({
  id: projectIdSchema,
  name: z.string().min(1).max(80),
  role: roleSchema,
  createdAt: z.iso.datetime(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectDetailsSchema = projectSummarySchema.extend({
  members: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      image: z.string().nullable(),
      role: roleSchema,
    }),
  ),
});
export type ProjectDetails = z.infer<typeof projectDetailsSchema>;
export const projectsResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
});
export const createdProjectResponseSchema = z.object({
  project: projectSummarySchema,
});
export const projectResponseSchema = z.object({
  project: projectDetailsSchema,
});

export const inviteResponseSchema = z.object({
  invite: z.object({
    code: inviteCodeSchema,
    role: createInviteSchema.shape.role,
    expiresAt: z.iso.datetime(),
    url: z.url({ protocol: /^https?$/ }),
  }),
});
export const invitePreviewResponseSchema = z.object({
  invite: z.object({
    projectId: projectIdSchema,
    projectName: z.string(),
    role: createInviteSchema.shape.role,
    expiresAt: z.iso.datetime(),
    isMember: z.boolean(),
  }),
});
export const joinInviteResponseSchema = z.object({
  projectId: projectIdSchema,
  role: roleSchema,
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type Invite = z.infer<typeof inviteResponseSchema>["invite"];
export type InvitePreview = z.infer<
  typeof invitePreviewResponseSchema
>["invite"];
