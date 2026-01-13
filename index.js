// ==============================
// 🔐 LOAD ENV
// ==============================
require("dotenv").config();

// ==============================
// 📦 IMPORTS
// ==============================
const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");

// ==============================
// 🚀 APP INIT
// ==============================
const app = express();

// ==============================
// ✅ MIDDLEWARE
// ==============================
app.use(express.json());
app.use(cors({
  origin: "*",   // Change to your frontend URL in production
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// ==============================
// 🔎 DEBUG ENV VARIABLES
// ==============================
console.log("KEY ID:", process.env.RAZORPAY_KEY_ID ? "SET" : "MISSING");
console.log("KEY SECRET:", process.env.RAZORPAY_KEY_SECRET ? "SET" : "MISSING");

// ==============================
// 💳 RAZORPAY INSTANCE
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

app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK" });
});

// ===================================
// 🧾 CREATE ORDER
// ===================================
app.post("/create-order", async (req, res) => {
  try {
    console.log("➡️ Create Order Request:", req.body);

    const { amount, currency } = req.body;

    if (!amount || !currency) {
      return res.status(400).json({
        success: false,
        message: "Amount and currency are required"
      });
    }

    const options = {
      amount: amount,        // in paise (₹99 = 9900)
      currency: currency,
      receipt: "receipt_" + Date.now()
    };

    const order = await razorpay.orders.create(options);

    console.log("✅ Order Created:", order.id);

    res.status(200).json({
      success: true,
      order
    });

  } catch (error) {
    console.error("❌ Create Order Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create order",
      error: error.message
    });
  }
});

// ===================================
// 🔐 VERIFY PAYMENT
// ===================================
app.post("/verify-payment", (req, res) => {
  try {
    console.log("➡️ Verify Payment:", req.body);

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
      console.log("✅ Payment Verified");

      return res.status(200).json({
        success: true,
        message: "Payment verified successfully"
      });
    } else {
      console.log("❌ Signature Mismatch");

      return res.status(400).json({
        success: false,
        message: "Payment verification failed"
      });
    }

  } catch (error) {
    console.error("❌ Verify Error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error during verification",
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
