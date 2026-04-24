// tier-limits.js — API 各層級 rate limit 對照表
//
// Gemini API 資料來源：ai.google.dev/gemini-api/docs/rate-limits 與 2026 年 Q1 業界整理
// MiniMax API 資料來源：platform.minimax.io/docs 與 2026-04 官方定價頁
// 快照時間：2026-04（v1.5.0 當下）
//
// Rate limit 三維度：
//   rpm  = Requests Per Minute
//   tpm  = Tokens Per Minute(input tokens)
//   rpd  = Requests Per Day(Pacific Time 午夜重置,persist 到 browser.storage.local)
//
// 任何一個維度超過都會觸發 HTTP 429。
//
// Gemini 免費層所有模型共用 250K TPM 池。
// Gemini 付費層 per-model 各自獨立 TPM 池。
// MiniMax 限制需參考官方儀表板，v1.5.0 使用保守預設值。
//
// 此對照表為靜態快照，規格變動時需 bump extension 版本並更新此表。

// v1.5.0: 全面更新，新增 MiniMax M2.7 各層級限制。
// MiniMax 官方尚未提供完整公開的 RPM/TPM/RPD 數據，
// 以下使用保守估計值，實際限制請至 MiniMax 儀表板確認。
export const TIER_LIMITS = {
  free: {
    'gemini-3-flash-preview':        { rpm: 10,   tpm: 250_000,   rpd: 250 },
    'gemini-3.1-flash-lite-preview': { rpm: 15,   tpm: 250_000,   rpd: 1_000 },
    'gemini-3.1-pro-preview':        { rpm: 5,    tpm: 250_000,   rpd: 100 },
    // MiniMax free tier（假設值，实际以官方為準）
    'MiniMax-M2.7':                  { rpm: 15,   tpm: 300_000,   rpd: 1_000 },
  },
  tier1: {
    'gemini-3-flash-preview':        { rpm: 1000, tpm: 2_000_000, rpd: 10_000 },
    'gemini-3.1-flash-lite-preview': { rpm: 4000, tpm: 4_000_000, rpd: 150_000 },
    'gemini-3.1-pro-preview':        { rpm: 225,  tpm: 2_000_000, rpd: 250 },
    // MiniMax tier1（假設值，实际以官方為準）
    'MiniMax-M2.7':                  { rpm: 500,   tpm: 1_500_000,  rpd: 50_000 },
  },
  tier2: {
    'gemini-3-flash-preview':        { rpm: 2000,  tpm: 3_000_000,  rpd: 100_000 },
    'gemini-3.1-flash-lite-preview': { rpm: 10000, tpm: 10_000_000, rpd: 350_000 },
    'gemini-3.1-pro-preview':        { rpm: 1000,  tpm: 5_000_000,  rpd: 50_000 },
    // MiniMax tier2（假設值，实际以官方為準）
    'MiniMax-M2.7':                  { rpm: 1000,  tpm: 3_000_000,  rpd: 200_000 },
  },
};

// 當對照表查不到（例如新模型尚未收錄）時的 fallback,採保守數值。
const FALLBACK_LIMITS = { rpm: 60, tpm: 1_000_000, rpd: 1000 };

/**
 * 依據設定取得有效的 rate limit 數值。
 * 使用者 override 優先於 tier 對照表。
 * @param {object} settings 完整 settings 物件
 * @returns {{ rpm: number, tpm: number, rpd: number, safetyMargin: number }}
 */
export function getLimitsForSettings(settings) {
  const tier = settings?.tier || 'tier1';
  // 優先檢查 minimaxConfig.model（MiniMax 引擎），其次檢查 geminiConfig.model
  const model = settings?.minimaxConfig?.model || settings?.geminiConfig?.model || 'gemini-3-flash-preview';
  const tierTable = TIER_LIMITS[tier];
  const base = (tierTable && tierTable[model]) || FALLBACK_LIMITS;

  return {
    rpm: Number(settings?.rpmOverride) || base.rpm,
    tpm: Number(settings?.tpmOverride) || base.tpm,
    rpd: Number(settings?.rpdOverride) || base.rpd,
    safetyMargin: typeof settings?.safetyMargin === 'number' ? settings.safetyMargin : 0.1,
  };
}