/**
 * 局域网访问前端开发服务器：自动设置 NEXT_PUBLIC_API_BASE_URL 为本机 IPv4，
 * 以便同一局域网内其他设备上的浏览器请求到本机 API（而非访客设备自身的 127.0.0.1）。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 获取本机第一个非回环的 IPv4 地址；若无则回退为 127.0.0.1。
 * @returns {string}
 */
function getLanIPv4() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * 解析 API 端口（与 apps/api 默认 3001 一致）。
 * @returns {string}
 */
function getApiPort() {
  return String(process.env.API_PORT ?? process.env.PORT ?? "3001").trim() || "3001";
}

const repoRoot = join(__dirname, "..");
const ip = getLanIPv4();
const port = getApiPort();
const baseUrl = `http://${ip}:${port}`;

process.env.NEXT_PUBLIC_API_BASE_URL = baseUrl;

// eslint-disable-next-line no-console
console.log(`[lan] NEXT_PUBLIC_API_BASE_URL=${baseUrl}`);
// eslint-disable-next-line no-console
console.log("[lan] 请先在本机另一终端运行: npm run dev:api");
// eslint-disable-next-line no-console
console.log(`[lan] 局域网用户浏览器打开: http://${ip}:3000/`);

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npmBin, ["run", "dev:public", "--prefix", "apps/web"], {
  cwd: repoRoot,
  env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: baseUrl },
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
