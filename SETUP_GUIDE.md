# ResumeCraft Payments API — Production Setup

## Current architecture

```
Vercel storefront
      |
      v
Render Node/Express API
      |
      +--> Razorpay Checkout + API
      |
      +--> PostgreSQL (production schema)
      |
      +--> Private object storage (digital products)
      |
      +--> Email / invoice provider
```

## Environment

Set these variables in Render:

```env
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
FRONTEND_URL=https://your-frontend.vercel.app
ADMIN_TOKEN=long_random_secret
DATABASE_URL=your_postgresql_connection_string
PORT=10000
NODE_ENV=production
```

Never commit real credentials.

## API

- GET `/` — service metadata
- GET `/health` — health/configuration status
- GET `/api/razorpay-key` — public Razorpay key
- GET `/api/products` — active product catalog
- POST `/create-order` — server-priced Razorpay order
- POST `/verify-payment` — signature + Razorpay payment verification
- POST `/webhook/razorpay` — signed Razorpay webhook receiver
- GET `/admin/summary` — protected operational summary

### Create order

```json
{
  "productId": "modern-resume-pack",
  "customer": {
    "name": "Customer Name",
    "email": "customer@example.com"
  }
}
```

The client cannot choose the amount or currency.

Send an `X-Idempotency-Key` header for retry-safe order creation. The current fallback cache is in-memory; enable the database layer before relying on it for multi-instance production traffic.

## Razorpay webhook

Configure the Razorpay dashboard to POST events to:

```
https://YOUR-BACKEND/webhook/razorpay
```

Use the same value as `RAZORPAY_WEBHOOK_SECRET`. The endpoint validates the exact raw body with HMAC SHA-256 and rejects duplicate event IDs during the active process.

For durable event history and multi-instance processing, persist webhook events using `schema.sql`.

## Database

`schema.sql` defines products, customers, orders, webhook events, downloads, coupons and audit logs.

Run it against PostgreSQL before enabling durable commerce workflows.

## Security

- Server-owned pricing
- Signature verification
- Webhook signature verification
- Request size limits
- Basic API rate limiting
- CORS allow-list
- Security response headers
- Request IDs
- Idempotency foundation
- Admin token protection

Before accepting real customers, add a persistent database, protected object storage, email delivery, automated tests, monitoring and a production Razorpay account.

## Local testing

```bash
npm install
npm start
```

Then:

```
GET http://localhost:10000/health
GET http://localhost:10000/api/products
```
