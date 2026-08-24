import Redis from "ioredis";

export type TurnEvent = {
  turnId: string;
  projectId: string;
  status: string;
};

export type TurnEventPublisher = {
  publishTurnEvent(event: TurnEvent): Promise<void>;
  close(): Promise<void>;
};

export type TurnEventConsumer = {
  readTurnEvent(turnId: string, lastId: string, blockMs: number): Promise<{ id: string; event: TurnEvent } | null>;
  close(): Promise<void>;
};

const STREAM_PREFIX = "turn-events:";

function streamKey(turnId: string) {
  return `${STREAM_PREFIX}${turnId}`;
}

export function createTurnEventPublisher(redis: Redis): TurnEventPublisher {
  return {
    async publishTurnEvent(event) {
      await redis.xadd(streamKey(event.turnId), "*", "payload", JSON.stringify(event));
    },
    async close() {
      redis.disconnect();
    },
  };
}

export function createTurnEventConsumer(redis: Redis): TurnEventConsumer {
  return {
    async readTurnEvent(turnId, lastId, blockMs) {
      const response = await redis.xread("BLOCK", blockMs, "STREAMS", streamKey(turnId), lastId);
      if (!response?.[0]?.[1]?.length) return null;
      const [id, fields] = response[0][1][0];
      const payloadIndex = fields.findIndex((field) => field === "payload");
      if (payloadIndex < 0 || !fields[payloadIndex + 1]) throw new Error("Malformed turn event");
      return { id, event: JSON.parse(fields[payloadIndex + 1]) };
    },
    async close() {
      redis.disconnect();
    },
  };
}
