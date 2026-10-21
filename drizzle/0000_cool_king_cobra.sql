CREATE TABLE `merchant_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`query` text NOT NULL,
	`mode` text NOT NULL,
	`phase` text NOT NULL,
	`unit_price_atomic` text NOT NULL,
	`amount_atomic` text DEFAULT '0' NOT NULL,
	`result_json` text,
	`transaction_id` text,
	`error_code` text,
	`authorization_id` text,
	`authorization_json` text,
	`claim_token` text NOT NULL,
	`phase_expires_at` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "merchant_operations_mode_check" CHECK("merchant_operations"."mode" IN ('sandbox','live')),
	CONSTRAINT "merchant_operations_phase_check" CHECK("merchant_operations"."phase" IN ('authorizing','executing','settling','succeeded','failed','unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_operations_owner_key` ON `merchant_operations` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_operations_authorization` ON `merchant_operations` (`authorization_id`);--> statement-breakpoint
CREATE INDEX `merchant_operations_owner_history` ON `merchant_operations` (`owner_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `merchant_operations_owner_expiry` ON `merchant_operations` (`owner_id`,`phase_expires_at`) WHERE "merchant_operations"."phase" IN ('authorizing','executing','settling');--> statement-breakpoint
CREATE TABLE `merchant_sandbox_limits` (
	`owner_id` text NOT NULL,
	`day` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`owner_id`, `day`)
);
