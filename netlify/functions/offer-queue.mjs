import { createPool } from "../../server/db.mjs";
import { refreshOfferQueues } from "../../server/offer-queue.mjs";

export default async () => {
  const pool = createPool();
  let db;
  try {
    db = await pool.connect();
    const processed = await refreshOfferQueues(db);
    console.log(JSON.stringify({ task: "offer-queue", processed }));
    return new Response(null, { status: 204 });
  } finally {
    db?.release();
    await pool.end();
  }
};

export const config = { schedule: "* * * * *" };
