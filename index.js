require("dotenv").config();
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || "https://razorpay-backend-ke6v.onrender.com";

const PRODUCTS = {
  "modern-resume-pack": {
    id: "modern-resume-pack",
    name: "Modern Resume Pack",
    description: "Clean, editable and ATS-friendly resume resources.",
    amount: 9900,
    currency: "INR",
    active: true,
    downloadPath: "product-pack.html"
  }
};

const recentOrders = new Map();
const rateBuckets = new Map();

const db = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
    })
  : null;

const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
  ? new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET
    })
  : null;

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function cleanExpiredEntries(map, ttlMs) {
  const cutoff = Date.now() - ttlMs;
  for (const [key, value] of map) {
    if (value.createdAt < cutoff) map.delete(key);
  }
}

function rateLimit(req, res, next) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const windowMs = 60_000;
  const max = 60;
  const entry = rateBuckets.get(key);

  if (!entry || now - entry.startedAt >= windowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return next();
  }

  entry.count += 1;
  if (entry.count > max) {
    return res.status(429).json({
      success: false,
      message: "Too many requests. Please try again shortly."
    });
  }

  return next();
}

function setSecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cache-Control", "no-store");
  next();
}

function getRequestId(req, res, next) {
  const requestId = req.get("X-Request-ID") || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
}

const allowedOrigins = [
  FRONTEND_URL,
  "http://localhost:5500",
  "http://127.0.0.1:5500"
].filter(Boolean);

app.set("trust proxy", 1);
app.use(setSecurityHeaders);
app.use(getRequestId);
app.use(rateLimit);

// Razorpay signs the exact raw request body. Keep this route before express.json().
app.post("/webhook/razorpay", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
  if (!RAZORPAY_WEBHOOK_SECRET) {
    return res.status(503).json({
      success: false,
      message: "Razorpay webhook secret is not configured."
    });
  }

  const signature = req.get("X-Razorpay-Signature");
  if (!signature) {
    return res.status(400).json({ success: false, message: "Missing webhook signature." });
  }

  const expected = crypto
    .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
    .update(req.body)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(signature, "utf8");

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    return res.status(400).json({ success: false, message: "Invalid webhook signature." });
  }

  try {
    const event = JSON.parse(req.body.toString("utf8"));
    const eventId = req.get("x-razorpay-event-id") ||
      crypto.createHash("sha256").update(req.body).digest("hex");

    if (db) {
      const inserted = await db.query(
        `insert into webhook_events (event_id, event_type, payload)
         values ($1, $2, $3)
         on conflict (event_id) do nothing
         returning event_id`,
        [eventId, event.event, event]
      );

      if (inserted.rowCount === 0) {
        return res.json({ success: true, duplicate: true });
      }

      await processWebhookEvent(event);
    } else {
      console.warn("Webhook accepted without database persistence.");
    }

    console.log("Razorpay webhook received:", {
      event: event.event,
      eventId
    });

    return res.json({ success: true, received: true });
  } catch (error) {
    console.error("Webhook processing error:", {
      requestId: req.requestId,
      message: error.message
    });
    return res.status(400).json({ success: false, message: "Invalid webhook payload." });
  }
});

app.use(express.json({ limit: "16kb" }));

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS."));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "X-Request-ID", "X-Idempotency-Key", "Authorization"]
}));

app.use((err, req, res, next) => {
  if (err?.message === "Origin not allowed by CORS.") {
    return res.status(403).json({
      success: false,
      message: "This origin is not allowed to access the payment service.",
      requestId: req.requestId
    });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON payload.",
      requestId: req.requestId
    });
  }
  return next(err);
});

function requireRazorpayConfig(res) {
  if (!razorpay) {
    return res.status(503).json({
      success: false,
      message: "Payment gateway is not configured."
    });
  }
  return null;
}

function getProduct(productId) {
  const product = PRODUCTS[productId];
  return product?.active ? product : null;
}

function requireDatabase(res) {
  if (!db) {
    res.status(503).json({
      success: false,
      message: "Commerce database is not configured."
    });
    return true;
  }
  return false;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      success: false,
      message: "Admin API is not configured."
    });
  }

  const token = req.get("Authorization")?.replace(/^Bearer\s+/i, "");
  const tokenBuffer = Buffer.from(token || "", "utf8");
  const adminBuffer = Buffer.from(ADMIN_TOKEN, "utf8");

  if (
    !token ||
    tokenBuffer.length !== adminBuffer.length ||
    !crypto.timingSafeEqual(tokenBuffer, adminBuffer)
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized."
    });
  }

  return next();
}

