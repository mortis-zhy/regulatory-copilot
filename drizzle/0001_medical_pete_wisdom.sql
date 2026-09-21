CREATE TABLE `comparison_changes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`comparisonId` int NOT NULL,
	`mappingId` int,
	`changeKey` varchar(80) NOT NULL,
	`title` varchar(255) NOT NULL,
	`changeType` enum('added','removed','rewritten','numeric','condition','reference','structural','editorial') NOT NULL,
	`severity` enum('info','low','medium','high') NOT NULL DEFAULT 'info',
	`confidence` int NOT NULL,
	`oldExcerpt` text,
	`newExcerpt` text,
	`explanation` text,
	`reviewStatus` enum('pending','confirmed','false_positive','expert_review') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `comparison_changes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `regulatory_clauses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`documentId` int NOT NULL,
	`stableKey` varchar(160) NOT NULL,
	`clauseNumber` varchar(80),
	`title` varchar(255),
	`level` int NOT NULL,
	`body` text NOT NULL,
	`pageNumber` int,
	`parentId` int,
	`parseConfidence` int,
	CONSTRAINT `regulatory_clauses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `comparison_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`sourceDocumentId` int NOT NULL,
	`targetDocumentId` int NOT NULL,
	`status` enum('draft','aligning','content_diff','research','review','frozen','failed') NOT NULL DEFAULT 'draft',
	`rulesetVersion` varchar(80) NOT NULL,
	`modelVersion` varchar(120),
	`progress` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `comparison_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `regulatory_documents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int,
	`title` varchar(255) NOT NULL,
	`documentNumber` varchar(120),
	`issuer` varchar(180),
	`version` varchar(80) NOT NULL,
	`documentType` enum('regulation','standard','guidance','internal','research') NOT NULL DEFAULT 'regulation',
	`sourceUrl` text,
	`storageKey` text,
	`fingerprint` varchar(128) NOT NULL,
	`parsingStatus` enum('queued','processing','complete','needs_review','failed') NOT NULL DEFAULT 'queued',
	`effectiveDate` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `regulatory_documents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `research_evidence` (
	`id` int AUTO_INCREMENT NOT NULL,
	`comparisonId` int,
	`changeId` int,
	`title` varchar(255) NOT NULL,
	`sourceName` varchar(180) NOT NULL,
	`sourceUrl` text,
	`sourceLevel` enum('official','standards_body','certification','industry','secondary') NOT NULL,
	`excerpt` text,
	`retrievedAt` timestamp NOT NULL DEFAULT (now()),
	`approved` int NOT NULL DEFAULT 0,
	CONSTRAINT `research_evidence_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `clause_mappings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`comparisonId` int NOT NULL,
	`sourceClauseId` int NOT NULL,
	`targetClauseId` int NOT NULL,
	`relationType` enum('one_to_one','one_to_many','many_to_one','none') NOT NULL,
	`confidence` int NOT NULL,
	`reviewStatus` enum('candidate','confirmed','rejected') NOT NULL DEFAULT 'candidate',
	`rationale` text,
	CONSTRAINT `clause_mappings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `comparison_projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`domain` varchar(120) NOT NULL,
	`status` enum('draft','running','review','frozen','archived') NOT NULL DEFAULT 'draft',
	`ownerId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `comparison_projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `comparison_reports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`comparisonId` int NOT NULL,
	`version` varchar(40) NOT NULL,
	`status` enum('draft','review','frozen','archived') NOT NULL DEFAULT 'draft',
	`contentFingerprint` varchar(128) NOT NULL,
	`generatedBy` int NOT NULL,
	`generatedAt` timestamp NOT NULL DEFAULT (now()),
	`frozenAt` timestamp,
	CONSTRAINT `comparison_reports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `change_comparison_idx` ON `comparison_changes` (`comparisonId`);--> statement-breakpoint
CREATE INDEX `change_review_idx` ON `comparison_changes` (`reviewStatus`);--> statement-breakpoint
CREATE INDEX `clause_document_idx` ON `regulatory_clauses` (`documentId`);--> statement-breakpoint
CREATE INDEX `clause_stable_idx` ON `regulatory_clauses` (`stableKey`);--> statement-breakpoint
CREATE INDEX `comparison_project_idx` ON `comparison_runs` (`projectId`);--> statement-breakpoint
CREATE INDEX `document_project_idx` ON `regulatory_documents` (`projectId`);--> statement-breakpoint
CREATE INDEX `document_fingerprint_idx` ON `regulatory_documents` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `evidence_change_idx` ON `research_evidence` (`changeId`);--> statement-breakpoint
CREATE INDEX `evidence_comparison_idx` ON `research_evidence` (`comparisonId`);--> statement-breakpoint
CREATE INDEX `mapping_comparison_idx` ON `clause_mappings` (`comparisonId`);--> statement-breakpoint
CREATE INDEX `project_owner_idx` ON `comparison_projects` (`ownerId`);--> statement-breakpoint
CREATE INDEX `report_comparison_idx` ON `comparison_reports` (`comparisonId`);