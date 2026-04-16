# Shinkansen 字幕 Debug 面板說明

> **如何開啟**：設定頁 → Debug 分頁 → 勾選「顯示字幕翻譯即時狀態面板」，然後在 YouTube 頁面按 `Option + S` 啟動翻譯。頁面左上角會出現本面板。
>
> **維護規則**：每次修改 debug 面板的欄位或計算邏輯（`content-youtube.js` 的 `_debugRender` 函式），必須同步更新本檔。

---

## 欄位說明

### `active`
**值**：`true` / `false`

目前翻譯 session 是否啟動。按 `Option + S` 開啟翻譯時變 `true`，按第二次還原或換頁時變 `false`。若 `active = false` 但你看到字幕還在翻，代表前一個 session 的 observer 尚未清理完。

---

### `translating`
**值**：`true（N 視窗）` / `false（0 視窗）`

目前有幾個視窗的 API 請求在飛行中（in-flight）。`N > 1` 表示多個視窗並行翻譯（v1.2.54 起支援），這是正常行為，代表 Shinkansen 在搶先預翻下一個視窗。

---

### `speed`
**值**：`1x` / `1.5x` / `2x` 等

目前的影片播放速度。Lookahead 與 adaptive lookahead 都會乘以這個值，速度愈快、預警點愈早。

---

### `rawSegments`
**值**：`N 條（涵蓋 Xs）`

從 YouTube 字幕 API（XHR 攔截）拿到的原始字幕條數，以及最後一條字幕的時間戳（整支影片的字幕涵蓋範圍）。若顯示 `0 條`，代表 XHR 尚未攔截到，字幕資料還未就緒。

---

### `captionMap`
**值**：`N 條`

目前已翻譯並快取的字幕條數（`normText → 中文譯文` 的 Map 大小）。翻譯完成後應等於或接近 `rawSegments` 的條數。

---

### `translated↑`
**值**：`Xs`

翻譯排程推進到的位置（`translatedUpToMs / 1000`，單位秒）。這是一個「宣告值」，代表 Shinkansen 已排定翻譯到這個時間點，但 API 可能還沒回來。數字很大不代表翻完，要搭配 `buffer` 和 `coverage` 一起看。

---

### `coverage`
**值**：`Xs` / `—`

實際確實翻完的最遠位置（`captionMapCoverageUpToMs`）。與 `translated↑` 不同：`coverage` 是「API 回來、captionMap 填入完成」的高水位線，`translated↑` 只是排程預告。`translated↑ > coverage` 很正常（有視窗在飛行中）；若長時間 `coverage` 沒有增加，代表 API 卡住了。

---

### `video now`
**值**：`X.Xs`

影片目前的播放位置（`video.currentTime`，單位秒）。

---

### `buffer`
**值**：`+Xs ✓` / `-Xs ⚠️ 落後` / `翻譯中…`

**最重要的診斷欄位。**

| 顯示值 | 含意 |
|---|---|
| `+Xs ✓` | 翻譯比播放位置超前 X 秒，字幕備妥充裕 |
| `-Xs ⚠️ 落後` | 播放已追上翻譯進度，字幕可能來不及，on-the-fly 備援會啟動 |
| `翻譯中…` | 當前播放位置所在的視窗正在翻譯中（API in-flight），buffer 數字因提前佔位而不準確，此時顯示「翻譯中…」更能反映真實狀態 |

計算方式：`buffer = translatedUpToMs − video.currentTime × 1000`，但若當前視窗在 `translatingWindows`（API 飛行中）且不在 `translatedWindows`（尚未完成），顯示「翻譯中…」取代數值（v1.2.59）。

**seek 後的正常流程**：拖進度條 → `buffer` 顯示「翻譯中…」→ API 回來、視窗標記完成 → `buffer` 變回 `+Xs ✓`

---

### `batch API`
**值**：`N₁ / N₂ / N₃ms` / `—`

本次視窗各批次 API 呼叫的完成耗時（毫秒，從視窗翻譯開始計）。格式如 `1520 / 4300 / 6100ms`，代表 batch 0 在 1520ms 完成、batch 1 在 4300ms 完成、batch 2 在 6100ms 完成。翻譯進行中尚未完成的批次顯示 `…`。

