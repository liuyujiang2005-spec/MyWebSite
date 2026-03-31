import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, parseJsonArray, requireRole } from "../core/http-utils";
import { loadProductImagesForOrders, MAX_ORDER_PRODUCT_IMAGES } from "./product-images";

const COMPLETED = new Set(["delivered", "returned", "cancelled"]);

/**
 * 根据仓库ID返回湘泰运单号前缀。
 */
function warehousePrefix(warehouseId: string): string {
  if (warehouseId === "wh_guangzhou_01") return "GZXT";
  if (warehouseId === "wh_yiwu_01") return "YWXT";
  if (warehouseId === "wh_dongguan_01") return "DGXT";
  return "XT";
}

/**
 * 将日期格式化为 YYYYMMDD。
 */
function toDatePart(dateText: string): string {
  return dateText.replace(/-/g, "").slice(0, 8);
}

/**
 * 按“仓库前缀+日期+3位流水”生成湘泰运单号。
 */
/**
 * 判断员工/管理员是否可编辑该订单仓库维度下的数据。
 */
function staffCanEditOrderWarehouse(
  db: DatabaseSync,
  auth: { userId: string; role: string; companyId: string },
  warehouseId: string,
): boolean {
  if (auth.role === "admin") return true;
  const user = db.prepare("SELECT warehouse_ids FROM users WHERE id = ?").get(auth.userId) as { warehouse_ids: string } | undefined;
  const editableWarehouses = parseJsonArray(user?.warehouse_ids);
  return editableWarehouses.includes(warehouseId);
}

function generateTrackingNo(db: DatabaseSync, warehouseId: string, arrivedAt: string): string {
  const prefix = warehousePrefix(warehouseId);
  const datePart = toDatePart(arrivedAt);
  const base = `${prefix}${datePart}`;
  const row = db
    .prepare(
      `
      SELECT COUNT(1) as count
      FROM shipments
      WHERE tracking_no LIKE ?
      `,
    )
    .get(`${base}%`) as { count: number };
  const seq = String((row?.count ?? 0) + 1).padStart(3, "0");
  return `${base}${seq}`;
}

