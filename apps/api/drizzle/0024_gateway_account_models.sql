ALTER TABLE "gw_upstreams" ADD COLUMN "supported_models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "gw_upstreams" ADD COLUMN "default_model" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Preserve every explicitly configured Node route model, including disabled routes.
-- Do not infer a default model or claim discovery results as administrator configuration.
UPDATE "gw_upstreams" AS u
SET "supported_models" = (
  SELECT coalesce(jsonb_agg(model ORDER BY model), '[]'::jsonb)
  FROM (
    SELECT DISTINCT btrim(v.model) AS model
    FROM "gw_routes" AS r
    CROSS JOIN LATERAL (VALUES (r.upstream_model), (r.vision_model)) AS v(model)
    WHERE r.upstream_id = u.id AND nullif(btrim(v.model), '') IS NOT NULL
  ) AS configured
);
