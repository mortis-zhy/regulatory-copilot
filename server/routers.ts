import { COOKIE_NAME } from "@shared/const";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { createProject, getPlatformCounts, listChanges, listDocuments, listEvidence, listProjects, reviewChange } from "./db";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  platform: router({
    counts: publicProcedure.query(() => getPlatformCounts()),
    projects: publicProcedure.query(() => listProjects()),
    documents: publicProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(({ input }) => listDocuments(input?.projectId)),
    changes: publicProcedure.input(z.object({ comparisonId: z.number().optional() }).optional()).query(({ input }) => listChanges(input?.comparisonId)),
    evidence: publicProcedure.input(z.object({ comparisonId: z.number().optional() }).optional()).query(({ input }) => listEvidence(input?.comparisonId)),
    createProject: publicProcedure.input(z.object({ name: z.string().min(2), description: z.string().optional(), domain: z.string().min(2), ownerId: z.number().default(1) })).mutation(({ input }) => createProject(input)),
    reviewChange: publicProcedure.input(z.object({ id: z.number(), reviewStatus: z.enum(["pending", "confirmed", "false_positive", "expert_review"]) })).mutation(({ input }) => reviewChange(input.id, input.reviewStatus)),
  }),
});

export type AppRouter = typeof appRouter;
