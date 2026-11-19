ALTER TABLE "authors" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tips" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pending_max_per_trade_usd" numeric(16, 4);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pending_daily_copy_cap_usd" numeric(16, 4);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "limits_effective_at" timestamp with time zone;