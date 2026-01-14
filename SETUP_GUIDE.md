# 🚀 Razorpay Backend + Frontend Setup Guide

## ✅ Problem Resolved

The "❌ Order creation failed" error is typically caused by:
1. **Incorrect backend URL in frontend** (pointing to localhost instead of deployed URL)
2. **Missing Razorpay public key in frontend**
3. **CORS configuration issues**
4. **Invalid API credentials**

---

## 🔧 Backend Setup (Already Fixed!)

### Environment Variables (.env)
```env
RAZORPAY_KEY_ID=rzp_test_S0eeQglGbygi4C
RAZORPAY_KEY_SECRET=Qb92gpvUNWoHc7kob6GSThT4
PORT=10000
```

### New Endpoints Added:

#### 1. **GET** `/api/razorpay-key`
- **Purpose**: Fetch the public Razorpay key for the frontend
- **Response**: `{ "key": "rzp_test_..." }`

#### 2. **POST** `/create-order`
- **Body**: `{ "amount": 50000, "currency": "INR" }`
- **Response**: `{ "success": true, "order": {...} }`

#### 3. **POST** `/verify-payment`
- **Body**: `{ "razorpay_order_id": "...", "razorpay_payment_id": "...", "razorpay_signature": "..." }`
- **Response**: `{ "success": true, "message": "Payment verified" }`

---

## 💻 Frontend Setup

### Option 1: Use the Test Frontend (Provided)
Open `test-frontend.html` in your browser to test locally:
```bash
cd /workspaces/razorpay_backend
npx http-server
# Open http://localhost:8080/test-frontend.html
```

### Option 2: React Frontend Implementation

Create a React component:

```jsx
import React, { useState, useEffect } from 'react';

const RazorpayPayment = () => {
  const [amount, setAmount] = useState(500);
  const [loading, setLoading] = useState(false);
  const [razorpayKey, setRazorpayKey] = useState('');
  
  // Change this to your deployed backend URL
  const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'http://localhost:10000';

  useEffect(() => {
    // Fetch Razorpay public key
    fetch(`${BACKEND_URL}/api/razorpay-key`)
      .then(res => res.json())
      .then(data => setRazorpayKey(data.key))
      .catch(err => console.error('Failed to fetch key:', err));
  }, []);

  const handlePayment = async () => {
    if (!razorpayKey) {
      alert('Payment gateway not ready. Please refresh.');
      return;
    }

    setLoading(true);

    try {
      // Step 1: Create Order
      const orderRes = await fetch(`${BACKEND_URL}/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: amount * 100, // Convert to paise
          currency: 'INR'
        })
      });

      const orderData = await orderRes.json();

      if (!orderData.success) {
        throw new Error(orderData.message);
      }

      // Step 2: Open Razorpay Checkout
      const options = {
        key: razorpayKey,
        amount: amount * 100,
        currency: 'INR',
        name: 'Your Store Name',
        description: 'Product Description',
        order_id: orderData.order.id,
        handler: async (response) => {
          // Step 3: Verify Payment
          const verifyRes = await fetch(`${BACKEND_URL}/verify-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature
            })
          });

          const verifyData = await verifyRes.json();
          if (verifyData.success) {
            alert('✅ Payment Successful!');
          }
        },
        prefill: {
          name: 'Customer Name',
          email: 'customer@example.com',
          contact: '9999999999'
        },
        theme: { color: '#667eea' }
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (error) {
      console.error('Payment Error:', error);
      alert(`❌ ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <input
        type="number"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Enter amount"
      />
      <button onClick={handlePayment} disabled={loading}>
        {loading ? 'Processing...' : 'Pay Now'}
      </button>
    </div>
  );
};

export default RazorpayPayment;
```

Add to `.env`:
```
REACT_APP_BACKEND_URL=http://localhost:10000
```

Include Razorpay script in `public/index.html`:
```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
```

---

## 🚀 Deployment

### Backend Deployment (Node.js)

**Option A: Deploy to Render**
1. Push to GitHub ✅ (Already done)
2. Connect GitHub to Render
3. Create new Web Service
4. Set environment variables
5. Deploy

**Option B: Deploy to Railway/Heroku**
```bash
# Just push and deploy
git push heroku main
```

### Update Frontend with Deployed URL
```env
# .env file
REACT_APP_BACKEND_URL=https://your-deployed-backend.onrender.com
```

---

## 🧪 Testing

### Test Backend Locally:
```bash
curl -X POST http://localhost:10000/create-order \
  -H "Content-Type: application/json" \
  -d '{"amount": 50000, "currency": "INR"}'
```

### Expected Response:
```json
{
  "success": true,
  "order": {
    "id": "order_XXXXXXXXXX",
    "amount": 50000,
    "currency": "INR",
    "created_at": 1234567890
  }
}
```

---

## ⚠️ Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| CORS Error | Update `REACT_APP_BACKEND_URL` to correct domain |
| 404 on /create-order | Restart backend server `npm start` |
| Missing KEY error | Check `.env` file has `RAZORPAY_KEY_ID` |
| Signature mismatch | Ensure `RAZORPAY_KEY_SECRET` is correct |
| Payment won't open | Check browser console for Razorpay script load errors |

---

## 📋 Checklist

- ✅ Backend running on port 10000
- ✅ `.env` has valid Razorpay credentials
- ✅ CORS properly configured
- ✅ Frontend connected to correct backend URL
- ✅ Razorpay script loaded in frontend
- ✅ `/api/razorpay-key` endpoint accessible

---

## 📞 Support

If you still get "❌ Order creation failed":
1. Check browser **Console** for errors (F12)
2. Check terminal for backend errors
3. Verify backend URL in frontend
4. Ensure Razorpay API keys are active

