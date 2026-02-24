CREATE TABLE `admin_servers` (
	`id` binary(16) NOT NULL,
	`node_id` binary(16),
	`name` varchar(255) NOT NULL,
	`ip` varchar(45) NOT NULL,
	`ssh_port` int NOT NULL DEFAULT 22,
	`ssh_user` varchar(64) NOT NULL DEFAULT 'root',
	`ssh_key_encrypted` text NOT NULL,
	`ssh_key_iv` varchar(32) NOT NULL,
	`ssh_key_tag` varchar(32) NOT NULL,
	`provision_status` enum('pending','provisioning','completed','failed') NOT NULL DEFAULT 'pending',
	`provision_step` varchar(64),
	`provision_error` text,
	`provision_steps` json,
	`slots_total` int NOT NULL DEFAULT 4,
	`system_info` json,
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(6) NOT NULL DEFAULT (now()),
	CONSTRAINT `admin_servers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` binary(16) NOT NULL,
	`org_id` varchar(36) NOT NULL,
	`actor_id` varchar(36) NOT NULL,
	`action` varchar(64) NOT NULL,
	`resource_type` varchar(32) NOT NULL,
	`resource_id` varchar(64) NOT NULL,
	`metadata` text,
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `node_metrics` (
	`id` binary(16) NOT NULL,
	`node_id` binary(16) NOT NULL,
	`cpu_percent` float NOT NULL,
	`memory_used_bytes` bigint NOT NULL,
	`memory_total_bytes` bigint NOT NULL,
	`disk_used_bytes` bigint NOT NULL,
	`disk_total_bytes` bigint NOT NULL,
	`network_rx_bytes` bigint NOT NULL,
	`network_tx_bytes` bigint NOT NULL,
	`load_avg_1` float NOT NULL,
	`load_avg_5` float NOT NULL,
	`load_avg_15` float NOT NULL,
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	CONSTRAINT `node_metrics_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `org_usage` (
	`org_id` varchar(36) NOT NULL,
	`period_start` timestamp(6) NOT NULL,
	`sandbox_minutes` bigint NOT NULL DEFAULT 0,
	`exec_count` bigint NOT NULL DEFAULT 0,
	`storage_bytes` bigint NOT NULL DEFAULT 0,
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(6) NOT NULL DEFAULT (now()),
	CONSTRAINT `org_usage_org_id_period_start_pk` PRIMARY KEY(`org_id`,`period_start`)
);
--> statement-breakpoint
ALTER TABLE `execs` MODIFY COLUMN `updated_at` timestamp(6) NOT NULL DEFAULT (now());--> statement-breakpoint
ALTER TABLE `images` MODIFY COLUMN `updated_at` timestamp(6) NOT NULL DEFAULT (now());--> statement-breakpoint
ALTER TABLE `nodes` MODIFY COLUMN `updated_at` timestamp(6) NOT NULL DEFAULT (now());--> statement-breakpoint
ALTER TABLE `org_quotas` MODIFY COLUMN `updated_at` timestamp(6) NOT NULL DEFAULT (now());--> statement-breakpoint
ALTER TABLE `profiles` MODIFY COLUMN `updated_at` timestamp(6) NOT NULL DEFAULT (now());--> statement-breakpoint
ALTER TABLE `sandboxes` MODIFY COLUMN `failure_reason` enum('capacity_timeout','node_lost','provision_failed','sandbox_stopped','sandbox_deleted','ttl_exceeded','idle_timeout','queue_timeout');--> statement-breakpoint
ALTER TABLE `sandboxes` MODIFY COLUMN `updated_at` timestamp(6) NOT NULL DEFAULT (now());--> statement-breakpoint
ALTER TABLE `org_quotas` ADD `replay_retention_days` int DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `replay_public` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `replay_expires_at` timestamp(6);--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `last_activity_at` timestamp(6);--> statement-breakpoint
CREATE INDEX `idx_org_created` ON `audit_logs` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_org_action` ON `audit_logs` (`org_id`,`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_org_resource` ON `audit_logs` (`org_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `idx_node_metrics_node_id` ON `node_metrics` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_node_metrics_created_at` ON `node_metrics` (`created_at`);