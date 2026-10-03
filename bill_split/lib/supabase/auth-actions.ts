"use server";

import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Set it in .env.local (see .env.local.example).`);
  }
  return value;
}

export async function signInWithGoogle(formData: FormData) {
  const next = (formData.get("next") as string | null) ?? "/expenses";
  const siteUrl = requireEnv("NEXT_PUBLIC_SITE_URL");

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${siteUrl}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error || !data.url) {
    redirect(`/login?error=${encodeURIComponent(error?.message ?? "Could not start sign-in.")}`);
  }

  redirect(data.url);
}

export async function signOut() {
  const supabase = await getSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/");
}
