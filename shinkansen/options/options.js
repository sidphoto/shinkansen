// options.js — 設定頁邏輯
// v1.5.0: 新增 MiniMax API 支援（Engine: gemini / google / minimax）

import { browser } from '../lib/compat.js';
import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, DEFAULT_GLOSSARY_PROMPT, DEFAULT_SUBTITLE_SYSTEM_PROMPT, DEFAULT_MINIMAX_CONFIG } from '../lib/storage.js';
import { TIER_LIMITS } from '../lib/tier-limits.js';
import { formatTokens, formatUSD } from '../lib/format.js';

const DEFAULTS = DEFAULT_SETTINGS;

import { MODEL_PRICING as LIB_MODEL_PRICING } from '../lib/model-pricing.js';
const MODEL_PRICING = Object.fromEntries(
  Object.entries(LIB_MODEL_PRICING).map(([model, p]) => [model, { input: p.inputPerMTok, output: p.outputPerMTok }])
);

// v1.5.0: MiniMax 計價（MiniMax 官方報價）
const MINIMAX_PRICING = {
  inputPerMTok: 0.5,
  outputPerMTok: 3.0,
};

function getSelectedModel() {
  const sel = $('model').value;
  if (sel === '__custom__') {
    return ($('custom-model-input').value || '').trim() || DEFAULTS.geminiConfig.model;
  }
  return sel;
}

function toggleCustomModelInput() {
  const isCustom = $('model').value === '__custom__';
  $('custom-model-row').hidden = !isCustom;
}

const SERVICE_TIER_MULTIPLIER = {
  DEFAULT:  1.0,
  STANDARD: 1.0,
  FLEX:     0.5,
  PRIORITY: 2.0,
};

function applyModelPricing(model, tierOverride) {
  const baseModel = model;
  const p = MODEL_PRICING[baseModel];
  if (!p) return;
  const tier = tierOverride || $('serviceTier').value || 'DEFAULT';
  const mult = SERVICE_TIER_MULTIPLIER[tier] ?? 1.0;
  $('inputPerMTok').value = +(p.input * mult).toFixed(2);
  $('outputPerMTok').value = +(p.output * mult).toFixed(2);
}

function applyTierToInputs(tier, model) {
  const rpmEl = $('rpm');
  const tpmEl = $('tpm');
  const rpdEl = $('rpd');
  if (tier === 'custom') {
    rpmEl.readOnly = false;
    tpmEl.readOnly = false;
    rpdEl.readOnly = false;
    return;
  }
  rpmEl.readOnly = true;
  tpmEl.readOnly = true;
  rpdEl.readOnly = true;
  const table = TIER_LIMITS[tier] || {};
  const limits = table[model] || { rpm: 60, tpm: 1000000, rpd: 1000 };
  rpmEl.value = limits.rpm;
  tpmEl.value = limits.tpm;
  rpdEl.value = limits.rpd === Infinity ? '無限制' : limits.rpd;
}

const $ = (id) => document.getElementById(id);

