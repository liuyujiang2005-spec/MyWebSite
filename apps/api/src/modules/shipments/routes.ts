import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { ensureShipmentOrderLinks } from "../../db/sqlite";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, parseJsonArray, requireRole } from "../core/http-utils";
import { loadProductImagesForOrders } from "../orders/product-images";

const STATUS_FLOW = [
  "created",
  "pickedUp",
  "inWarehouseCN",
  "customsPending",
  "inTransit",
  "customsTH",
  "outForDelivery",
  "delivered",
];
const EXCEPTION_STATUSES = new Set(["exception", "returned", "cancelled"]);

interface Kuaidi100QueryPayload {
  com?: string;
  num: string;
}

interface Kuaidi100QueryResponse {
  status?: string;
  message?: string;
  state?: string;
  com?: string;
  nu?: string;
  data?: Array<{
    context?: string;
    ftime?: string;
    time?: string;
  }>;
}

interface Kuaidi100WebQueryResponse {
  status?: string;
  message?: string;
  state?: string;
  com?: string;
  nu?: string;
  data?: Array<{
    context?: string;
    ftime?: string;
    time?: string;
  }>;
}

function canTransit(fromStatus: string, toStatus: string): boolean {
  if (fromStatus === toStatus) return true;
  if (EXCEPTION_STATUSES.has(toStatus)) return true;
  const fromIndex = STATUS_FLOW.indexOf(fromStatus);
  const toIndex = STATUS_FLOW.indexOf(toStatus);
  if (fromIndex < 0 || toIndex < 0) return false;
  return toIndex === fromIndex + 1;
}

/**
 * 计算快递100签名（MD5 大写）。
 */
function createKuaidi100Sign(paramText: string, key: string, customer: string): string {
  return createHash("md5").update(`${paramText}${key}${customer}`).digest("hex").toUpperCase();
}

/**
 * 将快递100状态码映射为中文文案。
 */
function mapKuaidi100State(state?: string): string {
  if (state === "0") return "在途";
  if (state === "1") return "揽收";
  if (state === "2") return "疑难";
  if (state === "3") return "已签收";
  if (state === "4") return "退签";
  if (state === "5") return "派件";
  if (state === "6") return "退回";
  return "未知";
}

