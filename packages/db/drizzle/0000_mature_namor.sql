CREATE TABLE `artifacts` (
	`id` binary(16) NOT NULL,
	`sandbox_id` binary(16) NOT NULL,
	`org_id` varchar(36) NOT NULL,
	`exec_id` binary(16),
	`name` varchar(512) NOT NULL,
	`mime` varchar(255) NOT NULL,
	`bytes` bigint NOT NULL,
	`sha256` char(64) NOT NULL,
	`ref` varchar(1024) NOT NULL,
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	`retention_until` timestamp(6),
	CONSTRAINT `artifacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `execs` (
	`id` binary(16) NOT NULL,
	`sandbox_id` binary(16) NOT NULL,
	`org_id` varchar(36) NOT NULL,
	`session_id` binary(16),
	`seq` int NOT NULL,
	`cmd` text NOT NULL,
	`cmd_format` enum('array','shell') NOT NULL DEFAULT 'array',
	`cwd` varchar(1024),
	`env` json,
	`status` enum('queued','running','done','failed','timed_out') NOT NULL DEFAULT 'queued',
	`exit_code` int,
	`cpu_ms` bigint,
	`peak_memory_bytes` bigint,
	`duration_ms` bigint,
	`log_ref` varchar(1024),
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(6) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`started_at` timestamp(6),
	`ended_at` timestamp(6),
	CONSTRAINT `execs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`idem_key` varchar(64) NOT NULL,
	`org_id` varchar(36) NOT NULL,
	`status` enum('processing','completed') NOT NULL DEFAULT 'processing',
	`response_status` int,
	`response_body` mediumtext,
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	CONSTRAINT `idempotency_keys_idem_key` PRIMARY KEY(`idem_key`)
);
--> statement-breakpoint
CREATE TABLE `images` (
	`id` binary(16) NOT NULL,
	`os_version` varchar(64) NOT NULL,
	`toolchain` varchar(64) NOT NULL,
	`kernel_ref` varchar(1024) NOT NULL,
	`rootfs_ref` varchar(1024) NOT NULL,
	`snapshot_ref` varchar(1024),
	`digest` char(64) NOT NULL,
	`size_bytes` bigint NOT NULL,
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(6) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`deprecated_at` timestamp(6),
	CONSTRAINT `images_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_image` UNIQUE(`os_version`,`toolchain`)
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` binary(16) NOT NULL,
	`name` varchar(255) NOT NULL,
	`hostname` varchar(255) NOT NULL,
	`slots_total` smallint NOT NULL DEFAULT 4,
	`status` enum('online','offline','draining','disabled') NOT NULL DEFAULT 'offline',
	`version` varchar(64),
	`firecracker_version` varchar(64),
	`capabilities` json,
	`last_seen_at` timestamp(6),
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(6) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `nodes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `org_quotas` (
	`org_id` varchar(36) NOT NULL,
	`max_concurrent_sandboxes` int NOT NULL DEFAULT 10,
	`max_ttl_seconds` int NOT NULL DEFAULT 14400,
	`max_exec_timeout_seconds` int NOT NULL DEFAULT 7200,
	`artifact_retention_days` int NOT NULL DEFAULT 30,
	`rate_sandbox_create_per_min` int NOT NULL DEFAULT 30,
	`rate_exec_per_min` int NOT NULL DEFAULT 120,
	`rate_read_per_min` int NOT NULL DEFAULT 600,
	`idle_timeout_seconds` int NOT NULL DEFAULT 900,
	`max_fork_depth` int NOT NULL DEFAULT 5,
	`max_forks_per_sandbox` int NOT NULL DEFAULT 10,
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(6) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `org_quotas_org_id` PRIMARY KEY(`org_id`)
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` binary(16) NOT NULL,
	`name` varchar(32) NOT NULL,
	`cpu_cores` smallint NOT NULL,
	`memory_mb` int NOT NULL,
	`disk_gb` int NOT NULL,
	`description` varchar(255),
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(6) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `profiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `profiles_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `sandbox_sessions` (
	`id` binary(16) NOT NULL,
	`sandbox_id` binary(16) NOT NULL,
	`org_id` varchar(36) NOT NULL,
	`shell` varchar(255) NOT NULL DEFAULT '/bin/bash',
	`status` enum('running','destroyed') NOT NULL DEFAULT 'running',
	`env` json,
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	`destroyed_at` timestamp(6),
	CONSTRAINT `sandbox_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sandboxes` (
	`id` binary(16) NOT NULL,
	`org_id` varchar(36) NOT NULL,
	`node_id` binary(16),
	`image_id` binary(16) NOT NULL,
	`profile_id` binary(16) NOT NULL,
	`profile_name` varchar(32) NOT NULL,
	`status` enum('queued','provisioning','running','stopping','stopped','failed','deleted') NOT NULL DEFAULT 'queued',
	`env` json,
	`forked_from` binary(16),
	`fork_depth` tinyint NOT NULL DEFAULT 0,
	`fork_count` smallint NOT NULL DEFAULT 0,
	`ttl_seconds` int NOT NULL DEFAULT 3600,
	`failure_reason` enum('capacity_timeout','node_lost','provision_failed','sandbox_stopped','sandbox_deleted','ttl_exceeded'),
	`replay_bundle_ref` varchar(1024),
	`created_at` timestamp(6) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(6) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`started_at` timestamp(6),
	`ended_at` timestamp(6),
	CONSTRAINT `sandboxes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_sandbox_created` ON `artifacts` (`sandbox_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sandbox_name` ON `artifacts` (`sandbox_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_org_retention` ON `artifacts` (`org_id`,`retention_until`);--> statement-breakpoint
CREATE INDEX `idx_sandbox_seq` ON `execs` (`sandbox_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_org` ON `idempotency_keys` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_created_at` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_status` ON `nodes` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sandbox_status` ON `sandbox_sessions` (`sandbox_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_org_status_created` ON `sandboxes` (`org_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_org_created` ON `sandboxes` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_node_status` ON `sandboxes` (`node_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_status_ended` ON `sandboxes` (`status`,`ended_at`);--> statement-breakpoint
CREATE INDEX `idx_forked_from` ON `sandboxes` (`forked_from`);