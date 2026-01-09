const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();

const app = express();

// ==============================
// ✅ MIDDLEWARE
// ==============================
app.use(express.json());
app.use(cors({
  origin: "*",   // Allow all origins (or set your Vercel domain)
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// ==============================
// 🔎 DEBUG: CHECK ENV VARIABLES
// ==============================
console.log("RAZORPAY_KEY_ID:", process.env.RAZORPAY_KEY_ID);
console.log(
  "RAZORPAY_KEY_SECRET:",
  process.env.RAZORPAY_KEY_SECRET ? "Loaded" : "Missing"
);

// ==============================
// ✅ RAZORPAY INSTANCE
// ==============================
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ==============================
// 🟢 HEALTH CHECK
// ==============================
app.get("/", (req, res) => {
  res.send("✅ Razorpay Backend is Running");
});

// ===================================
// ✅ CREATE ORDER API
// ===================================
app.post("/create-order", async (req, res) => {
  try {
    console.log("➡️ Create Order Request Body:", req.body);

    const { amount, currency } = req.body;

    if (!amount || !currency) {
      return res.status(400).json({
        success: false,
        message: "Amount and currency are required"
      });
    }

    const options = {
      amount: amount, // 💯 from frontend
      currency: currency,
      receipt: "receipt_" + Date.now()
    };

    const order = await razorpay.orders.create(options);

    console.log("✅ Order created:", order.id);
    res.status(200).json(order);

  } catch (error) {
    console.error("❌ Create Order Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create order",
      error: error.error || error.message || error
    });
  }
});

// ===================================
// ✅ VERIFY PAYMENT API
// ===================================
app.post("/verify-payment", (req, res) => {
  try {
    console.log("➡️ Verify Payment Body:", req.body);

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Missing payment details"
      });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      console.log("✅ Payment verified successfully");

      return res.status(200).json({
        success: true,
        message: "Payment verified successfully"
      });
    } else {
      console.log("❌ Signature mismatch");

      return res.status(400).json({
        success: false,
        message: "Signature mismatch. Payment verification failed."
      });
    }

  } catch (error) {
    console.error("❌ Verify Payment Error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error during payment verification",
      error: error.message
    });
  }
});

// ===================================
// 🚀 START SERVER
// ===================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
