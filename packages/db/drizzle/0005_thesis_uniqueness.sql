DROP INDEX "theses_one_live_per_author_market";--> statement-breakpoint
CREATE UNIQUE INDEX "theses_one_auditing_per_author" ON "theses" USING btree ("author_id") WHERE "theses"."status" = 'auditing';--> statement-breakpoint
CREATE UNIQUE INDEX "theses_one_live_per_author_market" ON "theses" USING btree ("author_id","market_id") WHERE "theses"."status" in ('auditing', 'published', 'resolved');