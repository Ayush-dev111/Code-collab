import { AuthForm } from "@/components/auth/auth-form";
import { getAuthProviderAvailability } from "@/lib/auth";
import { safeReturnPath } from "@collab/shared";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const callbackURL = safeReturnPath(
    typeof params.callbackURL === "string" ? params.callbackURL : undefined,
  );
  return (
    <AuthForm
      mode="login"
      callbackURL={callbackURL}
      providers={getAuthProviderAvailability()}
    />
  );
}
