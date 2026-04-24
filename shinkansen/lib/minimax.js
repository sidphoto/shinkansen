// minimax.js — MiniMax API 封裝
// 支援批次翻譯、除錯 Log。
// 基於 gemini.js v0.69 結構修改，适配 MiniMax API

import { debugLog } from './logger.js';
import { DEFAULT_UNITS_PER_BATCH, DEFAULT_CHARS_PER_BATCH } from './constants.js';

const DELIMITER = '\n<<<SHINKANSEN_SEP>>>\n';
const MAX_UNITS_PER_CHUNK = DEFAULT_UNITS_PER_BATCH;
const MAX_CHARS_PER_CHUNK = DEFAULT_CHARS_PER_BATCH;
const MAX_BACKOFF_MS = 8000;

/**
 * Greedy 打包：對 texts 陣列用字元預算 + 段數上限雙門檻切成連續子批次，
 * 回傳「起始 index 陣列」讓呼叫端可以對齊結果。
 */
function packChunks(texts) {
  const batches = [];
  let cur = null;
  const flush = () => { if (cur && cur.end > cur.start) batches.push(cur); cur = null; };
  for (let i = 0; i < texts.length; i++) {
    const len = (texts[i] || '').length;
    if (len > MAX_CHARS_PER_CHUNK) {
      flush();
      batches.push({ start: i, end: i + 1 });
      continue;
    }
    if (cur && (cur.chars + len > MAX_CHARS_PER_CHUNK || (cur.end - cur.start) >= MAX_UNITS_PER_CHUNK)) {
      flush();
    }
    if (!cur) cur = { start: i, end: i, chars: 0 };
    cur.end = i + 1;
    cur.chars += len;
  }
  flush();
  return batches;
}

/** 自訂錯誤:RPD 每日配額用盡,不應該被重試。 */
export class DailyQuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DailyQuotaExceededError';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * fetch MiniMax API,帶 429 退避重試。
 */
