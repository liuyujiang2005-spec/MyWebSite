import type { DatabaseSync } from "node:sqlite";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

/**
 * 注册管理员运营侧（LMP/关务/末端/结算）接口。
 */
export function registerAdminOpsRoutes(app: MinimalHttpApp, db: DatabaseSync): void {
  app.get("/admin/lmp/rates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = db
      .prepare(
        `
        SELECT id, route_code, supplier_name, transport_mode, season_tag,
               supplier_cost, quote_price, currency, effective_from, effective_to, updated_at
        FROM admin_lmp_rates
        WHERE company_id = ?
        ORDER BY updated_at DESC
        `,
      )
      .all(auth.companyId) as Array<{
      id: string;
      route_code: string;
      supplier_name: string;
      transport_mode: string;
      season_tag: string;
      supplier_cost: number;
      quote_price: number;
      currency: string;
      effective_from: string;
      effective_to: string | null;
      updated_at: string;
    }>;
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        routeCode: item.route_code,
        supplierName: item.supplier_name,
        transportMode: item.transport_mode,
        seasonTag: item.season_tag,
        supplierCost: item.supplier_cost,
        quotePrice: item.quote_price,
        currency: item.currency,
        effectiveFrom: item.effective_from,
        effectiveTo: item.effective_to ?? undefined,
        updatedAt: item.updated_at,
      })),
    });
  });

  app.post("/admin/lmp/rates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      routeCode?: string;
      supplierName?: string;
      transportMode?: string;
      seasonTag?: string;
      supplierCost?: number;
      quotePrice?: number;
      currency?: string;
      effectiveFrom?: string;
      effectiveTo?: string;
    };
    const routeCode = body.routeCode?.trim();
    const supplierName = body.supplierName?.trim();
    const transportMode = body.transportMode?.trim();
    const seasonTag = body.seasonTag?.trim();
    const supplierCost = Number(body.supplierCost);
    const quotePrice = Number(body.quotePrice);
    if (!routeCode || !supplierName || !transportMode || !seasonTag || !Number.isFinite(supplierCost) || !Number.isFinite(quotePrice)) {
      fail(res, 400, "BAD_REQUEST", "invalid lmp rate payload");
      return;
    }
    const now = new Date().toISOString();
    const id = `lmp_${Date.now()}`;
    db.prepare(
      `
      INSERT INTO admin_lmp_rates (
        id, company_id, route_code, supplier_name, transport_mode, season_tag,
        supplier_cost, quote_price, currency, effective_from, effective_to, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      id,
      auth.companyId,
      routeCode,
      supplierName,
      transportMode,
      seasonTag,
      supplierCost,
      quotePrice,
      body.currency?.trim() || "CNY",
      body.effectiveFrom?.trim() || now.slice(0, 10),
      body.effectiveTo?.trim() || null,
      now,
    );
    ok(res, { id, updatedAt: now });
  });

  app.get("/admin/customs/cases", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = db
      .prepare(
        `
        SELECT id, shipment_id, order_id, status, remark, updated_at
        FROM admin_customs_cases
        WHERE company_id = ?
        ORDER BY updated_at DESC
        `,
      )
      .all(auth.companyId) as Array<{
      id: string;
      shipment_id: string | null;
      order_id: string | null;
      status: string;
      remark: string | null;
      updated_at: string;
    }>;
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        shipmentId: item.shipment_id ?? undefined,
        orderId: item.order_id ?? undefined,
        status: item.status,
        remark: item.remark ?? undefined,
        updatedAt: item.updated_at,
      })),
    });
  });

  app.post("/admin/customs/cases", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentId?: string; orderId?: string; status?: string; remark?: string };
    const status = body.status?.trim();
    if (!status) {
      fail(res, 400, "BAD_REQUEST", "status is required");
      return;
    }
    const id = `cus_${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO admin_customs_cases (
        id, company_id, shipment_id, order_id, status, remark, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(id, auth.companyId, body.shipmentId?.trim() || null, body.orderId?.trim() || null, status, body.remark?.trim() || null, now);
    ok(res, { id, updatedAt: now });
  });

  app.get("/admin/lastmile/orders", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = db
      .prepare(
        `
        SELECT id, shipment_id, carrier_name, external_tracking_no, status, updated_at
        FROM admin_lastmile_orders
        WHERE company_id = ?
        ORDER BY updated_at DESC
        `,
      )
      .all(auth.companyId) as Array<{
      id: string;
      shipment_id: string;
      carrier_name: string;
      external_tracking_no: string;
      status: string;
      updated_at: string;
    }>;
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        shipmentId: item.shipment_id,
        carrierName: item.carrier_name,
        externalTrackingNo: item.external_tracking_no,
        status: item.status,
        updatedAt: item.updated_at,
      })),
    });
  });

  app.post("/admin/lastmile/orders", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentId?: string; carrierName?: string; externalTrackingNo?: string; status?: string };
    const shipmentId = body.shipmentId?.trim();
    const carrierName = body.carrierName?.trim();
    const externalTrackingNo = body.externalTrackingNo?.trim();
    const status = body.status?.trim() || "created";
    if (!shipmentId || !carrierName || !externalTrackingNo) {
      fail(res, 400, "BAD_REQUEST", "shipmentId, carrierName, externalTrackingNo are required");
      return;
    }
    const id = `lm_${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO admin_lastmile_orders (
        id, company_id, shipment_id, carrier_name, external_tracking_no, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(id, auth.companyId, shipmentId, carrierName, externalTrackingNo, status, now);
    ok(res, { id, updatedAt: now });
  });

  app.get("/admin/settlement/entries", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = db
      .prepare(
        `
        SELECT id, order_id, client_receivable, supplier_payable, tax_fee, currency, updated_at
        FROM admin_settlement_entries
        WHERE company_id = ?
        ORDER BY updated_at DESC
        `,
      )
      .all(auth.companyId) as Array<{
      id: string;
      order_id: string;
      client_receivable: number;
      supplier_payable: number;
      tax_fee: number;
      currency: string;
      updated_at: string;
    }>;
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        orderId: item.order_id,
        clientReceivable: item.client_receivable,
        supplierPayable: item.supplier_payable,
        taxFee: item.tax_fee,
        currency: item.currency,
        updatedAt: item.updated_at,
      })),
    });
  });

  app.post("/admin/settlement/entries", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      orderId?: string;
      clientReceivable?: number;
      supplierPayable?: number;
      taxFee?: number;
      currency?: string;
    };
    const orderId = body.orderId?.trim();
    const clientReceivable = Number(body.clientReceivable);
    const supplierPayable = Number(body.supplierPayable);
    const taxFee = Number(body.taxFee);
    if (!orderId || !Number.isFinite(clientReceivable) || !Number.isFinite(supplierPayable) || !Number.isFinite(taxFee)) {
      fail(res, 400, "BAD_REQUEST", "invalid settlement payload");
      return;
    }
    const id = `set_${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO admin_settlement_entries (
        id, company_id, order_id, client_receivable, supplier_payable, tax_fee, currency, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(id, auth.companyId, orderId, clientReceivable, supplierPayable, taxFee, body.currency?.trim() || "CNY", now);
    ok(res, { id, updatedAt: now });
  });

  app.get("/admin/settlement/profit", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = db
      .prepare(
        `
        SELECT order_id, client_receivable, supplier_payable, tax_fee, currency, updated_at
        FROM admin_settlement_entries
        WHERE company_id = ?
        ORDER BY updated_at DESC
        `,
      )
      .all(auth.companyId) as Array<{
      order_id: string;
      client_receivable: number;
      supplier_payable: number;
      tax_fee: number;
      currency: string;
      updated_at: string;
    }>;
    ok(res, {
      items: rows.map((item) => ({
        orderId: item.order_id,
        clientReceivable: item.client_receivable,
        supplierPayable: item.supplier_payable,
        taxFee: item.tax_fee,
        profit: Number((item.client_receivable - item.supplier_payable - item.tax_fee).toFixed(2)),
        currency: item.currency,
        updatedAt: item.updated_at,
      })),
    });
  });

  app.get("/admin/ops/overview", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const profitRows = db
      .prepare(
        `
        SELECT order_id, client_receivable, supplier_payable, tax_fee, updated_at
        FROM admin_settlement_entries
        WHERE company_id = ?
        ORDER BY updated_at DESC
        LIMIT 20
        `,
      )
      .all(auth.companyId) as Array<{
      order_id: string;
      client_receivable: number;
      supplier_payable: number;
      tax_fee: number;
      updated_at: string;
    }>;
    const totalRevenue = profitRows.reduce((sum, item) => sum + item.client_receivable, 0);
    const totalCost = profitRows.reduce((sum, item) => sum + item.supplier_payable + item.tax_fee, 0);
    const totalProfit = totalRevenue - totalCost;
    const grossMarginPercent = totalRevenue > 0 ? Number(((totalProfit / totalRevenue) * 100).toFixed(2)) : 0;
    const profitTrend = profitRows.slice(0, 7).map((item) => ({
      orderId: item.order_id,
      profit: Number((item.client_receivable - item.supplier_payable - item.tax_fee).toFixed(2)),
      updatedAt: item.updated_at,
    }));

    const customsRows = db
      .prepare(
        `
        SELECT id, shipment_id, order_id, status, remark, updated_at
        FROM admin_customs_cases
        WHERE company_id = ? AND status IN ('inspection', 'pending')
        ORDER BY updated_at DESC
        LIMIT 20
        `,
      )
      .all(auth.companyId) as Array<{
      id: string;
      shipment_id: string | null;
      order_id: string | null;
      status: string;
      remark: string | null;
      updated_at: string;
    }>;

    const lmpRows = db
      .prepare(
        `
        SELECT route_code, supplier_name, quote_price, updated_at
        FROM admin_lmp_rates
        WHERE company_id = ?
        ORDER BY route_code ASC, supplier_name ASC, updated_at DESC
        `,
      )
      .all(auth.companyId) as Array<{
      route_code: string;
      supplier_name: string;
      quote_price: number;
      updated_at: string;
    }>;
    const latestByKey = new Map<string, { quotePrice: number; updatedAt: string }>();
    const previousByKey = new Map<string, { quotePrice: number; updatedAt: string }>();
    lmpRows.forEach((item) => {
      const key = `${item.route_code}__${item.supplier_name}`;
      if (!latestByKey.has(key)) {
        latestByKey.set(key, { quotePrice: item.quote_price, updatedAt: item.updated_at });
      } else if (!previousByKey.has(key)) {
        previousByKey.set(key, { quotePrice: item.quote_price, updatedAt: item.updated_at });
      }
    });
    const supplierPriceAlerts = Array.from(latestByKey.entries())
      .map(([key, latest]) => {
        const previous = previousByKey.get(key);
        if (!previous) return null;
        const [routeCode, supplierName] = key.split("__");
        const delta = Number((latest.quotePrice - previous.quotePrice).toFixed(2));
        if (Math.abs(delta) < 0.01) return null;
        return {
          routeCode,
          supplierName,
          previousQuotePrice: previous.quotePrice,
          latestQuotePrice: latest.quotePrice,
          delta,
          updatedAt: latest.updatedAt,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .slice(0, 10);

    ok(res, {
      profitSummary: {
        totalRevenue: Number(totalRevenue.toFixed(2)),
        totalCost: Number(totalCost.toFixed(2)),
        totalProfit: Number(totalProfit.toFixed(2)),
        grossMarginPercent,
      },
      profitTrend,
      customsAlerts: customsRows.map((item) => ({
        id: item.id,
        shipmentId: item.shipment_id ?? undefined,
        orderId: item.order_id ?? undefined,
        status: item.status,
        remark: item.remark ?? undefined,
        updatedAt: item.updated_at,
      })),
      supplierPriceAlerts,
    });
  });
}
