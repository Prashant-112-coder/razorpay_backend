-- ResumeCraft production data model
-- Run this on PostgreSQL when DATABASE_URL is provisioned.
-- Money is stored as integer minor units (paise for INR).

create table if not exists products (
  id text primary key,
  name text not null,
  description text not null default '',
  amount integer not null check (amount >= 0),
  currency char(3) not null default 'INR',
  active boolean not null default true,
  download_object_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid references customers(id),
  product_id text not null references products(id),
  status text not null check (status in ('CREATED','PENDING','PAID','FAILED','REFUNDED','CANCELLED')),
  amount integer not null check (amount >= 0),
  currency char(3) not null,
  razorpay_order_id text unique,
  razorpay_payment_id text unique,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists webhook_events (
  id bigserial primary key,
  event_id text not null unique,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz not null default now()
);

create table if not exists downloads (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  token_hash text not null unique,
  download_count integer not null default 0,
  max_downloads integer not null default 5,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_downloaded_at timestamptz
);

create table if not exists coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  discount_percent integer check (discount_percent between 1 and 100),
  discount_amount integer check (discount_amount >= 0),
  active boolean not null default true,
  max_uses integer,
  used_count integer not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  check ((discount_percent is not null) <> (discount_amount is not null))
);

create table if not exists audit_logs (
  id bigserial primary key,
  actor text not null,
  action text not null,
  resource_type text,
  resource_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_created_at on orders(created_at desc);
create index if not exists idx_webhook_events_type on webhook_events(event_type);
create index if not exists idx_downloads_order_id on downloads(order_id);

insert into products (id, name, description, amount, currency, active)
values (
  'modern-resume-pack',
  'Modern Resume Pack',
  'Clean, editable and ATS-friendly resume resources.',
  9900,
  'INR',
  true
)
on conflict (id) do nothing;
