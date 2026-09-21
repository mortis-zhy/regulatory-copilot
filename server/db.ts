import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, changes, comparisons, documents, evidence, projects, reports, users } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  textFields.forEach(field => {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  });
  if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
  if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function listProjects() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(projects).orderBy(desc(projects.updatedAt));
}

export async function listDocuments(projectId?: number) {
  const db = await getDb();
  if (!db) return [];
  return projectId ? db.select().from(documents).where(eq(documents.projectId, projectId)).orderBy(desc(documents.updatedAt)) : db.select().from(documents).orderBy(desc(documents.updatedAt));
}

export async function listChanges(comparisonId?: number) {
  const db = await getDb();
  if (!db) return [];
  return comparisonId ? db.select().from(changes).where(eq(changes.comparisonId, comparisonId)).orderBy(desc(changes.createdAt)) : db.select().from(changes).orderBy(desc(changes.createdAt));
}

export async function listEvidence(comparisonId?: number) {
  const db = await getDb();
  if (!db) return [];
  return comparisonId ? db.select().from(evidence).where(eq(evidence.comparisonId, comparisonId)).orderBy(desc(evidence.retrievedAt)) : db.select().from(evidence).orderBy(desc(evidence.retrievedAt));
}

export async function createProject(input: { name: string; description?: string; domain: string; ownerId: number }) {
  const db = await getDb();
  if (!db) return { id: 0, ...input, status: "draft" as const };
  const result = await db.insert(projects).values(input);
  return { id: Number(result[0].insertId), ...input, status: "draft" as const };
}

export async function reviewChange(id: number, reviewStatus: "pending" | "confirmed" | "false_positive" | "expert_review") {
  const db = await getDb();
  if (!db) return false;
  await db.update(changes).set({ reviewStatus }).where(eq(changes.id, id));
  return true;
}

export async function getPlatformCounts() {
  const db = await getDb();
  if (!db) return { projects: 0, documents: 0, pendingChanges: 0, reports: 0 };
  const [projectCount, documentCount, pendingCount, reportCount] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(projects),
    db.select({ count: sql<number>`count(*)` }).from(documents),
    db.select({ count: sql<number>`count(*)` }).from(changes).where(eq(changes.reviewStatus, "pending")),
    db.select({ count: sql<number>`count(*)` }).from(reports),
  ]);
  return { projects: Number(projectCount[0]?.count ?? 0), documents: Number(documentCount[0]?.count ?? 0), pendingChanges: Number(pendingCount[0]?.count ?? 0), reports: Number(reportCount[0]?.count ?? 0) };
}

export { comparisons };