async function initializeDatabase() {
  if (!db) {
    console.warn("DATABASE_URL is not configured; running without persistence.");
    return;
  }

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db.query(schema);
  console.log("PostgreSQL schema ready.");
}

async function getOrCreateDownload(orderId) {
  if (!db) return null;

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const existing = await db.query(
    "select id from downloads where order_id = $1",
    [orderId]
  );

  if (existing.rowCount > 0) {
    await db.query(
      `update downloads
       set token_hash = $1,
           download_count = 0,
           max_downloads = 5,
           expires_at = now() + interval '7 days',
           last_downloaded_at = null
       where order_id = $2`,
      [tokenHash, orderId]
    );
  } else {
    await db.query(
      `insert into downloads
       (id, order_id, token_hash, max_downloads, expires_at)
       values ($1, $2, $3, 5, now() + interval '7 days')`,
      [makeId("dl"), orderId, tokenHash]
    );
  }

  return rawToken;
}

function createStatelessDownloadToken(orderId, paymentId) {
  const payload = {
    orderId,
    paymentId,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyStatelessDownloadToken(token) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET).update(encoded).digest("base64url");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.orderId || !payload.paymentId || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function markOrderPaid(razorpayOrderId, razorpayPaymentId, amount, currency) {
  if (!db) {
    return {
      id: razorpayOrderId,
      order_number: `RP-${razorpayOrderId}`,
      product_id: null,
      downloadUrl: null
    };
  }

  const result = await db.query(
    `update orders
     set status = 'PAID',
         razorpay_payment_id = $1,
         amount = $2,
         currency = $3,
         updated_at = now()
     where razorpay_order_id = $4
       and amount = $2
       and currency = $3
     returning id, order_number, product_id`,
    [razorpayPaymentId, amount, currency, razorpayOrderId]
  );

  if (result.rowCount === 0) {
    throw new Error("Order was not found or amount/currency did not match.");
  }

  const order = result.rows[0];
  const token = await getOrCreateDownload(order.id);

  return {
    ...order,
    downloadUrl: token ? `/download/${token}` : null
  };
}

async function processWebhookEvent(event) {
  const paymentEntity = event?.payload?.payment?.entity;
  const orderEntity = event?.payload?.order?.entity;

  if (event.event === "payment.captured" && paymentEntity?.order_id) {
    await markOrderPaid(
      paymentEntity.order_id,
      paymentEntity.id,
      paymentEntity.amount,
      paymentEntity.currency
    );
    return;
  }

  if (event.event === "order.paid" && orderEntity?.id && paymentEntity?.id) {
    await markOrderPaid(
      orderEntity.id,
      paymentEntity.id,
      paymentEntity.amount,
      paymentEntity.currency
    );
  }
}

app.get("/", (req, res) => {
  res.json({
    service: "ResumeCraft Payments API",
    status: "online",
    version: "3.0.0"
  });
});

app.get("/health", async (req, res) => {
  let database = "not_configured";

  if (db) {
    try {
      await db.query("select 1");
      database = "connected";
    } catch {
      database = "error";
    }
  }

  res.json({
    status: database === "error" ? "degraded" : "OK",
    razorpayConfigured: Boolean(razorpay),
    webhookConfigured: Boolean(RAZORPAY_WEBHOOK_SECRET),
    database,
    environment: process.env.NODE_ENV || "development"
  });
});

app.get("/api/razorpay-key", (req, res) => {
  if (!RAZORPAY_KEY_ID) {
    return res.status(503).json({
      success: false,
      message: "Razorpay public key is not configured on the backend."
    });
  }

  return res.json({
    success: true,
    key: RAZORPAY_KEY_ID
  });
});

app.get("/api/products", async (req, res) => {
  const products = Object.values(PRODUCTS)
    .filter((product) => product.active)
    .map(({ id, name, description, amount, currency }) => ({
      id,
      name,
      description,
      amount,
      currency
    }));

  return res.json({ success: true, products });
});

app.post("/create-order", async (req, res) => {
  const configurationError = requireRazorpayConfig(res);
  if (configurationError) return configurationError;
  const idempotencyKey = req.get("X-Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return res.status(400).json({
      success: false,
      message: "A valid X-Idempotency-Key is required."
    });
  }

  cleanExpiredEntries(recentOrders, 10 * 60 * 1000);

  try {
    if (!db) {
      const cached = recentOrders.get(idempotencyKey);
      if (cached) return res.json(cached.response);
    } else {
      const existing = await db.query(
        `select o.razorpay_order_id, o.amount, o.currency, o.product_id, p.name, p.description
         from orders o
         join products p on p.id = o.product_id
         where o.idempotency_key = $1`,
        [idempotencyKey]
      );

      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        const order = await razorpay.orders.fetch(row.razorpay_order_id);
        return res.json({
          success: true,
          product: {
            id: row.product_id,
            name: row.name,
            description: row.description,
            amount: row.amount,
            currency: row.currency
          },
          order
        });
      }
    }

    const { productId, customer } = req.body;
    const product = getProduct(productId);

    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Invalid or unavailable product."
      });
    }

    const safeCustomer = {
      name: typeof customer?.name === "string" ? customer.name.trim().slice(0, 100) : "",
      email: typeof customer?.email === "string" ? customer.email.trim().slice(0, 160).toLowerCase() : ""
    };

    if (!safeCustomer.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeCustomer.email)) {
      return res.status(400).json({
        success: false,
        message: "A valid customer name and email are required."
      });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: product.amount,
      currency: product.currency,
      receipt: `rcpt_${crypto.randomBytes(8).toString("hex")}`,
      notes: {
        productId: product.id,
        customerEmail: safeCustomer.email
      }
    });

    const customerId = makeId("cus");
    const orderId = makeId("ord");
    const orderNumber = `RC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    if (db) await db.query(
      `insert into customers (id, name, email)
       values ($1, $2, $3)
       on conflict (email) do update set name = excluded.name
       returning id`,
      [customerId, safeCustomer.name, safeCustomer.email]
    );

    const customerRow = db
      ? await db.query("select id from customers where email = $1", [safeCustomer.email])
      : { rows: [{ id: customerId }] };

    if (db) await db.query(
      `insert into orders
       (id, order_number, customer_id, product_id, status, amount, currency, razorpay_order_id, idempotency_key)
       values ($1, $2, $3, $4, 'CREATED', $5, $6, $7, $8)`,
      [
        orderId,
        orderNumber,
        customerRow.rows[0].id,
        product.id,
        product.amount,
        product.currency,
        razorpayOrder.id,
        idempotencyKey
      ]
    );

    const response = {
      success: true,
      product,
      order: razorpayOrder
    };

    recentOrders.set(idempotencyKey, {
      createdAt: Date.now(),
      response
    });

    return res.status(200).json(response);
  } catch (err) {
    console.error("Create Order Error:", {
      requestId: req.requestId,
      statusCode: err.statusCode,
      code: err.error?.code,
      description: err.error?.description || err.message
    });

    return res.status(502).json({
      success: false,
      message: "Razorpay could not create the order. Please try again.",
      requestId: req.requestId
    });
  }
});

app.post("/verify-payment", async (req, res) => {
  if (!RAZORPAY_KEY_SECRET || !razorpay) {
    return res.status(503).json({
      success: false,
      message: "Payment verification is not configured on the backend."
    });
  }
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Payment verification data is incomplete."
      });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature, "utf8");
    const receivedBuffer = Buffer.from(razorpay_signature, "utf8");

    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment signature."
      });
    }

    const [payment, order] = await Promise.all([
      razorpay.payments.fetch(razorpay_payment_id),
      razorpay.orders.fetch(razorpay_order_id)
    ]);

    if (
      payment.order_id !== razorpay_order_id ||
      payment.status !== "captured" ||
      payment.amount !== order.amount ||
      payment.currency !== order.currency
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment details could not be validated."
      });
    }

    const paidOrder = await markOrderPaid(
      order.id,
      payment.id,
      payment.amount,
      payment.currency
    );

    const statelessDownloadUrl = !db
      ? `${PUBLIC_API_URL}/download/${createStatelessDownloadToken(order.id, payment.id)}`
      : null;

    return res.json({
      success: true,
      message: "Payment verified",
      orderId: order.id,
      orderNumber: paidOrder.order_number,
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      downloadUrl: paidOrder?.downloadUrl
        ? `${PUBLIC_API_URL}${paidOrder.downloadUrl}`
        : statelessDownloadUrl
    });
  } catch (err) {
    console.error("Verify Error:", {
      requestId: req.requestId,
      statusCode: err.statusCode,
      code: err.error?.code,
      description: err.error?.description || err.message
    });

    return res.status(500).json({
      success: false,
      message: "Payment verification failed. Please contact support if money was debited.",
      requestId: req.requestId
    });
  }
});

app.get("/download/:token", async (req, res) => {
  if (!db) {
    try {
      const payload = verifyStatelessDownloadToken(req.params.token);
      if (!payload) {
        return res.status(404).send("This download link is invalid or has expired.");
      }

      const [payment, order] = await Promise.all([
        razorpay.payments.fetch(payload.paymentId),
        razorpay.orders.fetch(payload.orderId)
      ]);

      if (
        payment.status !== "captured" ||
        payment.order_id !== order.id ||
        payment.amount !== order.amount ||
        payment.currency !== order.currency
      ) {
        return res.status(403).send("This payment is not eligible for download.");
      }

      const product = getProduct(order.notes?.productId || "modern-resume-pack");
      if (!product) {
        return res.status(404).send("The purchased product is unavailable.");
      }

      const filePath = path.resolve(__dirname, "products", product.downloadPath);
      const productRoot = path.resolve(__dirname, "products");
      if (!filePath.startsWith(productRoot + path.sep) || !fs.existsSync(filePath)) {
        return res.status(500).send("The purchased product is temporarily unavailable.");
      }

      res.setHeader("Content-Disposition", 'attachment; filename="ResumeCraft-Modern-Resume-Pack.html"');
      return res.sendFile(filePath);
    } catch (err) {
      console.error("Stateless download error:", { requestId: req.requestId, message: err.message });
      return res.status(500).send("Unable to prepare your download.");
    }
  }

  try {
    const tokenHash = crypto.createHash("sha256").update(req.params.token).digest("hex");
    const result = await db.query(
      `select d.id, d.download_count, d.max_downloads, d.expires_at,
              o.status, p.download_path
       from downloads d
       join orders o on o.id = d.order_id
       join products p on p.id = o.product_id
       where d.token_hash = $1`,
      [tokenHash]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("This download link is invalid or has expired.");
    }

    const row = result.rows[0];
    if (row.status !== "PAID") {
      return res.status(403).send("This order is not eligible for download.");
    }
    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
      return res.status(410).send("This download link has expired.");
    }
    if (row.download_count >= row.max_downloads) {
      return res.status(429).send("This download link has reached its download limit.");
    }

    const filePath = path.resolve(__dirname, "products", row.download_path);
    const productRoot = path.resolve(__dirname, "products");
    if (!filePath.startsWith(productRoot + path.sep) || !fs.existsSync(filePath)) {
      return res.status(500).send("The purchased product is temporarily unavailable.");
    }

    await db.query(
      `update downloads
       set download_count = download_count + 1,
           last_downloaded_at = now()
       where id = $1`,
      [row.id]
    );

    res.setHeader("Content-Disposition", `attachment; filename="ResumeCraft-Modern-Resume-Pack.html"`);
    return res.sendFile(filePath);
  } catch (err) {
    console.error("Download error:", {
      requestId: req.requestId,
      message: err.message
    });
    return res.status(500).send("Unable to prepare your download.");
  }
});

app.get("/admin/summary", requireAdmin, async (req, res) => {
  if (requireDatabase(res)) return;

  try {
    const result = await db.query(
      `select
         (select count(*) from orders)::int as total_orders,
         (select count(*) from orders where status = 'PAID')::int as paid_orders,
         (select coalesce(sum(amount), 0) from orders where status = 'PAID')::int as paid_amount,
         (select count(*) from customers)::int as customers`
    );
    return res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Could not load admin summary."
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found.",
    requestId: req.requestId
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled server error:", {
    requestId: req.requestId,
    message: err.message
  });
  return res.status(500).json({
    success: false,
    message: "Internal server error.",
    requestId: req.requestId
  });
});

async function start() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log("Server running on port", PORT);
      console.log(`Razorpay configured: ${Boolean(razorpay)}`);
      console.log(`Webhook configured: ${Boolean(RAZORPAY_WEBHOOK_SECRET)}`);
      console.log(`Database configured: ${Boolean(db)}`);
    });
  } catch (error) {
    console.error("Startup failed:", error.message);
    process.exit(1);
  }
}

start();