async function load() {
  const saved = await browser.storage.sync.get(null);
  const { apiKey: localApiKey = '' } = await browser.storage.local.get('apiKey');
  // v1.5.0: MiniMax API Key（單獨存在 storage.local，與 Gemini Key 分開）
  const { minimaxApiKey = '' } = await browser.storage.local.get('minimaxApiKey');

  const s = {
    ...DEFAULTS,
    ...saved,
    geminiConfig: { ...DEFAULTS.geminiConfig, ...(saved.geminiConfig || {}) },
    minimaxConfig: { ...DEFAULT_MINIMAX_CONFIG, ...(saved.minimaxConfig || {}) },
    minimaxPricing: { ...DEFAULTS.minimaxPricing, ...(saved.minimaxPricing || {}) },
    pricing: { ...DEFAULTS.pricing, ...(saved.pricing || {}) },
    apiKey: localApiKey,
  };

  // 一般設定：Gemini API Key
  $('apiKey').value = s.apiKey;
  // v1.5.0: MiniMax API Key
  $('minimaxApiKey').value = minimaxApiKey;

  const modelSelect = $('model');
  const savedModel = s.geminiConfig.model;
  const hasOption = [...modelSelect.options].some((o) => o.value === savedModel);
  if (hasOption) {
    modelSelect.value = savedModel;
  } else {
    modelSelect.value = '__custom__';
    $('custom-model-input').value = savedModel;
  }
  toggleCustomModelInput();
  $('serviceTier').value = s.geminiConfig.serviceTier;
  $('temperature').value = s.geminiConfig.temperature;
  $('topP').value = s.geminiConfig.topP;
  $('topK').value = s.geminiConfig.topK;
  $('maxOutputTokens').value = s.geminiConfig.maxOutputTokens;
  $('systemInstruction').value = s.geminiConfig.systemInstruction;
  $('inputPerMTok').value = s.pricing.inputPerMTok;
  $('outputPerMTok').value = s.pricing.outputPerMTok;
  $('whitelist').value = (s.domainRules.whitelist || []).join('\n');
  $('debugLog').checked = s.debugLog;

  // 效能與配額
  $('tier').value = s.tier || 'tier1';
  applyTierToInputs($('tier').value, s.geminiConfig.model);
  if (s.rpmOverride) $('rpm').value = s.rpmOverride;
  if (s.tpmOverride) $('tpm').value = s.tpmOverride;
  if (s.rpdOverride) $('rpd').value = s.rpdOverride;
  const marginPct = Math.round((s.safetyMargin || 0.1) * 100);
  $('safetyMargin').value = marginPct;
  $('safetyMarginLabel').textContent = marginPct;
  $('maxConcurrentBatches').value = s.maxConcurrentBatches || 10;
  $('maxUnitsPerBatch').value = s.maxUnitsPerBatch ?? 12;
  $('maxCharsPerBatch').value = s.maxCharsPerBatch ?? 3500;
  $('maxTranslateUnits').value = s.maxTranslateUnits ?? 1000;
  $('maxRetries').value = s.maxRetries || 3;

  // v0.69: 術語表一致化設定
  const gl = { ...DEFAULTS.glossary, ...(s.glossary || {}) };
  $('glossaryEnabled').checked = gl.enabled !== false;
  $('glossaryTemperature').value = gl.temperature;
  $('glossaryTimeout').value = gl.timeoutMs;
  $('glossaryPrompt').value = gl.prompt;

  // v1.0.17/31: Toast
  const opacityPct = Math.round((s.toastOpacity ?? 0.7) * 100);
  $('toastOpacity').value = opacityPct;
  $('toastOpacityLabel').textContent = opacityPct;
  $('toastPosition').value = s.toastPosition || 'bottom-right';
  $('toastAutoHide').checked = s.toastAutoHide !== false;

  // v1.0.21: 頁面層級繁中偵測
  $('skipTraditionalChinesePage').checked = s.skipTraditionalChinesePage !== false;

  // v1.0.29: 固定術語表
  fixedGlossary = {
    global: Array.isArray(s.fixedGlossary?.global) ? s.fixedGlossary.global : [],
    byDomain: (s.fixedGlossary?.byDomain && typeof s.fixedGlossary.byDomain === 'object') ? s.fixedGlossary.byDomain : {},
  };
  currentDomain = '';
  renderGlobalTable();
  updateDomainSelect();
  showDomainPanel('');

  // v1.2.11: YouTube 字幕設定
  const yt = { ...DEFAULTS.ytSubtitle, ...(s.ytSubtitle || {}) };
  const ytEngineEl = $('ytEngine');
  if (ytEngineEl) ytEngineEl.value = yt.engine || 'gemini';
  $('ytAutoTranslate').checked       = yt.autoTranslate       === true;
  $('ytDebugToast').checked          = yt.debugToast          === true;
  $('ytOnTheFly').checked            = yt.onTheFly            === true;
  $('ytWindowSizeS').value           = yt.windowSizeS ?? 30;
  $('ytLookaheadS').value           = yt.lookaheadS  ?? 10;
  $('ytTemperature').value           = yt.temperature  ?? 1;
  $('ytSystemPrompt').value           = yt.systemPrompt || DEFAULT_SUBTITLE_SYSTEM_PROMPT;
  const ytModelSel = $('ytModel');
  const savedYtModel = yt.model || '';
  if ([...ytModelSel.options].some(o => o.value === savedYtModel)) {
    ytModelSel.value = savedYtModel;
  } else {
    ytModelSel.value = '';
  }
  const ytPricing = yt.pricing;
  $('ytInputPerMTok').value  = ytPricing?.inputPerMTok  != null ? ytPricing.inputPerMTok  : '';
  $('ytOutputPerMTok').value = ytPricing?.outputPerMTok != null ? ytPricing.outputPerMTok : '';

  // v1.4.13 / v1.5.0: 三組 preset（現在支援 minimax engine）
  const presets = Array.isArray(s.translatePresets) && s.translatePresets.length > 0
    ? s.translatePresets
    : DEFAULTS.translatePresets;
  for (const slot of [1, 2, 3]) {
    const p = presets.find(x => x.slot === slot) || DEFAULTS.translatePresets.find(x => x.slot === slot);
    $(`preset-label-${slot}`).value = p.label || '';
    // v1.5.0: engine='minimax' 也要能正確讀取並顯示
    const engineVal = (p.engine === 'minimax') ? 'minimax' : (p.engine === 'google' ? 'google' : 'gemini');
    $(`preset-engine-${slot}`).value = engineVal;
    // model 只在 engine != 'google' 時有意義
    const modelSel = $(`preset-model-${slot}`);
    const defaultModel = (p.engine === 'minimax') ? 'MiniMax-M2.7' : 'gemini-3-flash-preview';
    const modelToSelect = p.model || defaultModel;
    if ([...modelSel.options].some(o => o.value === modelToSelect)) {
      modelSel.value = modelToSelect;
    } else {
      modelSel.value = defaultModel;
    }
    updatePresetModelVisibility(slot);
  }
  refreshPresetKeyBindings();
}

