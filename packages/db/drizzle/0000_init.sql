CREATE TYPE "public"."agent_decision" AS ENUM('trade', 'skip');--> statement-breakpoint
CREATE TYPE "public"."audit_verdict" AS ENUM('pass', 'flagged', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."author_kind" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TYPE "public"."outcome_side" AS ENUM('yes', 'no');--> statement-breakpoint
CREATE TYPE "public"."price_source" AS ENUM('ws', 'rest', 'backfill');--> statement-breakpoint
CREATE TYPE "public"."thesis_outcome" AS ENUM('right', 'wrong', 'void');--> statement-breakpoint
CREATE TYPE "public"."thesis_status" AS ENUM('draft', 'auditing', 'blocked', 'published', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."tip_status" AS ENUM('pending', 'escrowed', 'paid', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."trading_mode" AS ENUM('paper', 'gemini');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_key" text NOT NULL,
	"market_id" uuid,
	"decision" "agent_decision" NOT NULL,
	"reason" text,
	"signal" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_state" (
	"agent_key" text NOT NULL,
	"day" date NOT NULL,
	"realized_pnl_usd" numeric(14, 2) DEFAULT '0' NOT NULL,
	"open_exposure_usd" numeric(14, 2) DEFAULT '0' NOT NULL,
	"trade_count" integer DEFAULT 0 NOT NULL,
	"halted" boolean DEFAULT false NOT NULL,
	"halt_reason" text,
	CONSTRAINT "agent_state_agent_key_day_pk" PRIMARY KEY("agent_key","day")
);
--> statement-breakpoint
CREATE TABLE "audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thesis_id" uuid NOT NULL,
	"verdict" "audit_verdict" NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inside_info" boolean DEFAULT false NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "author_kind" NOT NULL,
	"user_id" uuid,
	"agent_key" text,
	"display_name" text NOT NULL,
	"strategy_summary" text,
	"wallet_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authors_kind_matches_owner" CHECK (("authors"."kind" = 'agent' and "authors"."agent_key" is not null and "authors"."user_id" is null)
        or ("authors"."kind" = 'human' and "authors"."user_id" is not null and "authors"."agent_key" is null))
);
--> statement-breakpoint
CREATE TABLE "gemini_connections" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"terms_accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_symbol" text NOT NULL,
	"event_ticker" text NOT NULL,
	"contract_ticker" text NOT NULL,
	"title" text NOT NULL,
	"contract_label" text,
	"category" text,
	"expiry_at" timestamp with time zone,
	"status" text,
	"market_state" text,
	"strike" numeric,
	"yes_bid" numeric(10, 4),
	"yes_ask" numeric(10, 4),
	"last_price" numeric(10, 4),
	"resolution_side" "outcome_side",
	"resolved_at" timestamp with time zone,
	"tracked" boolean DEFAULT false NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quantity_increment" numeric,
	"quantity_minimum" numeric,
	"price_increment" numeric,
	"source_details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"yes_bid" numeric(10, 4),
	"yes_ask" numeric(10, 4),
	"last_price" numeric(10, 4),
	"source" "price_source" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "theses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"onchain_id" text NOT NULL,
	"author_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"side" "outcome_side" NOT NULL,
	"probability_yes" numeric(10, 4) NOT NULL,
	"headline" text NOT NULL,
	"body" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entry_price" numeric(10, 4),
	"market_yes_price_at_publish" numeric(10, 4),
	"content_hash" text,
	"register_tx" text,
	"status" "thesis_status" DEFAULT 'draft' NOT NULL,
	"outcome" "thesis_outcome",
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "theses_headline_length" CHECK (char_length("theses"."headline") <= 90),
	CONSTRAINT "theses_body_length" CHECK (char_length("theses"."body") <= 1200),
	CONSTRAINT "theses_probability_range" CHECK ("theses"."probability_yes" >= 0 and "theses"."probability_yes" <= 1)
);
--> statement-breakpoint
CREATE TABLE "tips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thesis_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_usdc" numeric(12, 6) NOT NULL,
	"circle_tx_id" text,
	"deposit_tx" text,
	"status" "tip_status" DEFAULT 'pending' NOT NULL,
	"settle_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tips_amount_positive" CHECK ("tips"."amount_usdc" > 0)
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"author_id" uuid,
	"market_id" uuid NOT NULL,
	"thesis_id" uuid,
	"is_author_position" boolean DEFAULT false NOT NULL,
	"side" "outcome_side" NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"price" numeric(10, 4) NOT NULL,
	"cost_usd" numeric(14, 2) NOT NULL,
	"mode" "trading_mode" NOT NULL,
	"gemini_order_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"locked" boolean DEFAULT true NOT NULL,
	"payout_usd" numeric(14, 2),
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trades_has_owner" CHECK ("trades"."user_id" is not null or "trades"."author_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"is_guest" boolean DEFAULT true NOT NULL,
	"trading_mode" "trading_mode" DEFAULT 'paper' NOT NULL,
	"paper_balance_usd" numeric(14, 2) DEFAULT '1000' NOT NULL,
	"max_per_trade_usd" numeric(14, 2) DEFAULT '10' NOT NULL,
	"daily_copy_cap_usd" numeric(14, 2) DEFAULT '25' NOT NULL,
	"circle_wallet_id" text,
	"wallet_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authors" ADD CONSTRAINT "authors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gemini_connections" ADD CONSTRAINT "gemini_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_points" ADD CONSTRAINT "price_points_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_agent_created_idx" ON "agent_runs" USING btree ("agent_key","created_at");--> statement-breakpoint
CREATE INDEX "audits_thesis_idx" ON "audits" USING btree ("thesis_id");--> statement-breakpoint
CREATE UNIQUE INDEX "authors_agent_key_unique" ON "authors" USING btree ("agent_key");--> statement-breakpoint
CREATE UNIQUE INDEX "authors_user_id_unique" ON "authors" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_instrument_symbol_unique" ON "markets" USING btree ("instrument_symbol");--> statement-breakpoint
CREATE INDEX "markets_event_ticker_idx" ON "markets" USING btree ("event_ticker");--> statement-breakpoint
CREATE INDEX "markets_tracked_expiry_idx" ON "markets" USING btree ("tracked","expiry_at");--> statement-breakpoint
CREATE INDEX "price_points_market_ts_idx" ON "price_points" USING btree ("market_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "theses_onchain_id_unique" ON "theses" USING btree ("onchain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "theses_one_live_per_author_market" ON "theses" USING btree ("author_id","market_id") WHERE "theses"."status" in ('published', 'resolved');--> statement-breakpoint
CREATE INDEX "theses_market_idx" ON "theses" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "theses_status_published_idx" ON "theses" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "tips_thesis_idx" ON "tips" USING btree ("thesis_id");--> statement-breakpoint
CREATE INDEX "tips_status_idx" ON "tips" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "trades_idempotency_key_unique" ON "trades" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "trades_one_author_position_per_thesis" ON "trades" USING btree ("thesis_id") WHERE "trades"."is_author_position";--> statement-breakpoint
CREATE INDEX "trades_user_created_idx" ON "trades" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "trades_market_idx" ON "trades" USING btree ("market_id");