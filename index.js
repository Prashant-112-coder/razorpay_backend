require("dotenv").config();
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

app.use(express.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

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
    const { amount, currency = "INR" } = req.body;

    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be a positive integer in paise."
      });
    }

    if (currency !== "INR") {
      return res.status(400).json({
        success: false,
        message: "Only INR payments are supported."
      });
    }

    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt: "rcpt_" + Date.now()
    });

    return res.status(200).json({
      success: true,
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

app.post("/verify-payment", (req, res) => {
  if (!RAZORPAY_KEY_SECRET) {
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

    if (crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(razorpay_signature)
    )) {
      return res.json({
        success: true,
        message: "Payment verified"
      });
    }

    return res.status(400).json({
      success: false,
      message: "Invalid payment signature."
    });
  } catch (err) {
    console.error("Verify Error:", err);
    return res.status(500).json({
      success: false,
      message: "Payment verification failed."
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
