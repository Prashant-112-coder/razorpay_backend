# Razorpay Backend Setup Guide

## Backend configuration

Set these variables in your local `.env` file or in the Render service environment:

```env
RAZORPAY_KEY_ID=your_razorpay_test_key_id
RAZORPAY_KEY_SECRET=your_razorpay_test_key_secret
PORT=10000
```

**Never commit real Razorpay credentials to GitHub.** If a real secret has ever been committed to a public repository, rotate it in the Razorpay dashboard and update the deployment with the new value.

## Endpoints

### GET `/`
Basic backend availability check.

### GET `/health`
Returns backend health and whether Razorpay configuration is present.

### GET `/api/razorpay-key`
Returns the public Razorpay key ID for frontend checkout initialization. The secret is never returned.

### POST `/create-order`
Creates a Razorpay order.

Request:

```json
{
  "amount": 9900,
  "currency": "INR"
}
```

The amount is expressed in paise.

### POST `/verify-payment`
Verifies the Razorpay checkout signature on the backend.

## Render deployment

For the Render web service, configure:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`

Keep the existing build command:

```
npm install
```

and start command:

```
npm start
```

After changing environment variables, redeploy the service and verify:

```
GET /health
```

The response should report `"status": "OK"` and `"razorpayConfigured": true`.

## Testing

Create an order:

```bash
curl -X POST https://your-backend.onrender.com/create-order ^
  -H "Content-Type: application/json" ^
  -d "{\"amount\":9900,\"currency\":\"INR\"}"
```

Expected successful response:

```json
{
  "success": true,
  "order": {
    "id": "order_...",
    "amount": 9900,
    "currency": "INR"
  }
}
```

## Frontend integration

The frontend should fetch `/api/razorpay-key` instead of hard-coding the key ID. Payment success should only be displayed after `/verify-payment` returns a successful response.

## Security checklist

- Never commit `.env` files.
- Never expose `RAZORPAY_KEY_SECRET` in frontend code.
- Rotate any credential that has been exposed publicly.
- Do not treat checkout completion as payment verification.