v1.2.56 起，batch 0 先序列完成（暖熱 Gemini implicit cache），batch 1+ 並行，所以 batch 0 的耗時通常最短（1–2s），後續批次耗時也短（cache 已熱）。若 batch 0 也很慢（>10s），代表 Gemini 伺服器端 cache 是冷的（第一次使用或長時間未用）。

---

### `batch0 size`
**值**：`N 條（lead +Xs）` / `N 條（⚠️ lead -Xs）`

批次 0 的字幕條數，以及觸發時距影片位置的 lead time。

| 顯示值 | 含意 |
|---|---|
| `1 條（⚠️ lead -2.3s）` | 影片已超過視窗起點 2.3 秒才觸發翻譯，緊急模式，首批只送 1 條 |
| `2 條（lead +3.1s）` | 還有 3.1 秒 lead time，首批 2 條 |
| `8 條（lead +15.2s）` | lead time 充裕（≥10s），正常首批 8 條 |

Lead time 是自適應首批大小（v1.2.50）的依據：lead 愈短，batch 0 條數愈少，回應愈快，第一條字幕出現愈早。

---

### `on-the-fly`
**值**：`N 條`

本 session 累計落入 on-the-fly 備援的字幕條數（每個 normText key 只算一次）。On-the-fly 備援是指：字幕出現在畫面上但 captionMap 還沒有對應的中文譯文，必須立即送 API 即時翻譯。數字高代表預翻追不上播放進度。

若 on-the-fly 設定關閉（預設），此欄永遠為 `0`（cache miss 不觸發即時翻譯，等預翻完成）。

---

### `stale skip`
**值**：`0` / `⚠️ N 次`

過期視窗追趕事件的發生次數。觸發條件：某個視窗的 API 耗時超過視窗長度（`windowSizeS`），影片播放時間已超過視窗末端，視窗翻完後立刻跳到影片當前位置重新翻譯。正常情況下為 `0`；若頻繁出現 `⚠️ N 次`，代表所選模型速度不夠快、buffer 嚴重不足。

---

### `window/look`
**值**：`Ws / Ls`

設定頁的「視窗大小（秒）」與「觸發提前量（秒）」。當影片播放位置距離 `translated↑` 不足 `lookaheadS × 1000 × playbackRate` 毫秒時，觸發下一個視窗的翻譯。

---

### `adapt look`
**值**：`Xs` / `—`

目前生效的自適應 lookahead 值。初始為 `—`（尚未翻完第一個視窗，無統計依據）；第一個視窗完成後，根據 `lastApiMs × 1.3 × playbackRate`（取與設定值的較大者）動態更新。API 慢時自動拉長，確保下次觸發夠早；API 快時收縮回設定值。

---

### `事件`
**值**：最近一次狀態變化的文字描述

最新觸發的 debug 事件標籤，例如：
- `seeked → 重設翻譯起點 120s` — 使用者拖進度條
- `timeupdate 觸發下一批（now: 28s，up to: 30s）` — 自動觸發下一視窗
- `視窗 30–60s 完成（captionMap: 42）` — 某視窗 API 回應完成
- `⚠️ 過期跳位 → 65s（第 1 次）` — 觸發過期視窗追趕

---

## 常見診斷情境

**第一條中文字幕很慢出現（>5s）**

看 `batch API` 的第一個數字。若 >5000ms，代表 Gemini 伺服器 cache 是冷的（reload extension 後第一次翻譯），屬正常，v1.2.56 的 batch 0 串列機制會讓第二次之後快很多。若持續很慢，考慮換更快的模型（Flash 而非 Flash Lite）。

**字幕顯示英文，buffer 一直是正值**

`captionMap` 大小是否接近 0？若是，代表翻譯結果沒有寫入，可能是 API 出錯或 rawSegments 為空（CC 未開啟）。檢查 `rawSegments` 是否 > 0。

**on-the-fly 數字一直增加**

buffer 是否出現 `-Xs ⚠️ 落後`？若是，代表預翻追不上，考慮：（1）降低播放速度、（2）增加 lookahead 設定值、（3）換更快的模型。

**stale skip 一直出現 ⚠️**

API 速度太慢，每個視窗翻譯時間超過視窗長度。換更快的模型，或增大 windowSizeS（讓一個視窗有更多字幕可以攤平 API 延遲）。