// v1.4.13 / v1.5.0: engine='google' 或 'minimax' 時隱藏 model 欄（minimax 也沒有可選模型，就是 MiniMax-M2.7）
function updatePresetModelVisibility(slot) {
  const engine = $(`preset-engine-${slot}`).value;
  const row = $(`preset-model-row-${slot}`);
  if (row) row.hidden = engine === 'google' || engine === 'minimax';
  // v1.5.0: 若 engine='minimax' 也需隱藏 model row（型號固定 MiniMax-M2.7）
  // label 也跟著改
  const modelLabel = $(`preset-model-label-${slot}`);
  if (modelLabel) {
    modelLabel.textContent = engine === 'minimax' ? '模型（M2.7 固定）' : '模型';
  }
}

async function refreshPresetKeyBindings() {
  try {
    const cmds = await browser.commands.getAll();
    for (const slot of [1, 2, 3]) {
      const cmd = cmds.find(c => c.name === `translate-preset-${slot}`);
      const keyEl = $(`preset-key-${slot}`);
      if (!keyEl) continue;
      if (cmd?.shortcut) {
        keyEl.textContent = cmd.shortcut;
        keyEl.removeAttribute('data-unset');
      } else {
        keyEl.textContent = '未設定';
        keyEl.setAttribute('data-unset', '1');
      }
    }
  } catch { /* Safari / 舊瀏覽器不支援 commands API */ }
}

// v1.5.0: 引擎變更時更新 model row 可見性
function setupEngineChangeListeners() {
  for (const slot of [1, 2, 3]) {
    const sel = $(`preset-engine-${slot}`);
    if (sel) {
      sel.addEventListener('change', () => updatePresetModelVisibility(slot));
    }
  }
}
document.addEventListener('DOMContentLoaded', setupEngineChangeListeners);

