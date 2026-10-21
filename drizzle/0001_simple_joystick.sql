CREATE TABLE `merchant_provider_profiles` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`search_endpoint` text NOT NULL,
	`payout_address` text NOT NULL,
	`price_atomic` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `merchant_operations` ADD `reconciliation_json` text;