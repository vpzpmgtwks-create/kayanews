// Scheduled rebuild: keeps the static Market Brief fresh.
//
// Netlify runs this function on a cron schedule; it POSTs to a Netlify
// Build Hook, which triggers a new build (re-running build_static.py with
// fresh news/prices/sentiment).
//
// SETUP (one time):
//   1. Netlify site → Site configuration → Build & deploy → Build hooks →
//      "Add build hook". Copy the URL it gives you.
//   2. Netlify site → Site configuration → Environment variables →
//      add  BUILD_HOOK_URL  =  <that URL>
//
// Change the schedule below to taste ("@hourly", "@daily", or cron syntax).

export const config = {
  schedule: "0 * * * *", // every hour, on the hour (UTC)
};

export default async () => {
  const url = process.env.BUILD_HOOK_URL;
  if (!url) {
    return new Response("BUILD_HOOK_URL env var is not set", { status: 500 });
  }
  await fetch(url, { method: "POST" });
  return new Response("Rebuild triggered");
};