async function save() {
  const apiKeyValue = $('apiKey').value.trim();
  await browser.storage.local.set({ apiKey: apiKeyValue });
  // v1.5.0: MiniMax API Key 單獨儲存
  const minimaxApiKeyValue = $('minimaxApiKey').value.trim();
  await browser.storage.local.set({ minimaxApiKey: minimaxApiKeyValue });

  // v1.5.0: 讀取 engine='minimax' 時忽略 preset-model 的值（固定 MiniMax-M2.7）
  const translatePresets = [1, 2, 3].map(slot => {
    const engine = $(`preset-engine-${slot}`).value;
    const model = engine === 'google' ? null : (
      engine === 'minimax' ? 'MiniMax-M2.7' : ($(`preset-model-${slot}`).value || null)
    );
    const label = ($(`preset-label-${slot}`).value || '').trim() || `預設 ${slot}`;
    return { slot, engine, model, label };
  });

  const settings = {
    geminiConfig: {
      model: getSelectedModel(),
      serviceTier: $('serviceTier').value,
      temperature: Number($('temperature').value),
      topP: Number($('topP').value),
      topK: Number($('topK').value),
      maxOutputTokens: Number($('maxOutputTokens').value),
      systemInstruction: $('systemInstruction').value,
    },
    minimaxConfig: {
      model: 'MiniMax-M2.7',
      temperature: 1.0,
      topP: 0.95,
      maxOutputTokens: 8192,
      systemInstruction: DEFAULT_SYSTEM_PROMPT,
    },
    minimaxPricing: {
      inputPerMTok: MINIMAX_PRICING.inputPerMTok,
      outputPerMTok: MINIMAX_PRICING.outputPerMTok,
    },
    pricing: {
      inputPerMTok: Number($('inputPerMTok').value) || 0,
      outputPerMTok: Number($('outputPerMTok').value) || 0,
    },
    domainRules: {
      whitelist: $('whitelist').value.split('\n').map(s => s.trim()).filter(Boolean),
    },
    debugLog: $('debugLog').checked,
    tier: $('tier').value,
    safetyMargin: Number($('safetyMargin').value) / 100,
    maxRetries: Number($('maxRetries').value) || 3,
    maxConcurrentBatches: Number($('maxConcurrentBatches').value) || 10,
    maxUnitsPerBatch: Number($('maxUnitsPerBatch').value) || 12,
    maxCharsPerBatch: Number($('maxCharsPerBatch').value) || 3500,
    maxTranslateUnits: Number($('maxTranslateUnits').value) ?? 1000,
    rpmOverride: $('tier').value === 'custom' ? (Number($('rpm').value) || null) : null,
    tpmOverride: $('tier').value === 'custom' ? (Number($('tpm').value) || null) : null,
    rpdOverride: $('tier').value === 'custom' ? (Number($('rpd').value) || null) : null,
    glossary: {
      enabled: $('glossaryEnabled').checked,
      prompt: $('glossaryPrompt').value,
      temperature: Number($('glossaryTemperature').value) || 0.1,
      skipThreshold: DEFAULTS.glossary.skipThreshold,
      blockingThreshold: DEFAULTS.glossary.blockingThreshold,
      timeoutMs: Number($('glossaryTimeout').value) || 60000,
      maxTerms: DEFAULTS.glossary.maxTerms,
    },
    toastOpacity: Number($('toastOpacity').value) / 100,
    toastPosition: $('toastPosition').value,
    toastAutoHide: $('toastAutoHide').checked,
    skipTraditionalChinesePage: $('skipTraditionalChinesePage').checked,
    ytSubtitle: {
      engine: ($('ytEngine')?.value || 'gemini'),
      autoTranslate:      $('ytAutoTranslate').checked,
      debugToast:         $('ytDebugToast').checked,
      onTheFly:            $('ytOnTheFly').checked,
      windowSizeS:  Number($('ytWindowSizeS').value)  || 30,
      lookaheadS:   Number($('ytLookaheadS').value)   || 10,
      temperature:  Number($('ytTemperature').value)  ?? 1,
      systemPrompt: $('ytSystemPrompt').value || DEFAULT_SUBTITLE_SYSTEM_PROMPT,
      model: $('ytModel').value || '',
      pricing: (() => {
        const inp = parseFloat($('ytInputPerMTok').value);
        const out = parseFloat($('ytOutputPerMTok').value);
        if (isNaN(inp) && isNaN(out)) return null;
        return {
          inputPerMTok:  isNaN(inp) ? null : inp,
          outputPerMTok: isNaN(out) ? null : out,
        };
      })(),
    },
    translatePresets,
    fixedGlossary: (() => {
      fixedGlossary.global = readGlossaryTableEntries($('fixed-global-tbody'));
      if (currentDomain && fixedGlossary.byDomain[currentDomain]) {
        fixedGlossary.byDomain[currentDomain] = readGlossaryTableEntries($('fixed-domain-tbody'));
      }
      const cleanGlobal = fixedGlossary.global.filter(e => e.source || e.target);
      const cleanByDomain = {};
      for (const [domain, entries] of Object.entries(fixedGlossary.byDomain)) {
        const clean = entries.filter(e => e.source || e.target);
        if (clean.length > 0) cleanByDomain[domain] = clean;
      }
      return { global: cleanGlobal, byDomain: cleanByDomain };
    })(),
  };
  await browser.storage.sync.set(settings);
  $('save-status').textContent = '✓ 已儲存';
  setTimeout(() => { $('save-status').textContent = ''; }, 2000);
  showSaveBar('saved', '設定已儲存');
}

