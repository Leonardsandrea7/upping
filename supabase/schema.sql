-- ============================================================
-- LS Cambios P2P — Esquema de base de datos (Supabase / Postgres)
-- Ejecuta este archivo completo en el SQL Editor de tu proyecto Supabase.
-- ============================================================

create extension if not exists "pgcrypto";

-- ============================================================
-- USUARIOS (extiende auth.users de Supabase)
-- ============================================================
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  cedula text,
  whatsapp text,
  role text not null default 'client', -- client | liquidator | admin
  kyc_status text not null default 'unverified', -- unverified | pending | verified | rejected
  kyc_selfie_url text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- MÉTODOS DE PAGO SOPORTADOS (catálogo simple, editable desde admin)
-- ============================================================
create table payment_methods (
  id text primary key, -- 'paypal' | 'binance' | 'zinli' | 'wally' | 'airtm' | 'usdt_bep20' | 'pago_movil'
  label text not null,
  active boolean not null default true
);

insert into payment_methods (id, label) values
  ('paypal', 'PayPal'),
  ('binance', 'Binance'),
  ('zinli', 'Zinli'),
  ('wally', 'Wally'),
  ('airtm', 'Airtm'),
  ('usdt_bep20', 'USDT BEP20'),
  ('pago_movil', 'Pago Móvil (Bs)');

-- ============================================================
-- TASAS (se guarda historial, no solo el valor actual)
-- ============================================================
create table rates (
  id uuid primary key default gen_random_uuid(),
  payment_method_id text not null references payment_methods(id),
  direction text not null, -- 'buy' (Bs -> divisa) | 'sell' (divisa -> Bs)
  rate numeric(18,6) not null,
  set_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index rates_lookup on rates (payment_method_id, direction, created_at desc);

-- ============================================================
-- LIQUIDADORES
-- ============================================================
create table liquidators (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references profiles(id),
  status text not null default 'pending', -- pending | active | suspended | banned
  payment_methods text[] not null default '{}', -- ids de payment_methods que acepta
  max_concurrent_ops integer not null default 3,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references profiles(id)
);

-- ============================================================
-- COLATERAL
-- ============================================================
create table collateral_accounts (
  id uuid primary key default gen_random_uuid(),
  liquidator_id uuid not null unique references liquidators(id),
  currency text not null default 'USDT',
  total_balance numeric(18,2) not null default 0,
  locked_balance numeric(18,2) not null default 0,
  updated_at timestamptz not null default now()
);

create table collateral_transactions (
  id uuid primary key default gen_random_uuid(),
  collateral_account_id uuid not null references collateral_accounts(id),
  operation_id uuid, -- FK añadida abajo, después de crear operations
  type text not null, -- deposit | withdraw | lock | unlock | slash
  amount numeric(18,2) not null,
  reason text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- REPUTACIÓN
-- ============================================================
create table reputation_scores (
  liquidator_id uuid primary key references liquidators(id),
  completed_ops integer not null default 0,
  disputed_ops integer not null default 0,
  disputes_lost integer not null default 0,
  avg_response_seconds integer,
  avg_completion_seconds integer,
  total_volume_usd numeric(18,2) not null default 0,
  score numeric(3,2) not null default 5.00,
  updated_at timestamptz not null default now()
);

create table reputation_events (
  id uuid primary key default gen_random_uuid(),
  liquidator_id uuid not null references liquidators(id),
  operation_id uuid,
  event_type text not null, -- completed | dispute_opened | dispute_lost | dispute_won | late_response
  created_at timestamptz not null default now()
);

-- ============================================================
-- OPERACIONES
-- ============================================================
create table operations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id),
  liquidator_id uuid references liquidators(id),
  kind text not null, -- 'sell' (cliente vende divisa, recibe Bs) | 'buy' (cliente compra divisa, envía Bs)
  payment_method_id text not null references payment_methods(id),
  amount_sent numeric(18,2) not null,
  amount_received numeric(18,2) not null,
  rate_applied numeric(18,6) not null,
  status text not null default 'pending_match',
  -- pending_match -> matched -> awaiting_payment -> payment_sent ->
  -- liquidator_verifying -> liquidator_paying -> completed
  -- (o dispute_opened en cualquier punto después de matched)
  collateral_locked numeric(18,2),
  platform_fee_bps integer,        -- comisión aplicada a esta operación (ej. 150 = 1.5%)
  platform_fee_amount numeric(18,6), -- monto exacto de comisión, en USDT
  onchain_tx_hash text,            -- hash de la transacción de liberación en la blockchain
  proof_url text, -- comprobante del cliente
  matched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table collateral_transactions
  add constraint fk_collateral_tx_operation
  foreign key (operation_id) references operations(id);

alter table reputation_events
  add constraint fk_reputation_event_operation
  foreign key (operation_id) references operations(id);

-- ============================================================
-- CHAT P2P (por operación)
-- ============================================================
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references operations(id),
  sender_id uuid not null references profiles(id),
  body text,
  attachment_url text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- DISPUTAS
-- ============================================================
create table disputes (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique references operations(id),
  opened_by uuid not null references profiles(id),
  reason text not null,
  evidence jsonb default '[]',
  status text not null default 'open', -- open | resolved_client | resolved_liquidator | resolved_split
  resolution_notes text,
  resolved_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- ============================================================
-- COMISIÓN DE LA PLATAFORMA (reporte — la fuente de verdad es la
-- blockchain, esta tabla es una copia para reportes rápidos)
-- ============================================================
create table platform_revenue (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references operations(id),
  fee_amount numeric(18,6) not null,
  fee_bps integer not null,
  onchain_tx_hash text,
  created_at timestamptz not null default now()
);
create index platform_revenue_date_idx on platform_revenue (created_at);

-- ============================================================
-- REFERIDOS (se mantiene del modelo actual)
-- ============================================================
create table referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references profiles(id),
  referred_id uuid not null references profiles(id),
  qualified boolean not null default false,
  reward_usd numeric(6,2) not null default 2.00,
  paid boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ÍNDICES ÚTILES
-- ============================================================
create index operations_status_idx on operations (status);
create index operations_liquidator_idx on operations (liquidator_id);
create index chat_operation_idx on chat_messages (operation_id, created_at);

-- ============================================================
-- ROW LEVEL SECURITY (activar antes de ir a producción)
-- ============================================================
alter table profiles enable row level security;
alter table operations enable row level security;
alter table chat_messages enable row level security;
alter table disputes enable row level security;
alter table collateral_accounts enable row level security;
alter table reputation_scores enable row level security;

-- Políticas básicas (ajustar según necesidad real):
create policy "Users can view own profile" on profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

create policy "Client sees own operations" on operations for select
  using (auth.uid() = client_id or auth.uid() = (select profile_id from liquidators where id = liquidator_id));

create policy "Chat visible to operation participants" on chat_messages for select
  using (
    exists (
      select 1 from operations o
      left join liquidators l on l.id = o.liquidator_id
      where o.id = operation_id
      and (o.client_id = auth.uid() or l.profile_id = auth.uid())
    )
  );

create policy "Reputation is public" on reputation_scores for select using (true);
