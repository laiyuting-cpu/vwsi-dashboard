// 公開設定：Supabase 的網址與公開金鑰（publishable key）本來就會出現在瀏覽器裡，可以放在公開儲存庫。
// 資料的保護靠資料庫的權限規則（supabase/schema.sql），不是靠藏金鑰。
// ⚠️ 絕對不要把 service_role / secret 金鑰放進這個檔案。
window.VW_CONFIG = {
  supabaseUrl: 'https://pratgdxlgwgjchkvnaum.supabase.co',
  supabaseKey: 'sb_publishable_k6a0_fwWO_lqDwu3L3GRuQ_OKORtAfQ',
  avatarBucket: 'avatars'
};
