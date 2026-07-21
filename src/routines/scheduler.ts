/**
 * Task scheduler — user-defined recurring tasks (e.g. "boost these products
 * every day"). Persists tasks to disk so they survive restarts/redeploys, and
 * registers a cron job per task. When a task fires it runs the stored
 * instruction through the matching specialist agent (autonomously, since the
 * seller pre-approved it by scheduling) and reports the result to Telegram.
 */
import cron from "node-cron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../core/logger.js";

export type ScheduledAgent = "operating" | "promoting";

export interface ScheduledTask {
  id: string;
  cron: string; // standard cron expression, interpreted in the shop timezone
  agent: ScheduledAgent;
  instruction: string; // natural-language instruction the agent runs
  description: string; // short human label for listings
  createdAt: string;
  lastRunAt: string | null;
}

/** Runs a stored instruction on a specialist agent, returns its text result. */
export type TaskExecutor = (agent: ScheduledAgent, instruction: string) => Promise<string>;
/** Sends a report (HTML) to the seller. */
export type TaskReporter = (text: string) => Promise<void>;

/**
 * Persist next to the routine-state file so it lands on the same disk. On
 * Render, ROUTINE_STATE_PATH points at the persistent /data volume; without
 * this, schedules would default to the repo's ephemeral .data/ and be wiped on
 * every redeploy.
 */
const SCHEDULES_PATH =
  process.env.SCHEDULES_PATH ??
  (process.env.ROUTINE_STATE_PATH
    ? resolve(dirname(process.env.ROUTINE_STATE_PATH), "schedules.json")
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".data", "schedules.json"));

type CronTask = ReturnType<typeof cron.schedule>;

function genId(): string {
  return `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class TaskScheduler {
  private tasks = new Map<string, ScheduledTask>();
  private crons = new Map<string, CronTask>();

  constructor(
    private readonly tz: string,
    private readonly executor: TaskExecutor,
    private readonly reporter: TaskReporter,
  ) {
    this.load();
  }

  /** Register cron jobs for all persisted tasks. Call once on startup. */
  registerAll(): void {
    for (const task of this.tasks.values()) this.registerCron(task);
    logger.info("scheduler registered tasks", { count: this.tasks.size });
  }

  add(input: { cron: string; agent: ScheduledAgent; instruction: string; description: string }): ScheduledTask {
    if (!cron.validate(input.cron)) {
      throw new Error(`Invalid cron expression: "${input.cron}"`);
    }
    const task: ScheduledTask = {
      id: genId(),
      cron: input.cron,
      agent: input.agent,
      instruction: input.instruction,
      description: input.description,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
    };
    this.tasks.set(task.id, task);
    this.registerCron(task);
    this.save();
    logger.info("scheduled task added", { id: task.id, cron: task.cron, agent: task.agent });
    return task;
  }

  remove(id: string): boolean {
    this.crons.get(id)?.stop();
    this.crons.delete(id);
    const existed = this.tasks.delete(id);
    if (existed) this.save();
    return existed;
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()];
  }

  private registerCron(task: ScheduledTask): void {
    this.crons.get(task.id)?.stop();
    const c = cron.schedule(task.cron, () => void this.fire(task.id), { timezone: this.tz });
    this.crons.set(task.id, c);
  }

  private async fire(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;
    logger.info("scheduled task firing", { id, agent: task.agent, description: task.description });
    try {
      const instruction =
        `SCHEDULED TASK — the seller pre-approved this recurring task when they created it, ` +
        `so execute the actions directly now and do NOT ask for confirmation. Task: ${task.instruction}`;
      const result = await this.executor(task.agent, instruction);
      task.lastRunAt = new Date().toISOString();
      this.save();
      await this.reporter(`⏰ <b>Scheduled: ${escapeHtml(task.description)}</b>\n\n${escapeHtml(result)}`);
    } catch (err) {
      logger.error("scheduled task failed", { id, error: (err as Error).message });
      await this.reporter(
        `⏰ <b>Scheduled task failed: ${escapeHtml(task.description)}</b>\n\nError: ${escapeHtml((err as Error).message)}`,
      );
    }
  }

  private load(): void {
    try {
      const arr = JSON.parse(readFileSync(SCHEDULES_PATH, "utf-8")) as ScheduledTask[];
      for (const t of arr) this.tasks.set(t.id, t);
      logger.info("scheduler loaded tasks from disk", { count: arr.length });
    } catch {
      // no schedules file yet — fine
    }
  }

  private save(): void {
    mkdirSync(dirname(SCHEDULES_PATH), { recursive: true });
    writeFileSync(SCHEDULES_PATH, JSON.stringify([...this.tasks.values()], null, 2));
  }
}