export function registerShipmentRoutes(app: MinimalHttpApp, db: DatabaseSync): void {
  app.get("/staff/inbound-photos", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const shipmentId = req.query.shipmentId?.trim();
    if (!shipmentId) {
      fail(res, 400, "BAD_REQUEST", "shipmentId is required");
      return;
    }
    const rows = db
      .prepare(
        `
        SELECT id, shipment_id, operator_id, file_name, mime, content_base64, note, created_at
        FROM staff_inbound_photos
        WHERE company_id = ? AND shipment_id = ?
        ORDER BY created_at DESC
        `,
      )
      .all(auth.companyId, shipmentId) as Array<{
      id: string;
      shipment_id: string;
      operator_id: string;
      file_name: string;
      mime: string;
      content_base64: string;
      note: string | null;
      created_at: string;
    }>;
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        shipmentId: item.shipment_id,
        operatorId: item.operator_id,
        fileName: item.file_name,
        mime: item.mime,
        contentBase64: item.content_base64,
        note: item.note ?? undefined,
        createdAt: item.created_at,
      })),
    });
  });

  app.post("/staff/inbound-photos", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      shipmentId?: string;
      fileName?: string;
      mime?: string;
      contentBase64?: string;
      note?: string;
    };
    const shipmentId = body.shipmentId?.trim();
    const fileName = body.fileName?.trim();
    const mime = body.mime?.trim();
    const contentBase64 = body.contentBase64?.trim();
    if (!shipmentId || !fileName || !mime || !contentBase64) {
      fail(res, 400, "BAD_REQUEST", "shipmentId, fileName, mime, contentBase64 are required");
      return;
    }
    const shipment = db
      .prepare("SELECT id FROM shipments WHERE id = ? AND company_id = ?")
      .get(shipmentId, auth.companyId) as { id: string } | undefined;
    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }
    if (contentBase64.length > 4_000_000) {
      fail(res, 400, "BAD_REQUEST", "file too large (max 4MB base64)");
      return;
    }
    const id = `photo_${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO staff_inbound_photos (
        id, company_id, shipment_id, operator_id, file_name, mime, content_base64, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(id, auth.companyId, shipmentId, auth.userId, fileName, mime, contentBase64, body.note?.trim() || null, now);
    ok(res, { id, shipmentId, createdAt: now });
  });

  app.post("/staff/shipments/set-container", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentId?: string; containerNo?: string };
    const shipmentId = body.shipmentId?.trim();
    const containerNo = body.containerNo?.trim();
    if (!shipmentId || !containerNo) {
      fail(res, 400, "BAD_REQUEST", "shipmentId and containerNo are required");
      return;
    }
    const shipment = db
      .prepare("SELECT id, warehouse_id FROM shipments WHERE id = ? AND company_id = ?")
      .get(shipmentId, auth.companyId) as { id: string; warehouse_id: string } | undefined;
    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }
    if (auth.role === "staff") {
      const user = db
        .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
        .get(auth.userId) as { warehouse_ids: string } | undefined;
      const editableWarehouses = parseJsonArray(user?.warehouse_ids);
      if (!editableWarehouses.includes(shipment.warehouse_id)) {
        fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
        return;
      }
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE shipments SET container_no = ?, updated_at = ? WHERE id = ?").run(containerNo, now, shipmentId);
    ok(res, { shipmentId, containerNo, updatedAt: now });
  });

  app.get("/public/track", async (req, res) => {
    const trackingNo = req.query.trackingNo?.trim();
    const phoneLast4 = req.query.phoneLast4?.trim();
    if (!trackingNo || !phoneLast4 || phoneLast4.length !== 4) {
      fail(res, 400, "BAD_REQUEST", "trackingNo and phoneLast4(4 digits) are required");
      return;
    }
    const row = db
      .prepare(
        `
        SELECT
          s.id,
          s.tracking_no,
          s.domestic_tracking_no,
          s.batch_no,
          s.current_status,
          s.current_location,
          s.updated_at,
          o.id AS order_id,
          o.item_name,
          o.receiver_phone_th,
          u.phone AS client_phone
        FROM shipments s
        JOIN orders o ON o.id = s.order_id
        LEFT JOIN users u ON u.id = o.client_id
        WHERE s.tracking_no = ?
        LIMIT 1
        `,
      )
      .get(trackingNo) as
      | {
          id: string;
          tracking_no: string;
          domestic_tracking_no: string | null;
          batch_no: string | null;
          current_status: string;
          current_location: string | null;
          updated_at: string;
          order_id: string;
          item_name: string;
          receiver_phone_th: string | null;
          client_phone: string | null;
        }
      | undefined;
    if (!row) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }
    const receiverTail = (row.receiver_phone_th ?? "").slice(-4);
    const clientTail = (row.client_phone ?? "").slice(-4);
    if (phoneLast4 !== receiverTail && phoneLast4 !== clientTail) {
      fail(res, 403, "FORBIDDEN", "phone verification failed");
      return;
    }
    const logs = db
      .prepare(
        `
        SELECT from_status, to_status, remark, changed_at
        FROM status_logs
        WHERE shipment_id = ?
        ORDER BY changed_at ASC
        `,
      )
      .all(row.id) as Array<{ from_status: string; to_status: string; remark: string | null; changed_at: string }>;
    ok(res, {
      trackingNo: row.tracking_no,
      domesticTrackingNo: row.domestic_tracking_no ?? undefined,
      batchNo: row.batch_no ?? undefined,
      orderId: row.order_id,
      itemName: row.item_name,
      currentStatus: row.current_status,
      currentLocation: row.current_location ?? undefined,
      updatedAt: row.updated_at,
      events: logs.map((item) => ({
        fromStatus: item.from_status,
        toStatus: item.to_status,
        remark: item.remark ?? "",
        changedAt: item.changed_at,
      })),
    });
  });

  app.get("/client/express/universal", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;
    const trackingNo = req.query.trackingNo?.trim();
    const companyCode = req.query.companyCode?.trim();
    if (!trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
      return;
    }

    const customer = process.env.KUAIDI100_CUSTOMER?.trim();
    const key = process.env.KUAIDI100_KEY?.trim();
    const endpoint = process.env.KUAIDI100_QUERY_URL?.trim() || "https://poll.kuaidi100.com/poll/query.do";
    const webQueryEndpoint = process.env.KUAIDI100_WEB_QUERY_URL?.trim() || "https://www.kuaidi100.com/query";

    if (customer && key) {
      const payload: Kuaidi100QueryPayload = {
        num: trackingNo,
      };
      if (companyCode) payload.com = companyCode;
      const paramText = JSON.stringify(payload);
      const sign = createKuaidi100Sign(paramText, key, customer);
      const body = new URLSearchParams();
      body.set("customer", customer);
      body.set("sign", sign);
      body.set("param", paramText);

      let providerData: Kuaidi100QueryResponse | null = null;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });
        providerData = (await response.json()) as Kuaidi100QueryResponse;
        if (!response.ok) {
          fail(res, 502, "INTERNAL_ERROR", `kuaidi100 request failed: HTTP ${response.status}`);
          return;
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : "unknown error";
        fail(res, 502, "INTERNAL_ERROR", `kuaidi100 request failed: ${text}`);
        return;
      }

      if (providerData?.status !== "200") {
        fail(res, 400, "BAD_REQUEST", providerData?.message ?? "kuaidi100 query failed");
        return;
      }

      ok(res, {
        trackingNo: providerData.nu ?? trackingNo,
        companyCode: providerData.com ?? companyCode ?? "",
        statusCode: providerData.state ?? "",
        statusText: mapKuaidi100State(providerData.state),
        events: (providerData.data ?? []).map((item) => ({
          time: item.ftime ?? item.time ?? "",
          content: item.context ?? "",
        })),
      });
      return;
    }

    if (!companyCode) {
      fail(res, 400, "BAD_REQUEST", "companyCode is required when KUAIDI100 key is not configured");
      return;
    }

    let webData: Kuaidi100WebQueryResponse | null = null;
    try {
      const query = new URLSearchParams();
      query.set("type", companyCode);
      query.set("postid", trackingNo);
      const response = await fetch(`${webQueryEndpoint}?${query.toString()}`, {
        method: "GET",
      });
      webData = (await response.json()) as Kuaidi100WebQueryResponse;
      if (!response.ok) {
        fail(res, 502, "INTERNAL_ERROR", `kuaidi100 web query failed: HTTP ${response.status}`);
        return;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "unknown error";
      fail(res, 502, "INTERNAL_ERROR", `kuaidi100 web query failed: ${text}`);
      return;
    }

    if (webData?.status !== "200") {
      fail(res, 400, "BAD_REQUEST", webData?.message ?? "kuaidi100 web query failed");
      return;
    }

    ok(res, {
      trackingNo: webData.nu ?? trackingNo,
      companyCode: webData.com ?? companyCode,
      statusCode: webData.state ?? "",
      statusText: mapKuaidi100State(webData.state),
      events: (webData.data ?? []).map((item) => ({
        time: item.ftime ?? item.time ?? "",
        content: item.context ?? "",
      })),
    });
  });

  app.get("/client/shipments/search", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const trackingNo = req.query.trackingNo?.trim();
    const domesticTrackingNo = req.query.domesticTrackingNo?.trim();
    const itemName = req.query.itemName?.trim();
    const transportMode = req.query.transportMode?.trim();

    const rows = db
      .prepare(`
        SELECT
          s.id, s.order_id, s.tracking_no, s.batch_no, s.current_status, s.current_location, s.updated_at,
          s.weight_kg, s.volume_m3, s.package_count, s.package_unit, s.domestic_tracking_no,
          o.client_id, o.item_name, o.transport_mode
        FROM shipments s
        JOIN orders o ON o.id = s.order_id
        WHERE s.company_id = ?
        ORDER BY s.updated_at DESC
      `)
      .all(auth.companyId) as Array<{
      id: string;
      order_id: string;
      tracking_no: string;
      batch_no: string | null;
      current_status: string;
      current_location: string | null;
      updated_at: string;
      weight_kg: number | null;
      volume_m3: number | null;
      package_count: number | null;
      package_unit: string | null;
      domestic_tracking_no: string | null;
      client_id: string;
      item_name: string;
      transport_mode: string;
    }>;

    const items = rows
      .filter((r) => r.client_id === auth.userId)
      .filter((r) => !trackingNo || r.tracking_no === trackingNo)
      .filter((r) => !domesticTrackingNo || r.domestic_tracking_no === domesticTrackingNo)
      .filter((r) => !itemName || r.item_name.includes(itemName))
      .filter((r) => !transportMode || r.transport_mode === transportMode)
      .map((r) => ({
        id: r.id,
        orderId: r.order_id,
        trackingNo: r.tracking_no,
        batchNo: r.batch_no,
        currentStatus: r.current_status,
        currentLocation: r.current_location,
        updatedAt: r.updated_at,
        weightKg: r.weight_kg,
        volumeM3: r.volume_m3,
        packageCount: r.package_count,
        packageUnit: r.package_unit,
        domesticTrackingNo: r.domestic_tracking_no,
      }));

    ok(res, { items, page: 1, pageSize: items.length, total: items.length });
  });

  app.get("/staff/shipments", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const user = db
      .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
      .get(auth.userId) as { warehouse_ids: string } | undefined;
    const editableWarehouses = parseJsonArray(user?.warehouse_ids);

    const rows = db
      .prepare(`
        SELECT
          s.id, s.order_id, s.tracking_no, s.batch_no, s.current_status, s.warehouse_id, s.updated_at,
          s.container_no,
          s.domestic_tracking_no, s.package_count, s.weight_kg, s.volume_m3,
          o.id AS linked_order_id,
          o.warehouse_id AS order_warehouse_id,
          o.client_id, o.item_name, o.product_quantity, o.created_at, o.package_unit AS order_package_unit,
          o.transport_mode, o.ship_date, o.receiver_address_th,
          o.receivable_amount_cny, o.receivable_currency, o.payment_status,
          u.name AS client_name
        FROM shipments s
        LEFT JOIN orders o ON o.id = s.order_id AND o.company_id = s.company_id
        LEFT JOIN users u ON u.id = o.client_id
        WHERE s.company_id = ?
        ORDER BY s.updated_at DESC
      `)
      .all(auth.companyId) as Array<{
      id: string;
      order_id: string | null;
      tracking_no: string;
      batch_no: string | null;
      current_status: string;
      warehouse_id: string;
      order_warehouse_id: string | null;
      container_no: string | null;
      updated_at: string;
      domestic_tracking_no: string | null;
      package_count: number | null;
      weight_kg: number | null;
      volume_m3: number | null;
      client_id: string | null;
      client_name: string | null;
      item_name: string | null;
      product_quantity: number | null;
      created_at: string | null;
      transport_mode: string | null;
      ship_date: string | null;
      receiver_address_th: string | null;
      receivable_amount_cny: number | null;
      receivable_currency: string | null;
      payment_status: string | null;
      order_package_unit: string | null;
      linked_order_id: string | null;
    }>;

    const orderIds = rows.map((r) => r.linked_order_id).filter((id): id is string => Boolean(id));
    const imageMap = loadProductImagesForOrders(db, auth.companyId, orderIds);

    const items = rows.map((r) => {
      /** 权限与 /staff/orders/product-images 一致：以订单归属仓库为准，无订单时退回运单仓库。 */
      const permissionWarehouseId = r.order_warehouse_id ?? r.warehouse_id;
      return {
      id: r.id,
      /** 仅当订单行存在且与运单同公司时有效，避免 s.order_id 悬空或脏数据误判。 */
      orderId: r.linked_order_id ?? undefined,
      trackingNo: r.tracking_no,
      batchNo: r.batch_no,
      containerNo: r.container_no ?? undefined,
      clientId: r.client_id ?? undefined,
      clientName: r.client_name ?? undefined,
      itemName: r.item_name ?? undefined,
      domesticTrackingNo: r.domestic_tracking_no ?? undefined,
      packageCount: r.package_count ?? undefined,
      productQuantity: r.product_quantity ?? undefined,
      weightKg: r.weight_kg ?? undefined,
      volumeM3: r.volume_m3 ?? undefined,
      arrivedAt: r.created_at ?? undefined,
      currentStatus: r.current_status,
      warehouseId: r.warehouse_id,
      updatedAt: r.updated_at,
      transportMode: r.transport_mode ?? undefined,
      shipDate: r.ship_date ?? undefined,
      receiverAddressTh: r.receiver_address_th ?? undefined,
      receivableAmountCny: r.receivable_amount_cny ?? undefined,
      receivableCurrency: r.receivable_currency ?? undefined,
      paymentStatus: r.payment_status === "paid" ? "paid" : "unpaid",
      packageUnit: (r.order_package_unit === "bag" ? "bag" : "box") as "bag" | "box",
      /** 订单级字段仅管理员可改；员工端仅可查看列表。 */
      canEdit: auth.role === "admin",
      productImages: r.linked_order_id ? imageMap.get(r.linked_order_id) ?? [] : [],
    };
    });

    ok(res, { items, page: 1, pageSize: items.length, total: items.length });
  });

  app.post("/staff/shipments/update-status", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      shipmentId?: string;
      batchNo?: string;
      toStatus?: string;
      remark?: string;
      updateByBatch?: boolean;
    };
    if (!body.toStatus) {
      fail(res, 400, "BAD_REQUEST", "toStatus is required");
      return;
    }
    const updateByBatch = Boolean(body.updateByBatch || body.batchNo?.trim());
    if (!updateByBatch && !body.shipmentId) {
      fail(res, 400, "BAD_REQUEST", "shipmentId is required when updateByBatch=false");
      return;
    }
    if (updateByBatch && !body.batchNo?.trim()) {
      fail(res, 400, "BAD_REQUEST", "batchNo is required when updateByBatch=true");
      return;
    }

    const targetShipments = updateByBatch
      ? (db
          .prepare("SELECT id, current_status, warehouse_id FROM shipments WHERE batch_no = ? AND company_id = ?")
          .all(body.batchNo?.trim(), auth.companyId) as Array<{
          id: string;
          current_status: string;
          warehouse_id: string;
        }>)
      : (db
          .prepare("SELECT id, current_status, warehouse_id FROM shipments WHERE id = ? AND company_id = ?")
          .all(body.shipmentId, auth.companyId) as Array<{
          id: string;
          current_status: string;
          warehouse_id: string;
        }>);
    if (targetShipments.length === 0) {
      fail(res, 404, "NOT_FOUND", updateByBatch ? "batch shipments not found" : "shipment not found");
      return;
    }

    if (auth.role === "staff") {
      const user = db
        .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
        .get(auth.userId) as { warehouse_ids: string } | undefined;
      const editableWarehouses = parseJsonArray(user?.warehouse_ids);
      const denied = targetShipments.some((shipment) => !editableWarehouses.includes(shipment.warehouse_id));
      if (denied) {
        fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
        return;
      }
    }

    const invalid = targetShipments.some((shipment) => !canTransit(shipment.current_status, body.toStatus));
    if (invalid) {
      fail(res, 400, "VALIDATION_ERROR", "invalid status transition");
      return;
    }

    const now = new Date().toISOString();
    const updateStmt = db.prepare("UPDATE shipments SET current_status = ?, updated_at = ? WHERE id = ?");
    const insertLogStmt = db.prepare(
      "INSERT INTO status_logs (id, company_id, shipment_id, operator_id, operator_role, from_status, to_status, remark, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    targetShipments.forEach((shipment, idx) => {
      updateStmt.run(body.toStatus, now, shipment.id);
      insertLogStmt.run(
        `sl_${Date.now()}_${idx}`,
        auth.companyId,
        shipment.id,
        auth.userId,
        auth.role,
        shipment.current_status,
        body.toStatus,
        body.remark ?? null,
        now,
      );
    });

    ok(res, {
      mode: updateByBatch ? "batch" : "single",
      batchNo: body.batchNo?.trim() || null,
      shipmentId: updateByBatch ? null : targetShipments[0]?.id,
      shipmentIds: targetShipments.map((s) => s.id),
      fromStatus: targetShipments[0]?.current_status ?? null,
      toStatus: body.toStatus,
      updatedCount: targetShipments.length,
      changedAt: now,
    });
  });

  /**
   * 手动修复「运单未关联订单」数据：为缺失订单或悬空 order_id 的运单补建订单。
   * 员工仅处理本公司；管理员可处理全库（不传 company 时）。
   * 请求体可选 `{ shipmentId }`：仅修复该运单，便于列表页「尝试修复关联」定向处理。
   */
  app.post("/staff/shipments/repair-order-links", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentId?: string };
    const shipmentId = body.shipmentId?.trim();
    const scopeCompany = auth.role === "staff" ? auth.companyId : undefined;
    if (auth.role === "staff" && shipmentId) {
      const row = db
        .prepare("SELECT id FROM shipments WHERE id = ? AND company_id = ?")
        .get(shipmentId, auth.companyId) as { id: string } | undefined;
      if (!row) {
        fail(res, 404, "NOT_FOUND", "shipment not found in your company");
        return;
      }
    }
    const result = ensureShipmentOrderLinks(db, scopeCompany, shipmentId);
    ok(res, {
      ok: true,
      repairedCount: result.repairedShipmentIds.length,
      repairedShipmentIds: result.repairedShipmentIds,
      skipped: result.skipped,
    });
  });
}