async function fetchWithRetry(url, body, { maxRetries = 3 } = {}) {
  let attempt = 0;
  while (true) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${body.apiKey}`,
        },
        body: JSON.stringify(body.data),
      });
    } catch (err) {
      await debugLog('error', 'api', 'minimax fetch network error', { error: err.message, attempt });
      if (attempt >= maxRetries) throw new Error('網路錯誤：' + err.message);
      await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
      attempt += 1;
      continue;
    }

    if (resp.status >= 500 && resp.status < 600) {
      await debugLog('warn', 'api', `minimax ${resp.status} server error`, { status: resp.status, attempt });
      if (attempt >= maxRetries) {
        let errMsg = `HTTP ${resp.status}`;
        try { const j = await resp.json(); errMsg = j?.error?.message || errMsg; } catch { /* noop */ }
        throw new Error(errMsg);
      }
      await sleep(Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt)));
      attempt += 1;
      continue;
    }

    if (resp.status !== 429) return resp;

    // 429 處理
    let bodyJson = null;
    try { bodyJson = await resp.clone().json(); } catch { /* noop */ }
    
    await debugLog('warn', 'api', 'minimax 429 rate limit', {
      attempt,
      error: bodyJson?.error?.message || bodyJson?.base_resp?.status_msg,
    });

    if (attempt >= maxRetries) {
      const msg = bodyJson?.error?.message || bodyJson?.base_resp?.status_msg || `HTTP 429`;
      throw new Error(msg);
    }

    const retryAfterHeader = resp.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000 + 100
      : Math.min(MAX_BACKOFF_MS, 500 * Math.pow(2, attempt));
    await sleep(waitMs);
    attempt += 1;
  }
}

/**
 * 術語表擷取 — 使用 MiniMax API。
 */
export async function extractGlossary(compressedText, settings) {
  const { apiKey, minimaxConfig, glossary: glossaryConfig } = settings;
  const {
    model,
    temperature,
    maxOutputTokens,
  } = minimaxConfig;

  const glossaryPrompt = glossaryConfig?.prompt || '';
  const glossaryTemperature = glossaryConfig?.temperature ?? 0.1;
  const maxTerms = glossaryConfig?.maxTerms ?? 200;
  const fetchTimeoutMs = glossaryConfig?.fetchTimeoutMs ?? 55_000;
  const glossaryMaxOutput = Math.max(maxOutputTokens || 0, 4096);

  const body = {
    model,
    messages: [
      { role: 'system', content: glossaryPrompt },
      { role: 'user', content: `請從以下文章摘要中提取專有名詞對照表（最多${maxTerms}組），回傳 JSON 格式：{"glossary":[{"source":"英文","target":"中文","type":"name|term|org"}]}
文章摘要：
${compressedText}` }
    ],
    temperature: glossaryTemperature,
    max_tokens: glossaryMaxOutput,
  };

  const url = 'https://api.minimax.chat/v1/chat/completions';

  await debugLog('info', 'glossary', 'minimax glossary extraction request', { model, chars: compressedText.length, fetchTimeoutMs });

  const t0 = Date.now();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), fetchTimeoutMs);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(abortTimer);
    const reason = err.name === 'AbortError' ? `fetch timeout (${fetchTimeoutMs}ms)` : 'network error';
    await debugLog('error', 'glossary', `glossary extraction failed (${reason})`, { error: err.message, elapsed: Date.now() - t0 });
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: `${reason}: ${err.message}` };
  }
  clearTimeout(abortTimer);

  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    await debugLog('error', 'glossary', 'glossary response body parse failed', { status: resp.status, error: parseErr.message });
    return { glossary: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, _diag: `resp.json() failed: ${parseErr.message}` };
  }
  const ms = Date.now() - t0;

  const usage = {
    inputTokens: json?.usage?.prompt_tokens || 0,
    outputTokens: json?.usage?.completion_tokens || 0,
    cachedTokens: 0,
  };

  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    await debugLog('error', 'glossary', 'glossary extraction failed (API)', { status: resp.status, error: errMsg, elapsed: ms });
    return { glossary: [], usage, _diag: `API error ${resp.status}: ${errMsg}` };
  }

  const rawText = json?.choices?.[0]?.message?.content || '';
  const finishReason = json?.choices?.[0]?.finish_reason || 'unknown';
  await debugLog('info', 'glossary', 'glossary extraction response', {
    elapsed: ms, usage, rawChars: rawText.length, finishReason,
  });

  // 解析 JSON
  let jsonStr = rawText.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else {
    const firstBracket = jsonStr.search(/[\[{]/);
    const lastBracket = Math.max(jsonStr.lastIndexOf(']'), jsonStr.lastIndexOf('}'));
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      jsonStr = jsonStr.slice(firstBracket, lastBracket + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (parseErr) {
    await debugLog('warn', 'glossary', 'glossary JSON parse failed', {
      error: parseErr.message, finishReason,
      preview: rawText.slice(0, 500),
    });
    return { glossary: [], usage, _diag: `JSON parse error: ${parseErr.message}, preview: ${rawText.slice(0, 300)}` };
  }

  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const arrKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]));
    entries = arrKey ? parsed[arrKey] : null;
  }

  if (!entries) {
    return { glossary: [], usage, _diag: `no array in response (rawText first 500): ${rawText.slice(0, 500)}` };
  }

  if (entries.length === 0) {
    return { glossary: [], usage, _diag: `entries array is empty` };
  }

  const glossary = entries
    .filter(e => e && typeof e.source === 'string' && typeof e.target === 'string' && e.source && e.target)
    .slice(0, maxTerms);

  if (entries.length > 0 && glossary.length === 0) {
    const sampleDiag = JSON.stringify(entries.slice(0, 3)).slice(0, 500);
    return { glossary: [], usage, _diag: `entries=${entries.length} but 0 valid. samples: ${sampleDiag}` };
  }

  await debugLog('info', 'glossary', 'glossary extraction done', {
    totalEntries: entries.length, validTerms: glossary.length, elapsed: ms,
  });

  return { glossary, usage };
}

/**
 * 組合最終的 system instruction。
 */
function buildEffectiveSystemInstruction(baseSystem, texts, joined, glossary, fixedGlossary) {
  const parts = [baseSystem];

  if (texts.length > 1) {
    parts.push(
      `額外規則（多段翻譯分隔符與序號，極重要）:\n本批次包含 ${texts.length} 段文字。每段開頭有序號標記 «N»（N 為 1 到 ${texts.length}），段與段之間以分隔符 <<<SHINKANSEN_SEP>>> 隔開。\n你的輸出必須：\n- 每段譯文開頭也加上對應的序號標記 «N»（N 與輸入的序號一一對應）\n- 段與段之間用完全相同的分隔符 <<<SHINKANSEN_SEP>>> 隔開\n- 恰好輸出 ${texts.length} 段譯文和 ${texts.length - 1} 個分隔符\n- 不可合併段落、不可省略分隔符、不可增減段數`
    );
  }

  if (texts.some(t => t && t.indexOf('\n') !== -1)) {
    parts.push(
      '額外規則（段落分隔）:\n輸入中可能含有段內換行符 \\n（例如 "第一段\\n\\n第二段"）,代表原文有對應的段落或行分隔（通常是 <br> 或 <br><br>）。翻譯時必須在對應位置原樣保留 \\n 字元——譯文段落數與輸入段落數一致,連續兩個 \\n 也要保留兩個。不可把段落合併成一行,也不可把空白行多塞或少塞。'
    );
  }

  if (joined.indexOf('\u27E6') !== -1) {
    parts.push(
      '額外規則（極重要，處理佔位符標記）:\n輸入中可能含有兩種佔位符標記，都是用來保留原文結構，必須原樣保留、不可翻譯、不可省略、不可改寫、不可新增、不可重排。佔位符裡的數字、斜線、星號 **必須是半形 ASCII 字元**（0-9、/、*），絕對不可改成全形（０-９、／、＊），否則程式無法配對會整段崩壞。\n\n（A）配對型 ⟦數字⟧…⟦/數字⟧（例如 ⟦0⟧Tokugawa Ieyasu⟦/0⟧）：\n- 把標記視為透明外殼。外殼「內部」的文字跟外殼「外部」的文字一樣，全部都要翻譯成繁體中文。\n- ⟦數字⟧ 與 ⟦/數字⟧ 兩個標記本身原樣保留，數字不變。\n- **配對型可以巢狀嵌套**（例如 ⟦0⟧may incorporate text from a ⟦1⟧large language model⟦/1⟧, which is ...⟦/0⟧）。巢狀代表原文是 `<b>text <a>link</a> more text</b>` 這類嵌套結構。翻譯時必須**同時**保留外層與內層兩組標記、不可扁平化成單層、不可交換順序、不可遺漏任何一層。外層與內層的內部文字全部要翻成繁體中文。\n\n（B）自閉合 ⟦*數字⟧（例如 ⟦*5⟧）：\n- 這是「原子保留」位置記號，代表原文裡有一段不可翻譯的小區塊（例如維基百科腳註參照 [2])。\n- 整個 ⟦*數字⟧ token 原樣保留，不可拆開、不可翻譯、不可省略，數字不變。\n- 它的位置代表那段內容應該插在譯文的哪裡。\n\n具體範例 1（單層）：\n輸入： ⟦0⟧Tokugawa Ieyasu⟦/0⟧ won the ⟦1⟧Battle of Sekigahara⟦/1⟧ in 1600.⟦*2⟧\n正確輸出： ⟦0⟧德川家康⟦/0⟧於 1600 年贏得⟦1⟧關原之戰⟦/1⟧。⟦*2⟧\n錯誤輸出 1： ⟦0⟧Tokugawa Ieyasu⟦/0⟧於 1600 年贏得⟦1⟧Battle of Sekigahara⟦/1⟧。⟦*2⟧（配對型內部英文沒翻）\n錯誤輸出 2： ⟦0⟧德川家康⟦/0⟧於 1600 年贏得⟦1⟧關原之戰⟦/1⟧。[2]（自閉合 ⟦*2⟧ 被擅自還原成 [2]）\n\n具體範例 2（巢狀）：\n輸入： This article ⟦0⟧may incorporate text from a ⟦1⟧large language model⟦/1⟧, which is ⟦2⟧prohibited in Wikipedia articles⟦/2⟧⟦/0⟧.\n正確輸出： 本條目⟦0⟧可能包含來自⟦1⟧大型語言模型⟦/1⟧的文字，這在⟦2⟧維基百科條目中是被禁止的⟦/2⟧⟦/0⟧。\n錯誤輸出 3： 本條目可能包含來自⟦1⟧大型語言模型⟦/1⟧的文字，這在⟦2⟧維基百科條目中是被禁止的⟦/2⟧。（外層 ⟦0⟧…⟦/0⟧ 被扁平化丟掉）'
    );
  }

  if (glossary && glossary.length > 0) {
    const lines = ['\n額外規則（自動術語對照表，優先於模型自由發揮）：'];
    for (const { source, target } of glossary) {
      lines.push(`「${source}」譯為「${target}」`);
    }
    parts.push(lines.join('\n'));
  }

  if (fixedGlossary && fixedGlossary.length > 0) {
    const lines = ['\n額外規則（固定術語表，最高優先級）：'];
    for (const { source, target } of fixedGlossary) {
      lines.push(`「${source}」必須譯為「${target}」，不可改變`);
    }
    parts.push(lines.join('\n'));
  }

  return parts.join('\n\n');
}

/**
 * 翻譯主函式。
 * @param {string[]} texts 原文段落陣列
 * @param {object} settings 完整設定（需包含 apiKey, minimaxConfig, glossary, fixedGlossary）
 * @returns {Promise<{translations:string[], usage:{inputTokens:number, outputTokens:number, cachedTokens:number}, _diag?:string}>}
 */
export async function translate(texts, settings) {
  const { apiKey, minimaxConfig, glossary, fixedGlossary } = settings;
  const {
    model = 'MiniMax-M2.7',
    temperature = 1.0,
    topP = 0.95,
    maxOutputTokens = 8192,
  } = minimaxConfig;

  const effectiveSystem = buildEffectiveSystemInstruction(
    settings.systemInstruction || '',
    texts,
    texts.join(DELIMITER),
    glossary,
    fixedGlossary,
  );

  const joined = texts.join(DELIMITER);

  const body = {
    model,
    messages: [
      { role: 'system', content: effectiveSystem },
      { role: 'user', content: joined },
    ],
    temperature,
    top_p: topP,
    max_tokens: maxOutputTokens,
  };

  const url = 'https://api.minimax.chat/v1/chat/completions';

  await debugLog('info', 'api', 'minimax translate request', {
    model, texts: texts.length, chars: joined.length, maxOutputTokens,
  });

  const t0 = Date.now();
  const resp = await fetchWithRetry(url, { apiKey, data: body });
  const ms = Date.now() - t0;

  let json;
  try {
    json = await resp.json();
  } catch (parseErr) {
    await debugLog('error', 'api', 'minimax response parse failed', { status: resp.status, error: parseErr.message });
    throw new Error('回應格式錯誤：' + parseErr.message);
  }

  const usage = {
    inputTokens: json?.usage?.prompt_tokens || 0,
    outputTokens: json?.usage?.completion_tokens || 0,
    cachedTokens: 0,
  };

  if (!resp.ok) {
    const errMsg = json?.error?.message || `HTTP ${resp.status}`;
    await debugLog('error', 'api', 'minimax translate failed', { status: resp.status, error: errMsg, elapsed: ms });
    throw new Error(errMsg);
  }

  const rawText = json?.choices?.[0]?.message?.content || '';
  const finishReason = json?.choices?.[0]?.finish_reason || 'unknown';
  await debugLog('info', 'api', 'minimax translate response', {
    elapsed: ms, usage, rawChars: rawText.length, finishReason,
  });

  // 解析回應
  const translations = rawText.split(DELIMITER).map(s => s.trim());

  // 如果段數不符，用 fallback 逐段翻
  if (translations.length !== texts.length) {
    await debugLog('warn', 'api', 'minimax chunk count mismatch, falling back to sequential', {
      expected: texts.length, got: translations.length,
    });
    // 回傳空翻譯讓上層知道需要 fallback
    return { translations: [], usage, _diag: `chunk mismatch: expected ${texts.length}, got ${translations.length}` };
  }

  return { translations, usage };
}

// 預設匯出
export default { translate, extractGlossary, DailyQuotaExceededError };