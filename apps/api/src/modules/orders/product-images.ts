import type { DatabaseSync } from "node:sqlite";

/** 单个订单最多保存的产品详情图数量。 */
export const MAX_ORDER_PRODUCT_IMAGES = 5;

export type OrderProductImagePayload = {
  id: string;
  fileName: string;
  mime: string;
  contentBase64: string;
  createdAt: string;
};

/**
 * 批量读取订单关联的产品详情图（每单最多 5 张，按创建时间升序）。
 */
export function loadProductImagesForOrders(
  db: DatabaseSync,
  companyId: string,
  orderIds: string[],
): Map<string, OrderProductImagePayload[]> {
  if (orderIds.length === 0) return new Map();
  const uniq = [...new Set(orderIds)];
  const placeholders = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
      SELECT id, order_id, file_name, mime, content_base64, created_at
      FROM order_product_images
      WHERE company_id = ? AND order_id IN (${placeholders})
      ORDER BY order_id, created_at ASC
      `,
    )
    .all(companyId, ...uniq) as Array<{
    id: string;
    order_id: string;
    file_name: string;
    mime: string;
    content_base64: string;
    created_at: string;
  }>;
  const map = new Map<string, OrderProductImagePayload[]>();
  for (const row of rows) {
    const list = map.get(row.order_id) ?? [];
    if (list.length >= MAX_ORDER_PRODUCT_IMAGES) continue;
    list.push({
      id: row.id,
      fileName: row.file_name,
      mime: row.mime,
      contentBase64: row.content_base64,
      createdAt: row.created_at,
    });
    map.set(row.order_id, list);
  }
  return map;
}
