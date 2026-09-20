require("dotenv").config();
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;

const PRODUCTS = {
  "modern-resume-pack": {
    name: "Modern Resume Pack",
    amount: 9900,
    currency: "INR"
  }
};

app.use(express.json({ limit: "16kb" }));

const allowedOrigins = [
  FRONTEND_URL,
  "http://localhost:5500",
  "http://127.0.0.1:5500"
].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS."));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));



app.use((err, req, res, next) => {
  if (err?.message === "Origin not allowed by CORS.") {
    return res.status(403).json({
      success: false,
      message: "This origin is not allowed to access the payment service."
    });
  }
  return next(err);
});
\nconst razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
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

app.get("/", (req, res) => {
  res.send("Razorpay Backend Running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    razorpayConfigured: Boolean(razorpay)
  });
});

app.get("/api/razorpay-key", (req, res) => {
  if (!RAZORPAY_KEY_ID) {
    return res.status(503).json({
      success: false,
      message: "Razorpay public key is not configured on the backend."
    });
  }

  res.json({
    success: true,
    key: RAZORPAY_KEY_ID
  });
});

app.post("/create-order", async (req, res) => {
  const configurationError = requireRazorpayConfig(res);
  if (configurationError) return configurationError;

  try {
    const { productId } = req.body;
    const product = PRODUCTS[productId];

    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Invalid product."
      });
    }

    const order = await razorpay.orders.create({
      amount: product.amount,
      currency: product.currency,
      receipt: `rcpt_${crypto.randomBytes(8).toString("hex")}`,
      notes: {
        productId
      }
    });

    return res.status(200).json({
      success: true,
      product,
      order
    });
  } catch (err) {
    console.error("Create Order Error:", {
      statusCode: err.statusCode,
      code: err.error?.code,
      description: err.error?.description || err.message
    });

    return res.status(502).json({
      success: false,
      message: "Razorpay could not create the order. Check the backend Razorpay credentials and account status."
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
      statusCode: err.statusCode,
      code: err.error?.code,
      description: err.error?.description || err.message
    });

    return res.status(500).json({
      success: false,
      message: "Payment verification failed."
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
