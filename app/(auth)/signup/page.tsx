import { AuthForm } from "@/components/auth/auth-form";
import { safeReturnPath } from "@/lib/shared";

export const dynamic = "force-dynamic";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const callbackURL = safeReturnPath(
    typeof params.callbackURL === "string" ? params.callbackURL : undefined,
  );
  return <AuthForm mode="signup" callbackURL={callbackURL} />;
}
