const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const ROOT_DIR = __dirname;
const dataPath = path.join(ROOT_DIR, "data.json");
const calendarDir = path.join(ROOT_DIR, "calendar");
const localUpdatePath = path.join(ROOT_DIR, "update.json");
const indexPath = path.join(ROOT_DIR, "index.html");
const serverPath = path.join(ROOT_DIR, "server.js");

const REMOTE_UPDATE_JSON_URL = "https://raw.githubusercontent.com/wkekdkdjsicjdjwokckd/upd/refs/heads/main/update.json";

let server = null;
let isUpdating = false;
let isRestarting = false;

if (!fs.existsSync(calendarDir)) {
  fs.mkdirSync(calendarDir, { recursive: true });
}

function ensureLocalUpdateFile() {
  if (!fs.existsSync(localUpdatePath)) {
    const initialUpdateInfo = {
      version: "1.0",
      files: {
        index: "",
        server: ""
      }
    };
    fs.writeFileSync(localUpdatePath, JSON.stringify(initialUpdateInfo, null, 2));
  }
}

ensureLocalUpdateFile();

function readData() {
  if (!fs.existsSync(dataPath)) {
    const init = {
      conteudo: 0,
      atos: 0,
      progresso: 0,
      meta: 0,
      metaNome: "",
      lastCheckin: null,
      themeHue: 219,
      showResetCiclo: true,
      showResetTotal: true,
      modalAlpha: 100,
      overlayBlur: 10
    };
    fs.writeFileSync(dataPath, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(dataPath, "utf8"));
}

function isSameDay(ts) {
  if (!ts) return false;
  const d1 = new Date(ts), d2 = new Date();
  return d1.getFullYear() == d2.getFullYear() && d1.getMonth() == d2.getMonth() && d1.getDate() == d2.getDate();
}

function getDayFile(dateStr) {
  return path.join(calendarDir, `${dateStr}.json`);
}

function readDayReports(dateStr) {
  const fp = getDayFile(dateStr);
  if (!fs.existsSync(fp)) {
    return { date: dateStr, items: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!Array.isArray(data.items)) data.items = [];
    return data;
  } catch {
    return { date: dateStr, items: [] };
  }
}

function writeDayReports(dateStr, data) {
  fs.writeFileSync(getDayFile(dateStr), JSON.stringify(data, null, 2));
}

function summarizeDay(items) {
  const total = items.reduce((acc, item) => acc + Number(item.level || 0), 0);
  const count = items.length;
  const average = count ? total / count : 0;
  const hasReset = items.some(i => Number(i.level) === 5);
  const hasTotalReset = items.some(i => Number(i.level) === 6);
  return { total, count, average, hasReset, hasTotalReset };
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readLocalUpdateInfo() {
  ensureLocalUpdateFile();
  const fallback = {
    version: "1.0",
    files: {
      index: "",
      server: ""
    }
  };
  return readJsonFileSafe(localUpdatePath, fallback);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Corpo da requisição muito grande."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Muitos redirecionamentos ao baixar atualização."));
      return;
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error("URL inválida na atualização."));
      return;
    }

    const client = parsed.protocol === "https:" ? https : http;

    const req = client.get(parsed, res => {
      const statusCode = res.statusCode || 0;
      const location = res.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        const redirectUrl = new URL(location, parsed).toString();
        res.resume();
        fetchUrl(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`Falha ao baixar arquivo remoto. HTTP ${statusCode}.`));
        return;
      }

      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });

    req.setTimeout(15000, () => {
      req.destroy(new Error("Tempo esgotado ao baixar atualização."));
    });

    req.on("error", reject);
  });
}

async function fetchText(url) {
  const buffer = await fetchUrl(url);
  return buffer.toString("utf8");
}

async function fetchJson(url) {
  const text = await fetchText(url);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("O update.json remoto é inválido.");
  }
}

function validateRemoteUpdateInfo(info) {
  if (!info || typeof info !== "object") {
    throw new Error("O update.json remoto está inválido.");
  }

  const version = typeof info.version === "string" ? info.version.trim() : "";
  const files = info.files && typeof info.files === "object" ? info.files : null;
  const indexUrl = files && typeof files.index === "string" ? files.index.trim() : "";
  const serverUrl = files && typeof files.server === "string" ? files.server.trim() : "";

  if (!version) {
    throw new Error("A versão remota é inválida.");
  }

  if (!indexUrl || !serverUrl) {
    throw new Error("Os links de atualização remotos estão inválidos.");
  }

  return {
    version,
    files: {
      index: indexUrl,
      server: serverUrl
    }
  };
}

