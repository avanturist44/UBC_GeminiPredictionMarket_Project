CREATE TABLE "sandbox_orders" (
	"trade_id" uuid PRIMARY KEY NOT NULL,
	"agent_key" text NOT NULL,
	"client_order_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"order_id" text,
	"sandbox_price" numeric(10, 4),
	"filled_quantity" numeric(18, 4),
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_orders_status" CHECK ("sandbox_orders"."status" in ('pending', 'filled', 'partial', 'unfilled', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "sandbox_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandbox_orders" ADD CONSTRAINT "sandbox_orders_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_orders_client_order_id_unique" ON "sandbox_orders" USING btree ("client_order_id");