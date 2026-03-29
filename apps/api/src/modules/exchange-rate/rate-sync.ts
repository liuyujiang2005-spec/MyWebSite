import type { DatabaseSync } from "node:sqlite";

interface OpenErApiResponse {
  result?: string;
  rates?: Record<string, number>;
  time_last_update_utc?: string;
}

const DEFAULT_EXCHANGE_RATE_API = "https://open.er-api.com/v6/latest/CNY";
const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;

let syncingPromise: Promise<void> | null = null;

/**
 * 读取当前已存储的 CNY/THB 汇率记录。
 */
export function getCurrentCnyThbRate(db: DatabaseSync): { rate: number; updatedAt: string } | null {
  const row = db
    .prepare(
      `
      SELECT rate, updated_at
      FROM client_exchange_rates
      WHERE base_currency = 'CNY' AND quote_currency = 'THB'
      LIMIT 1
      `,
    )
    .get() as { rate: number; updated_at: string } | undefined;
  if (!row) return null;
  return { rate: row.rate, updatedAt: row.updated_at };
}

/**
 * 将最新 CNY/THB 汇率写入数据库。
 */
export function upsertCnyThbRate(db: DatabaseSync, input: { rate: number; updatedAt?: string }): void {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  db.prepare(
    `
    INSERT OR REPLACE INTO client_exchange_rates (base_currency, quote_currency, rate, updated_at)
    VALUES (?, ?, ?, ?)
    `,
  ).run("CNY", "THB", input.rate, updatedAt);
}

/**
 * 从外部行情服务获取 CNY/THB 实时汇率。
 */
export async function fetchLiveCnyThbRate(): Promise<{ rate: number; updatedAt: string }> {
  const endpoint = process.env.EXCHANGE_RATE_API_URL?.trim() || DEFAULT_EXCHANGE_RATE_API;
  const response = await fetch(endpoint, { method: "GET" });
  if (!response.ok) {
    throw new Error(`exchange api http ${response.status}`);
  }
  const data = (await response.json()) as OpenErApiResponse;
  const rate = data?.rates?.THB;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("invalid THB rate from exchange api");
  }
  const updatedAt = new Date(data.time_last_update_utc ?? Date.now()).toISOString();
  return { rate, updatedAt };
}

/**
 * 判断汇率记录是否超过刷新间隔。
 */
function isRateStale(updatedAt: string, nowIso: string): boolean {
  const updatedMs = Date.parse(updatedAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - updatedMs >= REFRESH_INTERVAL_MS;
}

/**
 * 如汇率已过刷新间隔，则拉取外部行情并更新数据库；否则复用缓存。
 */
export async function refreshCnyThbRateIfStale(
  db: DatabaseSync,
): Promise<{ rate: number; updatedAt: string; refreshed: boolean }> {
  const nowIso = new Date().toISOString();
  const current = getCurrentCnyThbRate(db);
  if (current && !isRateStale(current.updatedAt, nowIso)) {
    return { rate: current.rate, updatedAt: current.updatedAt, refreshed: false };
  }

  if (!syncingPromise) {
    syncingPromise = (async () => {
      const live = await fetchLiveCnyThbRate();
      upsertCnyThbRate(db, { rate: live.rate, updatedAt: live.updatedAt });
    })()
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[exchange-rate] refresh failed:", error);
      })
      .finally(() => {
        syncingPromise = null;
      });
  }
  await syncingPromise;

  const latest = getCurrentCnyThbRate(db);
  if (latest) {
    return { rate: latest.rate, updatedAt: latest.updatedAt, refreshed: true };
  }

  // Fallback keeps wallet page available when first sync fails.
  return { rate: 5.06, updatedAt: nowIso, refreshed: false };
}

/**
 * 启动汇率自动刷新任务（每 2 小时执行一次，启动时先执行一次）。
 */
export function startDailyExchangeRateScheduler(db: DatabaseSync): void {
  const run = async () => {
    const result = await refreshCnyThbRateIfStale(db);
    // eslint-disable-next-line no-console
    console.log(
      `[exchange-rate] CNY/THB=${result.rate.toFixed(4)} updatedAt=${result.updatedAt} refreshed=${result.refreshed}`,
    );
  };
  void run();
  setInterval(() => {
    void run();
  }, REFRESH_INTERVAL_MS);
}
