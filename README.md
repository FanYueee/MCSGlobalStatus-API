# MCSGlobalStatus API

這個 repo 是 controller。

它負責：

- 一般模式查詢 `/v1/status/:server`
- 分散式查詢 `/v1/distributed/:server`
- Probe WebSocket `/v1/stream`
- health / observability

## 快速開始

先裝套件：

```bash
npm install
```

把範例 env 複製成自己的設定：

```bash
cp .env.example .env
```

再準備 `probes.json`：

```json
{
  "local-01": "your-very-long-secret"
}
```

開發模式：

```bash
npm run dev
```

正式啟動：

```bash
npm run build
npm run start
```

預設會開在 `http://0.0.0.0:3000`。

## env

`.env.example` 已經有一份可直接改的範例，常用的就這幾個：

| 變數 | 用途 | 預設 |
| --- | --- | --- |
| `PORT` | API port | `3000` |
| `HOST` | 綁定位址 | `0.0.0.0` |
| `GEOIP_DIR` | GeoIP 資料庫路徑 | `./data/geoip` |
| `TRUST_PROXY` | 如果前面有 Nginx / Caddy 就開 `true` | `false` |
| `CORS_ORIGINS` | 前端允許來源，逗號分隔 | 空 |
| `HEALTH_DETAILS_WHITELIST` | 哪些 IP / CIDR 可以看 `/health/details` | 空 |
| `RATE_LIMIT_WINDOW_MS` | rate limit 視窗 | `60000` |
| `RATE_LIMIT_STATUS_MAX` | `/v1/status` 每 IP 次數 | `60` |
| `RATE_LIMIT_DISTRIBUTED_MAX` | `/v1/distributed` 每 IP 次數 | `20` |
| `RATE_LIMIT_WEBSOCKET_MAX` | `/v1/stream` 每 IP 次數 | `30` |

## GeoIP

如果你要完整的 IP 地理位置和 ASN 資訊，需要自己準備 MaxMind 資料庫。

這個 repo 不會直接附資料庫檔案，主要是授權和散佈問題。

做法很簡單：

1. 自己到 MaxMind 下載需要的資料庫
2. 放到你設定的 `GEOIP_DIR`
3. 重開 API

如果沒放，API 一樣能跑，只是 `ip_info` 會比較有限。

## Probe 設定

Probe 連線時會帶自己的 `id` 和 `Bearer secret`。

`probes.json` 內容格式就是：

```json
{
  "probe-id": "secret"
}
```

只要 `id` 和 secret 對得上，就能連進來。這個檔案支援熱重載，改完不用重開 API。

## 端點

- `GET /v1/status/:server?type=java|bedrock`
- `GET /v1/distributed/:server?type=java|bedrock`
- `GET /health`
- `GET /health/details`
- `GET /`
- `WS /v1/stream?id=...&region=...`

## 小提醒

- `/health` 是公開版，只看服務有沒有活著。
- `/health/details` 會看 allowlist，不在白名單就會 `403`。
- Probe 會定期送 heartbeat，所以 `last_seen_at` 會比單純看 task 結果更準。
- `probe_nodes[].stale` 代表這個 Probe 雖然 WebSocket 還開著，但最近一段時間沒有 heartbeat 或其他訊息。
- 如果你在 WSL 裡跑，前端要從 Windows 瀏覽器打進來，記得把前端網址加進 `CORS_ORIGINS`。
