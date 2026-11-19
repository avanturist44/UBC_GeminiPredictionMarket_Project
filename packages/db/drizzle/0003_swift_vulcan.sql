CREATE TABLE "audit_control" (
	"id" integer PRIMARY KEY NOT NULL,
	CONSTRAINT "audit_control_singleton" CHECK ("audit_control"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "audit_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session_windows" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"window_at" timestamp with time zone NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "thesis_jobs" (
	"thesis_id" uuid PRIMARY KEY NOT NULL,
	"stake_usd" numeric(16, 4) NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thesis_jobs_stake_range" CHECK ("thesis_jobs"."stake_usd" >= 1 and "thesis_jobs"."stake_usd" <= 10)
);
--> statement-breakpoint
ALTER TABLE "thesis_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_windows" ADD CONSTRAINT "session_windows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis_jobs" ADD CONSTRAINT "thesis_jobs_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thesis_jobs_status_created_idx" ON "thesis_jobs" USING btree ("status","created_at");