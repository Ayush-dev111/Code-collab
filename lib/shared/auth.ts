import { z } from "zod";

const optionalCredential = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

export const authEnvironmentSchema = z
  .object({
    BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }),
    BETTER_AUTH_SECRET: z.string().min(32),
    GOOGLE_CLIENT_ID: optionalCredential,
    GOOGLE_CLIENT_SECRET: optionalCredential,
    GITHUB_CLIENT_ID: optionalCredential,
    GITHUB_CLIENT_SECRET: optionalCredential,
    BETTER_AUTH_API_KEY: optionalCredential,
  })
  .superRefine((environment, context) => {
    for (const provider of ["GOOGLE", "GITHUB"] as const) {
      const id = environment[`${provider}_CLIENT_ID`];
      const secret = environment[`${provider}_CLIENT_SECRET`];
      if (Boolean(id) !== Boolean(secret)) {
        context.addIssue({
          code: "custom",
          path: [`${provider}_CLIENT_ID`],
          message: `Set both ${provider} credentials or leave both empty`,
        });
      }
    }
  });

export const safeReturnPathSchema = z
  .string()
  .max(256)
  .regex(
    /^\/(?:projects(?:\/[a-zA-Z0-9_-]+){0,2}|invite\/[a-fA-F0-9-]{36})$/,
    "Choose a workspace or invite path in this application",
  );

export function safeReturnPath(value: unknown): string {
  const result = safeReturnPathSchema.safeParse(value);
  return result.success ? result.data : "/projects";
}

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
const callbackFields = { callbackURL: safeReturnPathSchema.optional() };

export const authSignUpSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  email: emailSchema,
  password: z.string().min(10).max(128),
  ...callbackFields,
});

export const authSignInSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
  rememberMe: z.boolean().optional(),
  ...callbackFields,
});

export const authSocialSignInSchema = z.strictObject({
  provider: z.enum(["google", "github"]),
  callbackURL: safeReturnPathSchema.optional(),
  errorCallbackURL: safeReturnPathSchema.optional(),
  newUserCallbackURL: safeReturnPathSchema.optional(),
  disableRedirect: z.boolean().optional(),
});

// OAuth callback state and code are subsequently verified by Better Auth.
// Every query key/value is bounded, including provider-specific optional fields.
export const authQuerySchema = z
  .record(
    z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9_-]+$/),
    z.string().max(4096),
  )
  .refine(
    (query) => Object.keys(query).length <= 20,
    "Too many query parameters",
  );

export const emptyInputSchema = z.strictObject({});
export const authProviderAvailabilitySchema = z.object({
  google: z.boolean(),
  github: z.boolean(),
});
export const apiErrorSchema = z.object({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(300),
});

export const signUpSchema = authSignUpSchema;
export const signInSchema = authSignInSchema;
export const socialSignInSchema = authSocialSignInSchema;
export type AuthProviderAvailability = z.infer<
  typeof authProviderAvailabilitySchema
>;
export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
