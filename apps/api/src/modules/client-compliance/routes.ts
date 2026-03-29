import type { DatabaseSync } from "node:sqlite";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { refreshCnyThbRateIfStale } from "../exchange-rate/rate-sync";

/**
 * 注册客户端合规与多币种账户接口。
 */
export function registerClientComplianceRoutes(app: MinimalHttpApp, db: DatabaseSync): void {
  app.get("/client/documents", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const rows = db
      .prepare(
        `
        SELECT id, doc_type, file_name, mime, content_base64, created_at
        FROM client_documents
        WHERE company_id = ? AND client_id = ?
        ORDER BY created_at DESC
        `,
      )
      .all(auth.companyId, auth.userId) as Array<{
      id: string;
      doc_type: string;
      file_name: string;
      mime: string;
      content_base64: string;
      created_at: string;
    }>;
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        docType: item.doc_type,
        fileName: item.file_name,
        mime: item.mime,
        contentBase64: item.content_base64,
        createdAt: item.created_at,
      })),
    });
  });

  app.post("/client/documents", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      docType?: string;
      fileName?: string;
      mime?: string;
      contentBase64?: string;
    };
    const docType = body.docType?.trim();
    const fileName = body.fileName?.trim();
    const mime = body.mime?.trim();
    const contentBase64 = body.contentBase64?.trim();
    if (!docType || !fileName || !mime || !contentBase64) {
      fail(res, 400, "BAD_REQUEST", "docType, fileName, mime and contentBase64 are required");
      return;
    }
    if (contentBase64.length > 4_000_000) {
      fail(res, 400, "BAD_REQUEST", "file too large (max 4MB base64)");
      return;
    }
    const now = new Date().toISOString();
    const id = `doc_${Date.now()}`;
    db.prepare(
      `
      INSERT INTO client_documents (
        id, company_id, client_id, doc_type, file_name, mime, content_base64, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(id, auth.companyId, auth.userId, docType, fileName, mime, contentBase64, now);
    ok(res, { id, docType, fileName, mime, createdAt: now });
  });

  app.delete("/client/documents", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }
    const result = db
      .prepare("DELETE FROM client_documents WHERE id = ? AND company_id = ? AND client_id = ?")
      .run(id, auth.companyId, auth.userId);
    ok(res, { deleted: result.changes > 0, id });
  });

  app.get("/client/wallet/overview", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const rateSnapshot = await refreshCnyThbRateIfStale(db);
    const accountRows = db
      .prepare(
        `
        SELECT currency, balance, updated_at
        FROM client_wallet_accounts
        WHERE company_id = ? AND client_id = ?
        ORDER BY currency ASC
        `,
      )
      .all(auth.companyId, auth.userId) as Array<{ currency: string; balance: number; updated_at: string }>;
    ok(res, {
      accounts: accountRows.map((item) => ({
        currency: item.currency,
        balance: item.balance,
        updatedAt: item.updated_at,
      })),
      exchangeRate: {
        pair: "CNY/THB",
        rate: rateSnapshot.rate,
        updatedAt: rateSnapshot.updatedAt,
      },
    });
  });
}