export function registerOrderRoutes(app: MinimalHttpApp, db: DatabaseSync): void {
  app.post("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      warehouseId?: string;
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      shipDate?: string;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      receiverNameTh?: string;
      receiverPhoneTh?: string;
      receiverAddressTh?: string;
    };

    if (!body.warehouseId?.trim() || !body.itemName || !body.transportMode) {
      fail(res, 400, "BAD_REQUEST", "missing required prealert fields");
      return;
    }

    const now = new Date().toISOString();
    const shipDateText = body.shipDate?.trim() || now.slice(0, 10);
    const shipDate = new Date(`${shipDateText}T00:00:00`);
    if (Number.isNaN(shipDate.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid shipDate");
      return;
    }
    const weightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    const orderId = `o_${Date.now()}`;
    db.prepare(`
      INSERT INTO orders (
        id, company_id, client_id, warehouse_id, batch_no, order_no, approval_status, item_name, product_quantity, package_count, package_unit,
        weight_kg, volume_m3, receivable_amount_cny, receivable_currency, ship_date, domestic_tracking_no, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th,
        status_group, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      auth.companyId,
      auth.userId,
      body.warehouseId.trim(),
      null,
      null,
      "pending",
      body.itemName,
      0,
      Number(body.packageCount ?? 0),
      body.packageUnit ?? "box",
      weightKg,
      volumeM3,
      null,
      "CNY",
      shipDateText,
      body.domesticTrackingNo ?? null,
      body.transportMode,
      body.receiverNameTh?.trim() || "",
      body.receiverPhoneTh?.trim() || "",
      body.receiverAddressTh?.trim() || "",
      "unfinished",
      now,
      now,
    );

    ok(res, { prealertId: orderId, createdAt: now });
  });

  app.post("/staff/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      clientId?: string;
      batchNo?: string;
      trackingNo?: string;
      arrivedAt?: string;
      itemName?: string;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      receiverNameTh?: string;
      receiverPhoneTh?: string;
      receiverAddressTh?: string;
      warehouseId?: string;
    };

    if (
      !body.clientId ||
      !body.itemName ||
      !body.transportMode ||
      !body.warehouseId ||
      !body.arrivedAt?.trim()
    ) {
      fail(res, 400, "BAD_REQUEST", "missing required fields");
      return;
    }

    const arrivedAtDate = new Date(`${body.arrivedAt}T00:00:00`);
    if (Number.isNaN(arrivedAtDate.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid arrivedAt");
      return;
    }

    if (auth.role === "staff") {
      const user = db
        .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
        .get(auth.userId) as { warehouse_ids: string } | undefined;
      const editableWarehouses = parseJsonArray(user?.warehouse_ids);
      if (!editableWarehouses.includes(body.warehouseId)) {
        fail(res, 403, "FORBIDDEN", "cross warehouse create is not allowed");
        return;
      }
    }

    const now = arrivedAtDate.toISOString();
    const orderId = `o_${Date.now()}`;
    const shipmentId = `s_${Date.now()}`;
    const generatedTrackingNo = generateTrackingNo(db, body.warehouseId, body.arrivedAt.trim());
    const weightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    db.prepare(`
      INSERT INTO orders (
        id, company_id, client_id, warehouse_id, batch_no, order_no, approval_status, item_name, product_quantity, package_count, package_unit,
        weight_kg, volume_m3, receivable_amount_cny, receivable_currency, ship_date, domestic_tracking_no, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th,
        status_group, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      auth.companyId,
      body.clientId,
      body.warehouseId,
      body.batchNo?.trim() || null,
      null,
      "approved",
      body.itemName,
      Number(body.productQuantity ?? 0),
      Number(body.packageCount ?? 0),
      body.packageUnit ?? "box",
      weightKg,
      volumeM3,
      null,
      "CNY",
      body.arrivedAt.trim(),
      body.domesticTrackingNo ?? null,
      body.transportMode,
      body.receiverNameTh ?? "",
      body.receiverPhoneTh ?? "",
      body.receiverAddressTh ?? "",
      "unfinished",
      now,
      now,
    );

    db.prepare(`
      INSERT INTO shipments (
        id, company_id, order_id, tracking_no, batch_no, current_status, current_location, weight_kg, volume_m3,
        package_count, package_unit, transport_mode, domestic_tracking_no, warehouse_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      shipmentId,
      auth.companyId,
      orderId,
      generatedTrackingNo,
      body.batchNo?.trim() || null,
      "created",
      null,
      weightKg,
      volumeM3,
      Number(body.packageCount ?? 0),
      body.packageUnit ?? "box",
      body.transportMode,
      body.domesticTrackingNo ?? null,
      body.warehouseId,
      now,
      now,
    );

    ok(res, { orderId, createdAt: now });
  });

  app.post("/staff/orders/set-receivable", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      orderId?: string;
      receivableAmountCny?: number;
      receivableCurrency?: "CNY" | "THB";
    };
    const orderId = body.orderId?.trim();
    const amount = body.receivableAmountCny === undefined ? NaN : Number(body.receivableAmountCny);
    const currency = body.receivableCurrency === "THB" ? "THB" : "CNY";

    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      fail(res, 400, "BAD_REQUEST", "receivableAmountCny must be greater than 0");
      return;
    }

    const order = db
      .prepare("SELECT id, warehouse_id FROM orders WHERE id = ? AND company_id = ?")
      .get(orderId, auth.companyId) as { id: string; warehouse_id: string } | undefined;
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }

    if (auth.role === "staff") {
      const user = db
        .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
        .get(auth.userId) as { warehouse_ids: string } | undefined;
      const editableWarehouses = parseJsonArray(user?.warehouse_ids);
      if (!editableWarehouses.includes(order.warehouse_id)) {
        fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
        return;
      }
    }

    const now = new Date().toISOString();
    db.prepare(
      `
      UPDATE orders
      SET receivable_amount_cny = ?, receivable_currency = ?, updated_at = ?
      WHERE id = ? AND company_id = ?
      `,
    ).run(amount, currency, now, orderId, auth.companyId);

    ok(res, { orderId, receivableAmountCny: amount, receivableCurrency: currency, updatedAt: now });
  });

  app.post("/staff/orders/set-payment", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      orderId?: string;
      paymentStatus?: "paid" | "unpaid";
      proofFileName?: string;
      proofMime?: string;
      proofBase64?: string;
    };
    const orderId = body.orderId?.trim();
    const paymentStatus = body.paymentStatus === "paid" ? "paid" : body.paymentStatus === "unpaid" ? "unpaid" : null;
    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }
    if (!paymentStatus) {
      fail(res, 400, "BAD_REQUEST", "paymentStatus must be 'paid' or 'unpaid'");
      return;
    }

    const order = db
      .prepare("SELECT id, warehouse_id FROM orders WHERE id = ? AND company_id = ?")
      .get(orderId, auth.companyId) as { id: string; warehouse_id: string } | undefined;
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }

    if (auth.role === "staff") {
      const user = db
        .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
        .get(auth.userId) as { warehouse_ids: string } | undefined;
      const editableWarehouses = parseJsonArray(user?.warehouse_ids);
      if (!editableWarehouses.includes(order.warehouse_id)) {
        fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
        return;
      }
    }

    const now = new Date().toISOString();
    if (paymentStatus === "paid") {
      const proofFileName = typeof body.proofFileName === "string" ? body.proofFileName.trim() : "";
      const proofMime = typeof body.proofMime === "string" ? body.proofMime.trim() : "";
      const proofBase64 = typeof body.proofBase64 === "string" ? body.proofBase64.trim() : "";
      if (!proofFileName || !proofMime || !proofBase64) {
        fail(res, 400, "BAD_REQUEST", "payment proof is required when marking as paid");
        return;
      }
      // Basic size guard to avoid storing extremely large blobs in SQLite.
      // base64 expands ~4/3, so 4MB base64 ~= 3MB binary.
      if (proofBase64.length > 4_000_000) {
        fail(res, 400, "BAD_REQUEST", "payment proof is too large (max 4MB base64)");
        return;
      }
      try {
        const buf = Buffer.from(proofBase64, "base64");
        if (buf.length === 0) {
          fail(res, 400, "BAD_REQUEST", "invalid payment proof");
          return;
        }
      } catch {
        fail(res, 400, "BAD_REQUEST", "invalid payment proof");
        return;
      }
      db.prepare(
        `
        UPDATE orders
        SET payment_status = 'paid',
            paid_at = ?,
            paid_by = ?,
            payment_proof_file_name = ?,
            payment_proof_mime = ?,
            payment_proof_base64 = ?,
            payment_proof_uploaded_at = ?,
            updated_at = ?
        WHERE id = ? AND company_id = ?
        `,
      ).run(now, auth.userId, proofFileName, proofMime, proofBase64, now, now, orderId, auth.companyId);
      ok(res, { orderId, paymentStatus: "paid", paidAt: now, paidBy: auth.userId, updatedAt: now });
      return;
    }

    db.prepare(
      `
      UPDATE orders
      SET payment_status = 'unpaid',
          paid_at = NULL,
          paid_by = NULL,
          payment_proof_file_name = NULL,
          payment_proof_mime = NULL,
          payment_proof_base64 = NULL,
          payment_proof_uploaded_at = NULL,
          updated_at = ?
      WHERE id = ? AND company_id = ?
      `,
    ).run(now, orderId, auth.companyId);
    ok(res, { orderId, paymentStatus: "unpaid", paidAt: null, paidBy: null, updatedAt: now });
  });

  app.get("/client/orders", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const statusGroup = req.query.statusGroup?.trim();
    const itemName = req.query.itemName?.trim();
    const transportMode = req.query.transportMode?.trim();
    const trackingNo = req.query.trackingNo?.trim();
    const orderNo = req.query.orderNo?.trim();
    const domesticTrackingNo = req.query.domesticTrackingNo?.trim();

    const rows = db
      .prepare(`
        SELECT
          o.id, o.client_id, o.warehouse_id, o.order_no, o.item_name, o.transport_mode, o.domestic_tracking_no,
          o.batch_no, o.approval_status,
          o.product_quantity, o.package_count, o.package_unit, o.weight_kg, o.volume_m3,
          o.receivable_amount_cny, o.receivable_currency,
          o.payment_status, o.paid_at, o.paid_by,
          o.ship_date, o.created_at, o.updated_at,
          s.tracking_no, s.current_status,
          (
            SELECT sl.remark
            FROM status_logs sl
            JOIN shipments sx ON sx.id = sl.shipment_id
            WHERE sx.order_id = o.id AND sl.company_id = o.company_id AND sl.remark IS NOT NULL AND sl.remark != ''
            ORDER BY sl.changed_at DESC
            LIMIT 1
          ) as latest_remark
        FROM orders o
        LEFT JOIN shipments s ON s.order_id = o.id
        WHERE o.company_id = ? AND o.approval_status = 'approved'
        ORDER BY o.created_at ASC
      `)
      .all(auth.companyId) as Array<{
      id: string;
      client_id: string;
      warehouse_id: string;
      order_no: string | null;
      item_name: string;
      transport_mode: string;
      domestic_tracking_no: string | null;
      batch_no: string | null;
      approval_status: string;
      product_quantity: number;
      package_count: number;
      package_unit: string;
      weight_kg: number | null;
      volume_m3: number | null;
      ship_date: string | null;
      created_at: string;
      updated_at: string;
      receivable_amount_cny: number | null;
      receivable_currency: string | null;
      payment_status: string | null;
      paid_at: string | null;
      paid_by: string | null;
      tracking_no: string | null;
      current_status: string | null;
      latest_remark: string | null;
    }>;

    const filtered = rows
      .filter((row) => row.client_id === auth.userId)
      .filter((row) => !itemName || row.item_name.includes(itemName))
      .filter((row) => !transportMode || row.transport_mode === transportMode)
      .filter((row) => !trackingNo || row.tracking_no === trackingNo)
      .filter((row) => !orderNo || row.order_no === orderNo)
      .filter((row) => !domesticTrackingNo || row.domestic_tracking_no === domesticTrackingNo)
      .filter((row) => {
        const completed = row.current_status ? COMPLETED.has(row.current_status) : false;
        if (statusGroup === "completed") return completed;
        if (statusGroup === "unfinished") return !completed;
        return true;
      });

    const historyStmt = db.prepare(`
      SELECT sl.remark, sl.changed_at, sl.from_status, sl.to_status
      FROM status_logs sl
      JOIN shipments s ON s.id = sl.shipment_id
      WHERE s.order_id = ? AND sl.company_id = ? AND sl.remark IS NOT NULL AND sl.remark != ''
      ORDER BY sl.changed_at ASC
    `);

    const items = filtered.map((row) => {
      const logisticsRecords = historyStmt.all(row.id, auth.companyId) as Array<{
        remark: string;
        changed_at: string;
        from_status: string;
        to_status: string;
      }>;
      return {
        id: row.id,
        warehouseId: row.warehouse_id,
        orderNo: row.order_no,
        itemName: row.item_name,
        transportMode: row.transport_mode,
        domesticTrackingNo: row.domestic_tracking_no,
        batchNo: row.batch_no,
        approvalStatus: row.approval_status,
        trackingNo: row.tracking_no,
        currentStatus: row.current_status,
        productQuantity: row.product_quantity,
        packageCount: row.package_count,
        packageUnit: row.package_unit,
        weightKg: row.weight_kg,
        volumeM3: row.volume_m3,
        receivableAmountCny: row.receivable_amount_cny,
        receivableCurrency: row.receivable_currency ?? "CNY",
        paymentStatus: row.payment_status ?? "unpaid",
        paidAt: row.paid_at ?? undefined,
        paidBy: row.paid_by ?? undefined,
        shipDate: row.ship_date,
        latestRemark: logisticsRecords.at(-1)?.remark ?? row.latest_remark,
        logisticsRecords: logisticsRecords.map((record) => ({
          remark: record.remark,
          changedAt: record.changed_at,
          fromStatus: record.from_status,
          toStatus: record.to_status,
        })),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    const orderIds = items.map((item) => item.id);
    const imageMap = loadProductImagesForOrders(db, auth.companyId, orderIds);
    const itemsWithImages = items.map((item) => ({
      ...item,
      productImages: imageMap.get(item.id) ?? [],
    }));

    ok(res, {
      items: itemsWithImages,
      page: 1,
      pageSize: itemsWithImages.length,
      total: itemsWithImages.length,
    });
  });

  app.get("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const rows = db
      .prepare(`
        SELECT
          id, client_id, warehouse_id, order_no, item_name, transport_mode, domestic_tracking_no, batch_no, approval_status,
          product_quantity, package_count, package_unit, weight_kg, volume_m3, receivable_amount_cny, receivable_currency,
          payment_status, paid_at, paid_by,
          ship_date, created_at, updated_at
        FROM orders
        WHERE company_id = ? AND approval_status = 'pending'
        ORDER BY created_at DESC
      `)
      .all(auth.companyId) as Array<{
      id: string;
      client_id: string;
      warehouse_id: string;
      order_no: string | null;
      item_name: string;
      transport_mode: string;
      domestic_tracking_no: string | null;
      batch_no: string | null;
      approval_status: string;
      product_quantity: number;
      package_count: number;
      package_unit: string;
      weight_kg: number | null;
      volume_m3: number | null;
      receivable_amount_cny: number | null;
      receivable_currency: string | null;
      payment_status: string | null;
      paid_at: string | null;
      paid_by: string | null;
      ship_date: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const items = rows
      .filter((row) => row.client_id === auth.userId)
      .map((row) => ({
        id: row.id,
        warehouseId: row.warehouse_id,
        orderNo: row.order_no,
        itemName: row.item_name,
        transportMode: row.transport_mode,
        domesticTrackingNo: row.domestic_tracking_no,
        batchNo: row.batch_no,
        approvalStatus: row.approval_status,
        productQuantity: row.product_quantity,
        packageCount: row.package_count,
        packageUnit: row.package_unit,
        weightKg: row.weight_kg,
        volumeM3: row.volume_m3,
        receivableAmountCny: row.receivable_amount_cny,
        receivableCurrency: row.receivable_currency ?? "CNY",
        paymentStatus: row.payment_status ?? "unpaid",
        paidAt: row.paid_at ?? undefined,
        paidBy: row.paid_by ?? undefined,
        shipDate: row.ship_date,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    const prealertIds = items.map((item) => item.id);
    const prealertImageMap = loadProductImagesForOrders(db, auth.companyId, prealertIds);
    const prealertItemsWithImages = items.map((item) => ({
      ...item,
      productImages: prealertImageMap.get(item.id) ?? [],
    }));
    ok(res, { items: prealertItemsWithImages, page: 1, pageSize: prealertItemsWithImages.length, total: prealertItemsWithImages.length });
  });

  app.get("/staff/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const user = db
      .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
      .get(auth.userId) as { warehouse_ids: string } | undefined;
    const editableWarehouses = parseJsonArray(user?.warehouse_ids);

    const rows = db
      .prepare(`
        SELECT
          o.id, o.client_id, u.name as client_name, o.warehouse_id, o.order_no, o.item_name, o.transport_mode, o.domestic_tracking_no, o.batch_no, o.approval_status,
          o.product_quantity, o.package_count, o.package_unit, o.weight_kg, o.volume_m3, o.receivable_amount_cny, o.receivable_currency,
          o.payment_status, o.paid_at, o.paid_by,
          o.ship_date, o.created_at, o.updated_at
        FROM orders o
        LEFT JOIN users u ON u.id = o.client_id
        WHERE o.company_id = ? AND o.approval_status = 'pending'
        ORDER BY o.created_at DESC
      `)
      .all(auth.companyId) as Array<{
      id: string;
      client_id: string;
      client_name: string | null;
      warehouse_id: string;
      order_no: string | null;
      item_name: string;
      transport_mode: string;
      domestic_tracking_no: string | null;
      batch_no: string | null;
      approval_status: string;
      product_quantity: number;
      package_count: number;
      package_unit: string;
      weight_kg: number | null;
      volume_m3: number | null;
      receivable_amount_cny: number | null;
      receivable_currency: string | null;
      payment_status: string | null;
      paid_at: string | null;
      paid_by: string | null;
      ship_date: string | null;
      created_at: string;
      updated_at: string;
    }>;

    const items = rows
      .filter((row) => auth.role === "admin" || editableWarehouses.includes(row.warehouse_id))
      .map((row) => ({
        id: row.id,
        clientId: row.client_id,
        clientName: row.client_name,
        warehouseId: row.warehouse_id,
        orderNo: row.order_no,
        itemName: row.item_name,
        transportMode: row.transport_mode,
        domesticTrackingNo: row.domestic_tracking_no,
        batchNo: row.batch_no,
        approvalStatus: row.approval_status,
        productQuantity: row.product_quantity,
        packageCount: row.package_count,
        packageUnit: row.package_unit,
        weightKg: row.weight_kg,
        volumeM3: row.volume_m3,
        receivableAmountCny: row.receivable_amount_cny,
        receivableCurrency: row.receivable_currency ?? "CNY",
        paymentStatus: row.payment_status ?? "unpaid",
        paidAt: row.paid_at ?? undefined,
        paidBy: row.paid_by ?? undefined,
        shipDate: row.ship_date,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    const staffPrealertIds = items.map((item) => item.id);
    const staffPrealertImageMap = loadProductImagesForOrders(db, auth.companyId, staffPrealertIds);
    const staffPrealertItemsWithImages = items.map((item) => ({
      ...item,
      productImages: staffPrealertImageMap.get(item.id) ?? [],
    }));
    ok(res, {
      items: staffPrealertItemsWithImages,
      page: 1,
      pageSize: staffPrealertItemsWithImages.length,
      total: staffPrealertItemsWithImages.length,
    });
  });

  app.post("/staff/orders/product-images", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      orderId?: string;
      fileName?: string;
      mime?: string;
      contentBase64?: string;
    };
    const orderId = body.orderId?.trim();
    const fileName = body.fileName?.trim();
    const mimeType = body.mime?.trim();
    const contentBase64 = body.contentBase64?.trim();
    if (!orderId || !fileName || !mimeType || !contentBase64) {
      fail(res, 400, "BAD_REQUEST", "orderId, fileName, mime and contentBase64 are required");
      return;
    }
    if (!mimeType.startsWith("image/")) {
      fail(res, 400, "BAD_REQUEST", "only image uploads are allowed");
      return;
    }
    if (contentBase64.length > 4_000_000) {
      fail(res, 400, "BAD_REQUEST", "file too large (max 4MB base64)");
      return;
    }
    const order = db
      .prepare("SELECT id, warehouse_id, approval_status FROM orders WHERE id = ? AND company_id = ?")
      .get(orderId, auth.companyId) as { id: string; warehouse_id: string; approval_status: string } | undefined;
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }
    if (auth.role === "staff" && order.approval_status !== "pending") {
      fail(res, 403, "FORBIDDEN", "staff can only manage product images for pending prealerts");
      return;
    }
    if (!staffCanEditOrderWarehouse(db, auth, order.warehouse_id)) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }
    const countRow = db
      .prepare("SELECT COUNT(1) as c FROM order_product_images WHERE company_id = ? AND order_id = ?")
      .get(auth.companyId, orderId) as { c: number };
    if ((countRow?.c ?? 0) >= MAX_ORDER_PRODUCT_IMAGES) {
      fail(res, 400, "BAD_REQUEST", `maximum ${MAX_ORDER_PRODUCT_IMAGES} product images per order`);
      return;
    }
    try {
      const buf = Buffer.from(contentBase64, "base64");
      if (buf.length === 0) {
        fail(res, 400, "BAD_REQUEST", "invalid image content");
        return;
      }
    } catch {
      fail(res, 400, "BAD_REQUEST", "invalid image content");
      return;
    }
    const now = new Date().toISOString();
    const imageId = `opi_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    db.prepare(
      `
      INSERT INTO order_product_images (
        id, company_id, order_id, file_name, mime, content_base64, uploaded_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(imageId, auth.companyId, orderId, fileName, mimeType, contentBase64, auth.userId, now);
    ok(res, { id: imageId, orderId, fileName, mime: mimeType, createdAt: now });
  });

  app.delete("/staff/orders/product-images", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }
    const row = db
      .prepare(
        `
        SELECT i.id, o.warehouse_id, o.approval_status
        FROM order_product_images i
        JOIN orders o ON o.id = i.order_id AND o.company_id = i.company_id
        WHERE i.id = ? AND i.company_id = ?
        `,
      )
      .get(id, auth.companyId) as { id: string; warehouse_id: string; approval_status: string } | undefined;
    if (!row) {
      fail(res, 404, "NOT_FOUND", "image not found");
      return;
    }
    if (auth.role === "staff" && row.approval_status !== "pending") {
      fail(res, 403, "FORBIDDEN", "staff can only manage product images for pending prealerts");
      return;
    }
    if (!staffCanEditOrderWarehouse(db, auth, row.warehouse_id)) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }
    const result = db.prepare("DELETE FROM order_product_images WHERE id = ? AND company_id = ?").run(id, auth.companyId);
    ok(res, { deleted: result.changes > 0, id });
  });

  /**
   * 员工按运单维度一次性更新关联订单与运单的基础信息（与列表「订单详情」编辑一致）。
   */
  app.post("/staff/orders/patch-shipment-bundle", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      shipmentId?: string;
      trackingNo?: string;
      batchNo?: string | null;
      itemName?: string;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number | null;
      volumeM3?: number | null;
      domesticTrackingNo?: string | null;
      orderCreatedDate?: string;
      transportMode?: "sea" | "land";
      shipDate?: string | null;
      receiverAddressTh?: string;
      containerNo?: string | null;
      receivableAmountCny?: number | null;
      receivableCurrency?: "CNY" | "THB";
      /** 同步更新订单与运单的归属仓库（员工须对新仓库有编辑权限）。 */
      warehouseId?: string;
    };

    const shipmentId = body.shipmentId?.trim();
    if (!shipmentId) {
      fail(res, 400, "BAD_REQUEST", "shipmentId is required");
      return;
    }

    const row = db
      .prepare(
        `
        SELECT s.id AS sid, s.tracking_no, s.order_id, o.id AS oid, o.warehouse_id AS order_wh
        FROM shipments s
        INNER JOIN orders o ON o.id = s.order_id
        WHERE s.id = ? AND s.company_id = ? AND o.company_id = ?
        `,
      )
      .get(shipmentId, auth.companyId, auth.companyId) as
      | {
          sid: string;
          tracking_no: string;
          order_id: string;
          oid: string;
          order_wh: string;
        }
      | undefined;

    if (!row) {
      fail(res, 404, "NOT_FOUND", "shipment or order not found");
      return;
    }

    if (!staffCanEditOrderWarehouse(db, auth, row.order_wh)) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }

    let nextWarehouseId = row.order_wh;
    if (body.warehouseId !== undefined && body.warehouseId !== null && String(body.warehouseId).trim() !== "") {
      const nw = String(body.warehouseId).trim();
      if (!staffCanEditOrderWarehouse(db, auth, nw)) {
        fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
        return;
      }
      nextWarehouseId = nw;
    }

    const curOrder = db
      .prepare("SELECT receivable_amount_cny, receivable_currency FROM orders WHERE id = ? AND company_id = ?")
      .get(row.oid, auth.companyId) as { receivable_amount_cny: number | null; receivable_currency: string } | undefined;
    if (!curOrder) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }

    const trackingNo = typeof body.trackingNo === "string" ? body.trackingNo.trim() : "";
    if (!trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
      return;
    }
    if (trackingNo !== row.tracking_no) {
      const clash = db
        .prepare("SELECT id FROM shipments WHERE company_id = ? AND tracking_no = ? AND id != ?")
        .get(auth.companyId, trackingNo, shipmentId) as { id: string } | undefined;
      if (clash) {
        fail(res, 400, "BAD_REQUEST", "trackingNo already exists");
        return;
      }
    }

    const itemName = body.itemName?.trim();
    if (!itemName) {
      fail(res, 400, "BAD_REQUEST", "itemName is required");
      return;
    }

    const productQuantity = Number(body.productQuantity);
    const packageCount = Number(body.packageCount);
    if (!Number.isFinite(productQuantity) || productQuantity < 0) {
      fail(res, 400, "BAD_REQUEST", "invalid productQuantity");
      return;
    }
    if (!Number.isFinite(packageCount) || packageCount < 0) {
      fail(res, 400, "BAD_REQUEST", "invalid packageCount");
      return;
    }

    const packageUnit = body.packageUnit === "bag" ? "bag" : "box";
    const weightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    if (weightKg !== null && !Number.isFinite(weightKg)) {
      fail(res, 400, "BAD_REQUEST", "invalid weightKg");
      return;
    }
    if (volumeM3 !== null && !Number.isFinite(volumeM3)) {
      fail(res, 400, "BAD_REQUEST", "invalid volumeM3");
      return;
    }

    const orderCreatedDate = body.orderCreatedDate?.trim();
    if (!orderCreatedDate) {
      fail(res, 400, "BAD_REQUEST", "orderCreatedDate is required");
      return;
    }
    const arrived = new Date(`${orderCreatedDate}T00:00:00.000Z`);
    if (Number.isNaN(arrived.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid orderCreatedDate");
      return;
    }
    const createdAtIso = arrived.toISOString();

    const transportMode = body.transportMode === "land" ? "land" : "sea";

    let shipDate: string | null = null;
    if (body.shipDate !== undefined && body.shipDate !== null && String(body.shipDate).trim() !== "") {
      const raw = String(body.shipDate).trim().slice(0, 10);
      const sd = new Date(`${raw}T00:00:00.000Z`);
      if (Number.isNaN(sd.getTime())) {
        fail(res, 400, "BAD_REQUEST", "invalid shipDate");
        return;
      }
      shipDate = raw;
    }

    let receivableAmount: number | null = curOrder.receivable_amount_cny;
    let currency: "CNY" | "THB" = curOrder.receivable_currency === "THB" ? "THB" : "CNY";
    if (body.receivableAmountCny !== undefined && body.receivableAmountCny !== null) {
      const amt = Number(body.receivableAmountCny);
      if (!Number.isFinite(amt) || amt < 0) {
        fail(res, 400, "BAD_REQUEST", "invalid receivableAmountCny");
        return;
      }
      receivableAmount = amt === 0 ? null : amt;
    }
    if (body.receivableCurrency === "THB" || body.receivableCurrency === "CNY") {
      currency = body.receivableCurrency;
    }

    const batchNo = body.batchNo?.trim() || null;
    const domesticTrackingNo = body.domesticTrackingNo?.trim() || null;
    const receiverAddressTh = body.receiverAddressTh?.trim() ?? "";
    const containerNo = body.containerNo?.trim() || null;

    const now = new Date().toISOString();

    db.prepare(
      `
      UPDATE orders SET
        warehouse_id = ?,
        batch_no = ?,
        item_name = ?,
        product_quantity = ?,
        package_count = ?,
        package_unit = ?,
        weight_kg = ?,
        volume_m3 = ?,
        domestic_tracking_no = ?,
        transport_mode = ?,
        ship_date = ?,
        receiver_address_th = ?,
        receivable_amount_cny = ?,
        receivable_currency = ?,
        created_at = ?,
        updated_at = ?
      WHERE id = ? AND company_id = ?
      `,
    ).run(
      nextWarehouseId,
      batchNo,
      itemName,
      Math.floor(productQuantity),
      Math.floor(packageCount),
      packageUnit,
      weightKg,
      volumeM3,
      domesticTrackingNo,
      transportMode,
      shipDate,
      receiverAddressTh,
      receivableAmount,
      currency,
      createdAtIso,
      now,
      row.oid,
      auth.companyId,
    );

    db.prepare(
      `
      UPDATE shipments SET
        warehouse_id = ?,
        tracking_no = ?,
        batch_no = ?,
        domestic_tracking_no = ?,
        package_count = ?,
        package_unit = ?,
        weight_kg = ?,
        volume_m3 = ?,
        transport_mode = ?,
        container_no = ?,
        updated_at = ?
      WHERE id = ? AND company_id = ?
      `,
    ).run(
      nextWarehouseId,
      trackingNo,
      batchNo,
      domesticTrackingNo,
      Math.floor(packageCount),
      packageUnit,
      weightKg,
      volumeM3,
      transportMode,
      containerNo,
      now,
      shipmentId,
      auth.companyId,
    );

    ok(res, {
      shipmentId,
      orderId: row.oid,
      updatedAt: now,
    });
  });

  app.post("/staff/prealerts/approve", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      orderId?: string;
      batchNo?: string;
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      productQuantity?: number;
      weightKg?: number;
      volumeM3?: number;
      receivableAmountCny?: number;
      receivableCurrency?: "CNY" | "THB";
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      shipDate?: string;
    };
    if (!body.orderId || !body.batchNo?.trim()) {
      fail(res, 400, "BAD_REQUEST", "orderId and batchNo are required");
      return;
    }

    const order = db
      .prepare(`
        SELECT
          id, warehouse_id, approval_status, item_name, product_quantity, package_count, package_unit,
          weight_kg, volume_m3, domestic_tracking_no, transport_mode, ship_date
        FROM orders
        WHERE id = ? AND company_id = ?
      `)
      .get(body.orderId, auth.companyId) as
      | {
          id: string;
          warehouse_id: string;
          approval_status: string;
          item_name: string;
          product_quantity: number;
          package_count: number;
          package_unit: string;
          weight_kg: number | null;
          volume_m3: number | null;
          domestic_tracking_no: string | null;
          transport_mode: string;
          ship_date: string | null;
        }
      | undefined;
    if (!order) {
      fail(res, 404, "NOT_FOUND", "prealert order not found");
      return;
    }
    if (order.approval_status !== "pending") {
      fail(res, 400, "VALIDATION_ERROR", "order is not pending");
      return;
    }

    if (auth.role === "staff") {
      const user = db
        .prepare("SELECT warehouse_ids FROM users WHERE id = ?")
        .get(auth.userId) as { warehouse_ids: string } | undefined;
      const editableWarehouses = parseJsonArray(user?.warehouse_ids);
      if (!editableWarehouses.includes(order.warehouse_id)) {
        fail(res, 403, "FORBIDDEN", "cross warehouse approve is not allowed");
        return;
      }
    }

    const now = new Date().toISOString();
    const batchNo = body.batchNo.trim();
    const itemName = body.itemName?.trim() || order.item_name;
    const packageCount = body.packageCount === undefined ? order.package_count : Number(body.packageCount);
    const productQuantity = body.productQuantity === undefined ? order.product_quantity : Number(body.productQuantity);
    const packageUnit = body.packageUnit ?? (order.package_unit as "bag" | "box");
    const weightKg = body.weightKg === undefined ? order.weight_kg : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined ? order.volume_m3 : Number(body.volumeM3);
    const receivableAmountCny = body.receivableAmountCny === undefined ? null : Number(body.receivableAmountCny);
    const receivableCurrency = body.receivableCurrency === "THB" ? "THB" : "CNY";
    const domesticTrackingNo =
      body.domesticTrackingNo === undefined ? order.domestic_tracking_no : body.domesticTrackingNo.trim() || null;
    const transportMode = body.transportMode ?? (order.transport_mode as "sea" | "land");
    const shipDate = body.shipDate === undefined ? (order.ship_date ?? now.slice(0, 10)) : body.shipDate.trim();

    if (
      Number.isNaN(packageCount) ||
      Number.isNaN(productQuantity) ||
      (weightKg !== null && Number.isNaN(weightKg)) ||
      (volumeM3 !== null && Number.isNaN(volumeM3)) ||
      (receivableAmountCny !== null && Number.isNaN(receivableAmountCny))
    ) {
      fail(res, 400, "BAD_REQUEST", "invalid numeric fields");
      return;
    }
    if (receivableAmountCny === null || receivableAmountCny <= 0) {
      fail(res, 400, "BAD_REQUEST", "receivableAmountCny must be greater than 0");
      return;
    }
    if (packageUnit !== "bag" && packageUnit !== "box") {
      fail(res, 400, "BAD_REQUEST", "invalid packageUnit");
      return;
    }
    if (transportMode !== "sea" && transportMode !== "land") {
      fail(res, 400, "BAD_REQUEST", "invalid transportMode");
      return;
    }
    if (!shipDate) {
      fail(res, 400, "BAD_REQUEST", "shipDate is required");
      return;
    }
    const shipDateParsed = new Date(`${shipDate}T00:00:00`);
    if (Number.isNaN(shipDateParsed.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid shipDate");
      return;
    }

    db.prepare(`
      UPDATE orders
      SET
        approval_status = 'approved',
        batch_no = ?,
        item_name = ?,
        product_quantity = ?,
        package_count = ?,
        package_unit = ?,
        weight_kg = ?,
        volume_m3 = ?,
        receivable_amount_cny = ?,
        receivable_currency = ?,
        ship_date = ?,
        domestic_tracking_no = ?,
        transport_mode = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      batchNo,
      itemName,
      productQuantity,
      packageCount,
      packageUnit,
      weightKg,
      volumeM3,
      receivableAmountCny,
      receivableCurrency,
      shipDate,
      domesticTrackingNo,
      transportMode,
      now,
      order.id,
    );

    const existingShipment = db
      .prepare("SELECT id FROM shipments WHERE order_id = ? AND company_id = ? LIMIT 1")
      .get(order.id, auth.companyId) as { id: string } | undefined;
    if (!existingShipment) {
      const shipmentId = `s_${Date.now()}`;
      const generatedTrackingNo = `AUTO_${order.id}`;
      db.prepare(`
        INSERT INTO shipments (
          id, company_id, order_id, tracking_no, batch_no, current_status, current_location,
          weight_kg, volume_m3, package_count, package_unit, transport_mode, domestic_tracking_no,
          warehouse_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        shipmentId,
        auth.companyId,
        order.id,
        generatedTrackingNo,
        batchNo,
        "created",
        null,
        weightKg,
        volumeM3,
        packageCount,
        packageUnit,
        transportMode,
        domesticTrackingNo,
        order.warehouse_id,
        now,
        now,
      );
    }
    ok(res, { orderId: order.id, batchNo, approvalStatus: "approved", approvedAt: now });
  });
}
