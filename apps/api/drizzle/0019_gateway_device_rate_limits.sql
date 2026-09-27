CREATE TABLE "gw_device_rate_limits" (
  "identity" text PRIMARY KEY,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "count" integer NOT NULL DEFAULT 1
);
CREATE INDEX "gw_device_rate_limits_started_idx" ON "gw_device_rate_limits" ("started_at");
