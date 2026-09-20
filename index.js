require("dotenv").config();
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const PRODUCTS = {
  "modern-resume-pack": {
    id: "modern-resume-pack",
    name: "Modern Resume Pack",
    description: "Clean, editable and ATS-friendly resume resources.",
    amount: 9900,
    currency: "INR",
    active: true
  }
};

const recentOrders = new Map();
const webhookEvents = new Map();
const rateBuckets = new Map();

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
app.post("/webhook/razorpay", express.raw({ type: "application/json", limit: "256kb" }), (req, res) => {
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
    const eventId = req.get("x-razorpay-event-id") || crypto.createHash("sha256").update(req.body).digest("hex");

    cleanExpiredEntries(webhookEvents, 24 * 60 * 60 * 1000);
    if (webhookEvents.has(eventId)) {
      return res.json({ success: true, duplicate: true });
    }

    webhookEvents.set(eventId, {
      createdAt: Date.now(),
      event: event.event
    });

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
  allowedHeaders: ["Content-Type", "X-Request-ID", "X-Idempotency-Key"]
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

const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
  ? new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET
    })
  : null;

function requireRazorpayConfig(res) {
  if (!razorpay) {
    return res.status(503).json({
      success: false,
      message: "Payment gateway is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET on the backend."
    });
  }
  return null;
}

function getProduct(productId) {
  const product = PRODUCTS[productId];
  return product?.active ? product : null;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      success: false,
      message: "Admin API is not configured."
    });
  }

  const token = req.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized."
    });
  }

  return next();
}

app.get("/", (req, res) => {
  res.json({
    service: "ResumeCraft Payments API",
    status: "online",
    version: "2.0.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    razorpayConfigured: Boolean(razorpay),
    webhookConfigured: Boolean(RAZORPAY_WEBHOOK_SECRET),
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

app.get("/api/products", (req, res) => {
  return res.json({
    success: true,
    products: Object.values(PRODUCTS)
      .filter((product) => product.active)
      .map(({ id, name, description, amount, currency }) => ({
        id,
        name,
        description,
        amount,
        currency
      }))
  });
});

app.post("/create-order", async (req, res) => {
  const configurationError = requireRazorpayConfig(res);
  if (configurationError) return configurationError;

  const idempotencyKey = req.get("X-Idempotency-Key");
  cleanExpiredEntries(recentOrders, 10 * 60 * 1000);

  if (idempotencyKey) {
    const existing = recentOrders.get(idempotencyKey);
    if (existing) {
      return res.json(existing.response);
    }
  }

  try {
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
      email: typeof customer?.email === "string" ? customer.email.trim().slice(0, 160) : ""
    };

    if (safeCustomer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeCustomer.email)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address."
      });
    }

    const order = await razorpay.orders.create({
      amount: product.amount,
      currency: product.currency,
      receipt: `rcpt_${crypto.randomBytes(8).toString("hex")}`,
      notes: {
        productId: product.id,
        customerEmail: safeCustomer.email
      }
    });

    const response = {
      success: true,
      product,
      order
    };

    if (idempotencyKey) {
      recentOrders.set(idempotencyKey, {
        createdAt: Date.now(),
        response
      });
    }

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

    return res.json({
      success: true,
      message: "Payment verified",
      orderId: order.id,
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency
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

app.get("/admin/summary", requireAdmin, (req, res) => {
  return res.json({
    success: true,
    products: Object.values(PRODUCTS).length,
    activeProducts: Object.values(PRODUCTS).filter((product) => product.active).length,
    inMemoryRecentOrders: recentOrders.size,
    webhookEventsLast24h: webhookEvents.size
  });
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

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log(`Razorpay configured: ${Boolean(razorpay)}`);
  console.log(`Webhook configured: ${Boolean(RAZORPAY_WEBHOOK_SECRET)}`);
});
