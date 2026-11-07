-- PayPal capture IDs are unique: duplicate webhook deliveries cannot inflate totals.
CREATE TABLE IF NOT EXISTS donations (
  capture_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  cents INTEGER NOT NULL CHECK (cents > 0),
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refunds (
  refund_id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  cents INTEGER NOT NULL CHECK (cents > 0),
  received_at TEXT NOT NULL,
  FOREIGN KEY (capture_id) REFERENCES donations(capture_id)
);
CREATE INDEX IF NOT EXISTS idx_refunds_capture ON refunds(capture_id);
