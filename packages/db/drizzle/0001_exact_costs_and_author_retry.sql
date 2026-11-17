DROP INDEX "trades_one_author_position_per_thesis";--> statement-breakpoint
ALTER TABLE "agent_state" ALTER COLUMN "realized_pnl_usd" SET DATA TYPE numeric(16, 4);--> statement-breakpoint
ALTER TABLE "agent_state" ALTER COLUMN "realized_pnl_usd" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "agent_state" ALTER COLUMN "open_exposure_usd" SET DATA TYPE numeric(16, 4);--> statement-breakpoint
ALTER TABLE "agent_state" ALTER COLUMN "open_exposure_usd" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "cost_usd" SET DATA TYPE numeric(16, 4);--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "payout_usd" SET DATA TYPE numeric(16, 4);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "paper_balance_usd" SET DATA TYPE numeric(16, 4);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "paper_balance_usd" SET DEFAULT '1000';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "max_per_trade_usd" SET DATA TYPE numeric(16, 4);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "max_per_trade_usd" SET DEFAULT '10';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "daily_copy_cap_usd" SET DATA TYPE numeric(16, 4);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "daily_copy_cap_usd" SET DEFAULT '25';--> statement-breakpoint
CREATE UNIQUE INDEX "trades_one_author_position_per_thesis" ON "trades" USING btree ("thesis_id") WHERE "trades"."is_author_position" and "trades"."status" <> 'rejected';