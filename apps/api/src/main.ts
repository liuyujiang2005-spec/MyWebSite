import { createDbContext } from "./db/sqlite";
import { registerAdminRoutes } from "./modules/admin/routes";
import { registerClientAiRoutes } from "./modules/ai";
import { registerAdminOpsRoutes } from "./modules/admin-ops/routes";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerClientAddressRoutes } from "./modules/client-addresses/routes";
import { registerClientComplianceRoutes } from "./modules/client-compliance/routes";
import { registerOrderRoutes } from "./modules/orders/routes";
import { registerShipmentRoutes } from "./modules/shipments/routes";
import { createApp } from "./server";
import { startDailyExchangeRateScheduler } from "./modules/exchange-rate/rate-sync";

const PORT = Number(process.env.PORT ?? 3001);

const app = createApp();
const db = createDbContext();

// Core business routes
registerAuthRoutes(app, db.db);
registerOrderRoutes(app, db.db);
registerShipmentRoutes(app, db.db);
registerClientAddressRoutes(app, db.db);
registerClientComplianceRoutes(app, db.db);
registerAdminRoutes(app, db.db);
registerAdminOpsRoutes(app, db.db);
startDailyExchangeRateScheduler(db.db);

// AI routes
registerClientAiRoutes(app, db.db);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log("[api] POST /auth/login");
  // eslint-disable-next-line no-console
  console.log("[api] POST /auth/register");
  // eslint-disable-next-line no-console
  console.log("[api] POST /staff/orders");
  // eslint-disable-next-line no-console
  console.log("[api] POST /staff/orders/product-images");
  // eslint-disable-next-line no-console
  console.log("[api] DELETE /staff/orders/product-images?id=opi_xxx");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /client/orders");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /client/shipments/search");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /public/track?trackingNo=xxx&phoneLast4=1234");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /client/express/universal?trackingNo=xxx&companyCode=shunfeng");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /client/addresses");
  // eslint-disable-next-line no-console
  console.log("[api] POST /client/addresses");
  // eslint-disable-next-line no-console
  console.log("[api] POST /client/addresses/set-default");
  // eslint-disable-next-line no-console
  console.log("[api] DELETE /client/addresses?id=addr_xxx");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /client/documents");
  // eslint-disable-next-line no-console
  console.log("[api] POST /client/documents");
  // eslint-disable-next-line no-console
  console.log("[api] DELETE /client/documents?id=doc_xxx");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /client/wallet/overview");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /staff/shipments");
  // eslint-disable-next-line no-console
  console.log("[api] POST /staff/shipments/set-container");
  // eslint-disable-next-line no-console
  console.log("[api] POST /staff/shipments/repair-order-links");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /staff/inbound-photos?shipmentId=s_xxx");
  // eslint-disable-next-line no-console
  console.log("[api] POST /staff/inbound-photos");
  // eslint-disable-next-line no-console
  console.log("[api] POST /staff/shipments/update-status");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/dashboard/overview");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/users?role=staff|client");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/users (create staff)");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/users/client (create client)");
  // eslint-disable-next-line no-console
  console.log("[api] DELETE /admin/users?id=xxx");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/users/set-password");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/orders");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/lmp/rates");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/lmp/rates");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/customs/cases");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/customs/cases");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/lastmile/orders");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/lastmile/orders");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/settlement/entries");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/settlement/entries");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/settlement/profit");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/ops/overview");
  // eslint-disable-next-line no-console
  console.log("[api] POST /client/ai/chat");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /client/ai/suggestions");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/ai/audit-logs");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/ai/knowledge-gaps");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/ai/knowledge-gaps/resolve");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/ai/session-memory");
  // eslint-disable-next-line no-console
  console.log("[api] DELETE /admin/ai/session-memory?sessionId=xxx|userId=xxx");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/system/status-labels");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/system/status-labels");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/system/status-labels/reset");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/ai/knowledge");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/ai/knowledge");
  // eslint-disable-next-line no-console
  console.log("[api] DELETE /admin/ai/knowledge?id=kn_xxx");
});
