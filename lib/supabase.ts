import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Cliente para uso en el navegador (respeta RLS con el usuario logueado)
export function getBrowserClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// Cliente para uso en el servidor (API routes) con permisos de service role.
// NUNCA exponer esta key al navegador. Solo se usa en app/api/**.
export function getServiceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
