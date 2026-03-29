import type { DatabaseSync } from "node:sqlite";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

interface ClientAddressRow {
  id: string;
  company_id: string;
  client_id: string;
  contact_name: string;
  contact_phone: string;
  address_detail: string;
  lat: number | null;
  lng: number | null;
  label: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

/**
 * 将数据库行映射为前端需要的地址对象。
 */
function toAddressPayload(row: ClientAddressRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    clientId: row.client_id,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    addressDetail: row.address_detail,
    lat: row.lat ?? undefined,
    lng: row.lng ?? undefined,
    label: row.label ?? undefined,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 校验并标准化经纬度输入。
 */
function normalizeCoord(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * 注册客户端地址簿相关接口。
 */
export function registerClientAddressRoutes(app: MinimalHttpApp, db: DatabaseSync): void {
  app.get("/client/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const rows = db
      .prepare(
        `
        SELECT
          id, company_id, client_id, contact_name, contact_phone, address_detail, lat, lng, label,
          is_default, created_at, updated_at
        FROM client_addresses
        WHERE company_id = ? AND client_id = ?
        ORDER BY is_default DESC, updated_at DESC
        `,
      )
      .all(auth.companyId, auth.userId) as ClientAddressRow[];
    ok(res, { items: rows.map(toAddressPayload) });
  });

  app.post("/client/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      contactName?: string;
      contactPhone?: string;
      addressDetail?: string;
      lat?: unknown;
      lng?: unknown;
      label?: string;
      isDefault?: boolean;
    };
    const contactName = body.contactName?.trim();
    const contactPhone = body.contactPhone?.trim();
    const addressDetail = body.addressDetail?.trim();
    if (!contactName || !contactPhone || !addressDetail) {
      fail(res, 400, "BAD_REQUEST", "contactName, contactPhone and addressDetail are required");
      return;
    }
    const lat = normalizeCoord(body.lat);
    const lng = normalizeCoord(body.lng);
    const now = new Date().toISOString();
    const id = `addr_${Date.now()}`;
    const isDefault = body.isDefault ? 1 : 0;
    if (isDefault) {
      db.prepare("UPDATE client_addresses SET is_default = 0 WHERE company_id = ? AND client_id = ?").run(
        auth.companyId,
        auth.userId,
      );
    }
    db.prepare(
      `
      INSERT INTO client_addresses (
        id, company_id, client_id, contact_name, contact_phone, address_detail, lat, lng, label, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(id, auth.companyId, auth.userId, contactName, contactPhone, addressDetail, lat, lng, body.label?.trim() || null, isDefault, now, now);
    const created = db
      .prepare(
        `
        SELECT
          id, company_id, client_id, contact_name, contact_phone, address_detail, lat, lng, label,
          is_default, created_at, updated_at
        FROM client_addresses
        WHERE id = ?
        `,
      )
      .get(id) as ClientAddressRow;
    ok(res, toAddressPayload(created));
  });

  app.post("/client/addresses/set-default", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { id?: string };
    const id = body.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }
    const existed = db
      .prepare("SELECT id FROM client_addresses WHERE id = ? AND company_id = ? AND client_id = ?")
      .get(id, auth.companyId, auth.userId) as { id: string } | undefined;
    if (!existed) {
      fail(res, 404, "NOT_FOUND", "address not found");
      return;
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE client_addresses SET is_default = 0 WHERE company_id = ? AND client_id = ?").run(
      auth.companyId,
      auth.userId,
    );
    db.prepare("UPDATE client_addresses SET is_default = 1, updated_at = ? WHERE id = ?").run(now, id);
    ok(res, { id, isDefault: true, updatedAt: now });
  });

  app.delete("/client/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }
    const result = db
      .prepare("DELETE FROM client_addresses WHERE id = ? AND company_id = ? AND client_id = ?")
      .run(id, auth.companyId, auth.userId);
    ok(res, { deleted: result.changes > 0, id });
  });
}
