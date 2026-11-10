import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

logger.info(
  { service: "bizora-worker" },
  "Worker idle in Sprint 1. Job processors will land with payments, inventory and AI.",
);

setInterval(() => {
  logger.debug("worker heartbeat");
}, 30_000);
