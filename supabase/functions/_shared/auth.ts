import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
// 用呼叫者自己的登入憑證建立 client，並確認是名單上的夥伴
export async function memberClient(req: Request): Promise<{ sb: SupabaseClient; mid: string } | null> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+\.\S+\.\S+$/.test(auth)) return null;
  const key = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, key, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: mid, error } = await sb.rpc('my_member_id');
  if (error || !mid) return null;
  return { sb, mid: String(mid) };
}
