import serverless from "serverless-http";
import { app } from "../../server/app.mjs";
const wrapped = serverless(app, { binary: ["application/pdf"] });
export async function handler(event, context) {
  const original = event.path || "/";
  if (original.startsWith("/.netlify/functions/api"))
    event.path = "/api" + original.slice("/.netlify/functions/api".length);
  return wrapped(event, context);
}