$('save').addEventListener('click', save);
$('save-gemini').addEventListener('click', save);
$('save-glossary').addEventListener('click', save);
$('save-youtube').addEventListener('click', save);
$('save-debug').addEventListener('click', save);
$('yt-reset-prompt').addEventListener('click', () => {
  $('ytSystemPrompt').value = DEFAULT_SUBTITLE_SYSTEM_PROMPT;
  markDirty();
});
$('reset-defaults').addEventListener('click', async () => {
  if (!confirm('確定要還原所有設定？（API Key 會保留）')) return;
  await browser.storage.sync.clear();
  await browser.storage.local.set({ apiKey: (await browser.storage.local.get('apiKey')).apiKey });
  location.reload();
});
$('export-settings').addEventListener('click', () => {
  browser.storage.sync.get(null).then(data => {
    delete data.apiKey;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'shinkansen-settings.json'; a.click();
  });
});
$('import-file').addEventListener('click', () => $('import-input').click());
$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    await browser.storage.sync.set(data);
    location.reload();
  } catch { alert('檔案格式錯誤'); }
});
$('model').addEventListener('change', () => {
  toggleCustomModelInput();
  const model = getSelectedModel();
  applyModelPricing(model);
});
$('serviceTier').addEventListener('change', () => {
  const model = getSelectedModel();
  applyModelPricing(model, $('serviceTier').value);
});
$('tier').addEventListener('change', () => {
  const tier = $('tier').value;
  const model = getSelectedModel();
  applyTierToInputs(tier, model);
});
$('safetyMargin').addEventListener('input', () => {
  $('safetyMarginLabel').textContent = $('safetyMargin').value;
});
$('toastOpacity').addEventListener('input', () => {
  $('toastOpacityLabel').textContent = $('toastOpacity').value;
});
$('toggle-api-key').addEventListener('click', () => {
  const input = $('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
});
// v1.5.0: MiniMax API Key 顯示切換
$('toggle-minimax-key').addEventListener('click', () => {
  const input = $('minimaxApiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
});
// Tab 切換（舊有邏輯）
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add('active');
  });
});
// 固定術語表 UI（舊有邏輯）
let fixedGlossary = { global: [], byDomain: {} };
let currentDomain = '';
function readGlossaryTableEntries(tbody) {
  if (!tbody) return [];
  return [...tbody.querySelectorAll('tr')].map(row => {
    const tds = row.querySelectorAll('td');
    return { source: tds[0]?.querySelector('input')?.value?.trim() || '', target: tds[1]?.querySelector('input')?.value?.trim() || '' };
  });
}
function renderGlobalTable() {
  const tbody = $('fixed-global-tbody');
  if (!tbody) return;
  tbody.innerHTML = fixedGlossary.global.map((e, i) => `<tr>
    <td><input value="${e.source}" placeholder="原文" /></td>
    <td><input value="${e.target}" placeholder="譯文" /></td>
    <td><button class="secondary" onclick="this.closest('tr').remove()">刪</button></td></tr>`).join('');
}
function updateDomainSelect() {
  const sel = $('fixed-domain-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">選擇網域…</option>' + Object.keys(fixedGlossary.byDomain).map(d => `<option value="${d}">${d}</option>`).join('');
}
function showDomainPanel(domain) {
  const panel = $('fixed-domain-panel');
  if (!panel) return;
  if (!domain) { panel.hidden = true; return; }
  panel.hidden = false;
  $('fixed-domain-label').textContent = domain;
  const tbody = $('fixed-domain-tbody');
  if (!tbody) return;
  const entries = fixedGlossary.byDomain[domain] || [];
  tbody.innerHTML = entries.map((e, i) => `<tr>
    <td><input value="${e.source}" placeholder="原文" /></td>
    <td><input value="${e.target}" placeholder="譯文" /></td>
    <td><button class="secondary" onclick="this.closest('tr').remove()">刪</button></td></tr>`).join('');
}
$('fixed-global-add')?.addEventListener('click', () => {
  const tbody = $('fixed-global-tbody');
  tbody.insertRow().innerHTML = '<td><input placeholder="原文" /></td><td><input placeholder="譯文" /></td><td><button class="secondary" onclick="this.closest(\'tr\').remove()">刪</button></td>';
});
$('fixed-domain-add-btn')?.addEventListener('click', () => {
  const input = $('fixed-domain-input');
  const select = $('fixed-domain-select');
  const domain = input.value.trim() || select.value;
  if (!domain) return;
  if (!fixedGlossary.byDomain[domain]) fixedGlossary.byDomain[domain] = [];
  input.value = '';
  updateDomainSelect();
  select.value = domain;
  showDomainPanel(domain);
});
$('fixed-domain-select')?.addEventListener('change', () => showDomainPanel($('fixed-domain-select').value));
$('fixed-domain-add-row')?.addEventListener('click', () => {
  const tbody = $('fixed-domain-tbody');
  tbody.insertRow().innerHTML = '<td><input placeholder="原文" /></td><td><input placeholder="譯文" /></td><td><button class="secondary" onclick="this.closest(\'tr\').remove()">刪</button></td>';
});
$('fixed-domain-delete')?.addEventListener('click', () => {
  if (!currentDomain) return;
  delete fixedGlossary.byDomain[currentDomain];
  currentDomain = '';
  updateDomainSelect();
  $('fixed-domain-input').value = '';
  showDomainPanel('');
});
// 當 ytEngine 改變時，隱藏/顯示 model（v1.5.0: minimax engine）
$('ytEngine')?.addEventListener('change', () => {
  const ytModelRow = $('ytModelRow');
  if (ytModelRow) {
    ytModelRow.hidden = $('ytEngine').value === 'google';
  }
});

// v0.94: 儲存提示條
function showSaveBar(type, msg) {
  const bar = $('save-bar');
  if (!bar) return;
  bar.textContent = msg;
  bar.className = `save-bar save-bar-${type}`;
  bar.hidden = false;
  if (type === 'saved') setTimeout(() => { bar.hidden = true; }, 3000);
}
function markDirty() { /* 預留：停用離開頁面警告 */ }

load();