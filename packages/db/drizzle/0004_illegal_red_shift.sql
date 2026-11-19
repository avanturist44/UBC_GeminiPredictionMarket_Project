CREATE INDEX "theses_author_created_idx" ON "theses" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "thesis_jobs_started_idx" ON "thesis_jobs" USING btree ("started_at");