function replaceFileSafely(targetPath, content) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tempPath = path.join(dir, `.${base}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, targetPath);
}

async function checkForUpdate() {
  const localInfo = readLocalUpdateInfo();
  const remoteInfo = validateRemoteUpdateInfo(await fetchJson(REMOTE_UPDATE_JSON_URL));

  const currentVersion = String(localInfo.version || "").trim() || "1.0";
  const remoteVersion = String(remoteInfo.version || "").trim();
  const hasUpdate = currentVersion !== remoteVersion;

  return {
    ok: true,
    hasUpdate,
    currentVersion,
    remoteVersion,
    files: remoteInfo.files
  };
}

async function performUpdate() {
  if (isUpdating) {
    return { ok: false, error: "Já existe uma atualização em andamento." };
  }

  isUpdating = true;

  const backupPaths = {
    index: `${indexPath}.bak`,
    server: `${serverPath}.bak`,
    update: `${localUpdatePath}.bak`
  };

  try {
    const check = await checkForUpdate();

    if (!check.hasUpdate) {
      return {
        ok: true,
        updated: false,
        hasUpdate: false,
        currentVersion: check.currentVersion,
        remoteVersion: check.remoteVersion,
        message: "Seu site já está atualizado."
      };
    }

    const remoteInfo = validateRemoteUpdateInfo(await fetchJson(REMOTE_UPDATE_JSON_URL));

    const [newIndexHtml, newServerJs] = await Promise.all([
      fetchText(remoteInfo.files.index),
      fetchText(remoteInfo.files.server)
    ]);

    if (!newIndexHtml.trim()) {
      throw new Error("O index.html remoto veio vazio.");
    }

    if (!newServerJs.trim()) {
      throw new Error("O server.js remoto veio vazio.");
    }

    try {
      new Function(newServerJs);
    } catch {
      throw new Error("O server.js remoto contém erro de sintaxe.");
    }

    if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, backupPaths.index);
    if (fs.existsSync(serverPath)) fs.copyFileSync(serverPath, backupPaths.server);
    if (fs.existsSync(localUpdatePath)) fs.copyFileSync(localUpdatePath, backupPaths.update);

    replaceFileSafely(indexPath, newIndexHtml);
    replaceFileSafely(serverPath, newServerJs);
    replaceFileSafely(localUpdatePath, JSON.stringify(remoteInfo, null, 2));

    if (fs.existsSync(backupPaths.index)) fs.unlinkSync(backupPaths.index);
    if (fs.existsSync(backupPaths.server)) fs.unlinkSync(backupPaths.server);
    if (fs.existsSync(backupPaths.update)) fs.unlinkSync(backupPaths.update);

    return {
      ok: true,
      updated: true,
      hasUpdate: true,
      currentVersion: check.currentVersion,
      remoteVersion: remoteInfo.version,
      message: "Atualização aplicada com sucesso."
    };
  } catch (error) {
    try {
      if (fs.existsSync(backupPaths.index)) fs.copyFileSync(backupPaths.index, indexPath);
      if (fs.existsSync(backupPaths.server)) fs.copyFileSync(backupPaths.server, serverPath);
      if (fs.existsSync(backupPaths.update)) fs.copyFileSync(backupPaths.update, localUpdatePath);
    } catch {}

    try { if (fs.existsSync(backupPaths.index)) fs.unlinkSync(backupPaths.index); } catch {}
    try { if (fs.existsSync(backupPaths.server)) fs.unlinkSync(backupPaths.server); } catch {}
    try { if (fs.existsSync(backupPaths.update)) fs.unlinkSync(backupPaths.update); } catch {}

    return {
      ok: false,
      error: error && error.message ? error.message : "Falha desconhecida ao atualizar."
    };
  } finally {
    isUpdating = false;
  }
}

function restartServerGracefully() {
  if (isRestarting || !server) return;
  isRestarting = true;

  server.close(() => {
    try {
      delete require.cache[require.resolve(serverPath)];
      require(serverPath);
    } catch (err) {
      process.exit(1);
    }
  });
}

function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readData()));
  }

  else if (url.pathname === "/check-update") {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Método não permitido." }));
      return;
    }

    checkForUpdate()
      .then(result => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      })
      .catch(err => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          error: err && err.message ? err.message : "Não foi possível verificar atualização."
        }));
      });
  }

  else if (url.pathname === "/update") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Método não permitido." }));
      return;
    }

    performUpdate()
      .then(result => {
        res.writeHead(result.ok ? 200 : 500, {
          "Content-Type": "application/json",
          "Connection": "close"
        });
        res.end(JSON.stringify(result));

        if (result.ok && result.updated) {
          res.on("finish", () => {
            setTimeout(restartServerGracefully, 300);
          });
        }
      })
      .catch(err => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          error: err && err.message ? err.message : "Falha ao executar atualização."
        }));
      });
  }

  else if (url.pathname === "/calendar-save") {
    parseRequestBody(req)
      .then(body => {
        const p = JSON.parse(body || "{}");
        const date = p.date;
        const level = Number(p.level || 0);
        const note = typeof p.note === "string" ? p.note : "";

        if (!date || !level) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
          return;
        }

        const dayData = readDayReports(date);
        dayData.items.push({ level, note, createdAt: Date.now() });
        writeDayReports(date, dayData);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      });
  }

  else if (url.pathname === "/reset-atos") {
    const d = readData();
    d.atos = 0;
    fs.writeFileSync(dataPath, JSON.stringify(d, null, 2));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(d));
  }

  else if (url.pathname === "/reset-total") {
    const d = readData();
    d.atos = 0;
    d.conteudo = 0;
    fs.writeFileSync(dataPath, JSON.stringify(d, null, 2));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(d));
  }

  else if (url.pathname === "/calendar-month") {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const prefix = `${y}-${m}`;
    const out = {};
    const files = fs.readdirSync(calendarDir);

    files.forEach(f => {
      if (!f.endsWith(".json")) return;
      const dateStr = f.replace(".json", "");
      if (!dateStr.startsWith(prefix)) return;
      const dayData = readDayReports(dateStr);
      const summary = summarizeDay(dayData.items);
      out[dateStr] = summary;
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  }

  else if (url.pathname === "/calendar-all") {
    let all = [];
    const files = fs.readdirSync(calendarDir);

    files.forEach(f => {
      if (f.endsWith(".json")) {
        const data = JSON.parse(fs.readFileSync(path.join(calendarDir, f), "utf8"));
        all = all.concat(data.items || []);
      }
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(all));
  }

  else if (url.pathname === "/calendar-day") {
    const date = url.searchParams.get("date");
    const dayData = readDayReports(date || "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dayData));
  }

  else if (url.pathname === "/checkin") {
    const d = readData();
    if (isSameDay(d.lastCheckin)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(d));
      return;
    }
    if (d.meta > 0 && d.progresso >= d.meta) {
      d.meta = 0;
      d.metaNome = "";
    }
    d.conteudo++;
    d.atos++;
    d.progresso++;
    d.lastCheckin = Date.now();
    fs.writeFileSync(dataPath, JSON.stringify(d, null, 2));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(d));
  }

  else if (url.pathname === "/editmeta") {
    parseRequestBody(req)
      .then(body => {
        const p = JSON.parse(body || "{}");
        const d = readData();
        d.metaNome = p.metaNome;
        d.meta = p.meta;
        d.progresso = 0;
        fs.writeFileSync(dataPath, JSON.stringify(d, null, 2));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(d));
      })
      .catch(() => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      });
  }

  else if (url.pathname === "/settings") {
    parseRequestBody(req)
      .then(body => {
        const p = JSON.parse(body || "{}");
        const d = readData();

        if (p.themeHue !== undefined) d.themeHue = p.themeHue;
        if (p.modalAlpha !== undefined) d.modalAlpha = p.modalAlpha;
        if (p.overlayBlur !== undefined) d.overlayBlur = p.overlayBlur;
        if (p.showResetCiclo !== undefined) d.showResetCiclo = p.showResetCiclo;
        if (p.showResetTotal !== undefined) d.showResetTotal = p.showResetTotal;

        fs.writeFileSync(dataPath, JSON.stringify(d, null, 2));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(d));
      })
      .catch(() => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      });
  }

  else {
    const fp = path.join(ROOT_DIR, url.pathname === "/" ? "index.html" : url.pathname);

    fs.readFile(fp, (e, d) => {
      if (e) {
        res.writeHead(404);
        res.end();
        return;
      }

      const ext = path.extname(fp);
      const m = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".json": "application/json"
      }[ext] || "text/plain";

      res.writeHead(200, { "Content-Type": m });
      res.end(d);
    });
  }
}

function startServer() {
  server = http.createServer(handleRequest);
  server.listen(PORT);
}

startServer();
