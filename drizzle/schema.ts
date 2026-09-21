import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, index } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const projects = mysqlTable("comparison_projects", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  domain: varchar("domain", { length: 120 }).notNull(),
  status: mysqlEnum("status", ["draft", "running", "review", "frozen", "archived"]).default("draft").notNull(),
  ownerId: int("ownerId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({ ownerIdx: index("project_owner_idx").on(table.ownerId) }));

export const documents = mysqlTable("regulatory_documents", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId"),
  title: varchar("title", { length: 255 }).notNull(),
  documentNumber: varchar("documentNumber", { length: 120 }),
  issuer: varchar("issuer", { length: 180 }),
  version: varchar("version", { length: 80 }).notNull(),
  documentType: mysqlEnum("documentType", ["regulation", "standard", "guidance", "internal", "research"]).default("regulation").notNull(),
  sourceUrl: text("sourceUrl"),
  storageKey: text("storageKey"),
  fingerprint: varchar("fingerprint", { length: 128 }).notNull(),
  parsingStatus: mysqlEnum("parsingStatus", ["queued", "processing", "complete", "needs_review", "failed"]).default("queued").notNull(),
  effectiveDate: timestamp("effectiveDate"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({ projectIdx: index("document_project_idx").on(table.projectId), fingerprintIdx: index("document_fingerprint_idx").on(table.fingerprint) }));

export const clauses = mysqlTable("regulatory_clauses", {
  id: int("id").autoincrement().primaryKey(),
  documentId: int("documentId").notNull(),
  stableKey: varchar("stableKey", { length: 160 }).notNull(),
  clauseNumber: varchar("clauseNumber", { length: 80 }),
  title: varchar("title", { length: 255 }),
  level: int("level").notNull(),
  body: text("body").notNull(),
  pageNumber: int("pageNumber"),
  parentId: int("parentId"),
  parseConfidence: int("parseConfidence"),
}, table => ({ documentIdx: index("clause_document_idx").on(table.documentId), stableIdx: index("clause_stable_idx").on(table.stableKey) }));

export const comparisons = mysqlTable("comparison_runs", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull(),
  sourceDocumentId: int("sourceDocumentId").notNull(),
  targetDocumentId: int("targetDocumentId").notNull(),
  status: mysqlEnum("status", ["draft", "aligning", "content_diff", "research", "review", "frozen", "failed"]).default("draft").notNull(),
  rulesetVersion: varchar("rulesetVersion", { length: 80 }).notNull(),
  modelVersion: varchar("modelVersion", { length: 120 }),
  progress: int("progress").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({ projectIdx: index("comparison_project_idx").on(table.projectId) }));

export const mappings = mysqlTable("clause_mappings", {
  id: int("id").autoincrement().primaryKey(),
  comparisonId: int("comparisonId").notNull(),
  sourceClauseId: int("sourceClauseId").notNull(),
  targetClauseId: int("targetClauseId").notNull(),
  relationType: mysqlEnum("relationType", ["one_to_one", "one_to_many", "many_to_one", "none"]).notNull(),
  confidence: int("confidence").notNull(),
  reviewStatus: mysqlEnum("reviewStatus", ["candidate", "confirmed", "rejected"]).default("candidate").notNull(),
  rationale: text("rationale"),
}, table => ({ comparisonIdx: index("mapping_comparison_idx").on(table.comparisonId) }));

export const changes = mysqlTable("comparison_changes", {
  id: int("id").autoincrement().primaryKey(),
  comparisonId: int("comparisonId").notNull(),
  mappingId: int("mappingId"),
  changeKey: varchar("changeKey", { length: 80 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  changeType: mysqlEnum("changeType", ["added", "removed", "rewritten", "numeric", "condition", "reference", "structural", "editorial"]).notNull(),
  severity: mysqlEnum("severity", ["info", "low", "medium", "high"]).default("info").notNull(),
  confidence: int("confidence").notNull(),
  oldExcerpt: text("oldExcerpt"),
  newExcerpt: text("newExcerpt"),
  explanation: text("explanation"),
  reviewStatus: mysqlEnum("reviewStatus", ["pending", "confirmed", "false_positive", "expert_review"]).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => ({ comparisonIdx: index("change_comparison_idx").on(table.comparisonId), reviewIdx: index("change_review_idx").on(table.reviewStatus) }));

export const evidence = mysqlTable("research_evidence", {
  id: int("id").autoincrement().primaryKey(),
  comparisonId: int("comparisonId"),
  changeId: int("changeId"),
  title: varchar("title", { length: 255 }).notNull(),
  sourceName: varchar("sourceName", { length: 180 }).notNull(),
  sourceUrl: text("sourceUrl"),
  sourceLevel: mysqlEnum("sourceLevel", ["official", "standards_body", "certification", "industry", "secondary"]).notNull(),
  excerpt: text("excerpt"),
  retrievedAt: timestamp("retrievedAt").defaultNow().notNull(),
  approved: int("approved").default(0).notNull(),
}, table => ({ changeIdx: index("evidence_change_idx").on(table.changeId), comparisonIdx: index("evidence_comparison_idx").on(table.comparisonId) }));

export const reports = mysqlTable("comparison_reports", {
  id: int("id").autoincrement().primaryKey(),
  comparisonId: int("comparisonId").notNull(),
  version: varchar("version", { length: 40 }).notNull(),
  status: mysqlEnum("status", ["draft", "review", "frozen", "archived"]).default("draft").notNull(),
  contentFingerprint: varchar("contentFingerprint", { length: 128 }).notNull(),
  generatedBy: int("generatedBy").notNull(),
  generatedAt: timestamp("generatedAt").defaultNow().notNull(),
  frozenAt: timestamp("frozenAt"),
}, table => ({ comparisonIdx: index("report_comparison_idx").on(table.comparisonId) }));

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type Comparison = typeof comparisons.$inferSelect;
export type Change = typeof changes.$inferSelect;
export type Evidence = typeof evidence.$inferSelect;
export type Report = typeof reports.$inferSelect;
