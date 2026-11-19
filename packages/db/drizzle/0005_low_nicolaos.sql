CREATE TABLE "chain_actions" (
	"key" text PRIMARY KEY NOT NULL,
	"idempotency_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"wallet_id" text NOT NULL,
	"contract_address" text NOT NULL,
	"call_data" text,
	"amount_usdc" numeric(12, 6),
	"destination" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"circle_tx_id" text,
	"tx_hash" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chain_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chain_control" (
	"id" integer PRIMARY KEY NOT NULL,
	CONSTRAINT "chain_control_singleton" CHECK ("chain_control"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "chain_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "copy_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"thesis_id" uuid NOT NULL,
	"amount_usd" numeric(16, 4) NOT NULL,
	"tip_usdc" numeric(12, 6) NOT NULL,
	"trade_id" uuid NOT NULL,
	"tip_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copy_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "thesis_registrations" (
	"thesis_id" uuid PRIMARY KEY NOT NULL,
	"escrow_address" text NOT NULL,
	"author_address" text NOT NULL,
	"market_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"expiry_at" timestamp with time zone NOT NULL,
	"action_key" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thesis_registrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wallet_accounts" (
	"owner_key" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"author_id" uuid,
	"create_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"circle_wallet_id" text,
	"address" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_accounts_one_owner" CHECK (("wallet_accounts"."user_id" is null) <> ("wallet_accounts"."author_id" is null))
);
--> statement-breakpoint
ALTER TABLE "wallet_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tips" ADD COLUMN "trade_id" uuid;--> statement-breakpoint
ALTER TABLE "copy_requests" ADD CONSTRAINT "copy_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_requests" ADD CONSTRAINT "copy_requests_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_requests" ADD CONSTRAINT "copy_requests_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_requests" ADD CONSTRAINT "copy_requests_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis_registrations" ADD CONSTRAINT "thesis_registrations_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis_registrations" ADD CONSTRAINT "thesis_registrations_action_key_chain_actions_key_fk" FOREIGN KEY ("action_key") REFERENCES "public"."chain_actions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chain_actions_idempotency_unique" ON "chain_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "chain_actions_status_created_idx" ON "chain_actions" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_requests_trade_unique" ON "copy_requests" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "copy_requests_user_created_idx" ON "copy_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_user_unique" ON "wallet_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_author_unique" ON "wallet_accounts" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_circle_unique" ON "wallet_accounts" USING btree ("circle_wallet_id");--> statement-breakpoint
CREATE INDEX "wallet_accounts_status_idx" ON "wallet_accounts" USING btree ("status");--> statement-breakpoint
ALTER TABLE "tips" ADD CONSTRAINT "tips_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tips_trade_unique" ON "tips" USING btree ("trade_id");