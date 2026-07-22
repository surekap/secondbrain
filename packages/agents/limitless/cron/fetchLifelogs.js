require("dotenv").config({ path: require("path").resolve(__dirname, "../../../../.env.local") });
const pool = require("@secondbrain/db");
const { getLifelogs } = require("../services/limitless");

const DEFAULT_SETTLE_DELAY_MS = 10000;
const DEFAULT_SETTLE_STABLE_PASSES = 2;
const DEFAULT_SETTLE_MAX_REFRESHES = 6;

function toApiDate(date) {
  return date.toISOString().slice(0, 10);
}

function toDatetimeStr(value) {
  return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

function parseDateInput(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label}: "${value}"`);
  }
  return parsed;
}

async function saveLifelogsToDB(logs) {
  const conn = await pool.connect();

  try {
    for (const log of logs) {
      const startValue = log.startTime || log.start_time || log.start;
      const endValue = log.endTime || log.end_time || log.end;
      const startTime = startValue ? toDatetimeStr(startValue) : null;
      const endTime = endValue ? toDatetimeStr(endValue) : null;
      const contents = log.contents ?? "";

      await conn.query(
        `INSERT INTO limitless.lifelogs (id, title, start_time, end_time, contents, markdown) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          contents = EXCLUDED.contents,
          markdown = EXCLUDED.markdown,
          updated_at = CASE
            WHEN limitless.lifelogs.title IS DISTINCT FROM EXCLUDED.title
              OR limitless.lifelogs.start_time IS DISTINCT FROM EXCLUDED.start_time
              OR limitless.lifelogs.end_time IS DISTINCT FROM EXCLUDED.end_time
              OR limitless.lifelogs.contents IS DISTINCT FROM EXCLUDED.contents
              OR limitless.lifelogs.markdown IS DISTINCT FROM EXCLUDED.markdown
            THEN CURRENT_TIMESTAMP
            ELSE limitless.lifelogs.updated_at
          END`,
        [
          log.id,
          log.title,
          startTime,
          endTime,
          JSON.stringify(contents),
          log.markdown || "",
        ]
      );
    }
  } finally {
    console.log("All lifelogs saved to database.");
    conn.release();
  }
}

function lifelogSnapshot(logs = []) {
  return JSON.stringify(
    logs.map((log) => ({
      id: log.id,
      title: log.title || null,
      start: log.startTime || log.start_time || log.start || null,
      end: log.endTime || log.end_time || log.end || null,
      contents: log.contents ?? null,
      markdown: log.markdown || "",
    })).sort((left, right) => String(left.id).localeCompare(String(right.id)))
  );
}

async function settleLatestWindow({
  fetchWindow,
  save = saveLifelogsToDB,
  initialLogs = [],
  delayMs = DEFAULT_SETTLE_DELAY_MS,
  stablePasses = DEFAULT_SETTLE_STABLE_PASSES,
  maxRefreshes = DEFAULT_SETTLE_MAX_REFRESHES,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let previousSnapshot = lifelogSnapshot(initialLogs);
  let consecutiveStablePasses = 0;

  for (let refresh = 1; refresh <= maxRefreshes; refresh += 1) {
    await wait(delayMs);
    const logs = await fetchWindow();
    if (logs.length > 0) await save(logs);

    const snapshot = lifelogSnapshot(logs);
    if (snapshot === previousSnapshot) consecutiveStablePasses += 1;
    else consecutiveStablePasses = 0;

    if (consecutiveStablePasses >= stablePasses) {
      return { settled: true, refreshes: refresh, logs };
    }
    previousSnapshot = snapshot;
  }

  return { settled: false, refreshes: maxRefreshes, logs: initialLogs };
}

async function getLatestStartTime() {
  const conn = await pool.connect();
  try {
    const { rows } = await conn.query(
      `SELECT MAX(start_time) AS latest_start_time FROM limitless.lifelogs`
    );
    return rows[0]?.latest_start_time || null;
  } finally {
    conn.release();
  }
}

async function run(options = {}) {
  const days = parseInt(process.env.FETCH_DAYS || "10", 10);
  const windowDays = parseInt(process.env.FETCH_WINDOW_DAYS || "30", 10);
  const timezone = process.env.LIMITLESS_TIMEZONE || "UTC";
  const endDate = process.env.FETCH_END_DATE
    ? parseDateInput(process.env.FETCH_END_DATE, "FETCH_END_DATE")
    : new Date();
  const defaultStartDate = new Date(endDate);
  defaultStartDate.setDate(endDate.getDate() - days);

  const latestStartTime = await getLatestStartTime();
  console.log("latest start time:", latestStartTime);
  const startDate = process.env.FETCH_START_DATE
    ? parseDateInput(process.env.FETCH_START_DATE, "FETCH_START_DATE")
    : latestStartTime
      ? new Date(latestStartTime)
      : defaultStartDate;

  if (startDate > endDate) {
    console.log("Start date is after end date. Nothing to fetch.");
    return { fetched: 0, saved: 0, windows: 0 };
  }

  console.log(
    `Fetching lifelogs from ${toApiDate(startDate)} to ${toApiDate(endDate)} in ${windowDays}-day windows (${timezone}).`
  );

  let totalFetched = 0;
  let totalSaved = 0;
  let windows = 0;
  let windowStart = new Date(startDate);
  let latestWindow = null;

  while (windowStart <= endDate) {
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + Math.max(1, windowDays) - 1);
    if (windowEnd > endDate) {
      windowEnd.setTime(endDate.getTime());
    }

    const apiStart = toApiDate(windowStart);
    const apiEnd = toApiDate(windowEnd);
    windows += 1;
    console.log(`Fetching window: ${apiStart} -> ${apiEnd}`);

    const lifelogs = await getLifelogs({
      apiKey: process.env.LIMITLESS_API_KEY,
      start: apiStart,
      end: apiEnd,
      timezone,
      direction: "asc",
      limit: null,
    });
    latestWindow = { apiStart, apiEnd, lifelogs };

    totalFetched += lifelogs.length;
    if (lifelogs.length > 0) {
      console.log(`Saving ${lifelogs.length} lifelogs from window...`);
      await saveLifelogsToDB(lifelogs);
      totalSaved += lifelogs.length;
    } else {
      console.log("No lifelogs in this window.");
    }

    windowStart = new Date(windowEnd);
    windowStart.setDate(windowStart.getDate() + 1);
  }

  let settlement = { settled: true, refreshes: 0 };
  if (latestWindow) {
    const settleDelayMs = Number.parseInt(process.env.LIMITLESS_SETTLE_DELAY_MS || String(DEFAULT_SETTLE_DELAY_MS), 10);
    const settleStablePasses = Number.parseInt(process.env.LIMITLESS_SETTLE_STABLE_PASSES || String(DEFAULT_SETTLE_STABLE_PASSES), 10);
    const settleMaxRefreshes = Number.parseInt(process.env.LIMITLESS_SETTLE_MAX_REFRESHES || String(DEFAULT_SETTLE_MAX_REFRESHES), 10);
    console.log(`Waiting for the newest Limitless window to settle (${settleStablePasses} quiet checks).`);
    settlement = await settleLatestWindow({
      initialLogs: latestWindow.lifelogs,
      delayMs: Math.max(0, settleDelayMs),
      stablePasses: Math.max(1, settleStablePasses),
      maxRefreshes: Math.max(1, settleMaxRefreshes),
      wait: options.wait,
      save: options.save || saveLifelogsToDB,
      fetchWindow: () => (options.getLifelogs || getLifelogs)({
        apiKey: process.env.LIMITLESS_API_KEY,
        start: latestWindow.apiStart,
        end: latestWindow.apiEnd,
        timezone,
        direction: "asc",
        limit: null,
      }),
    });
    if (!settlement.settled) {
      console.warn(`Newest Limitless window was still changing after ${settlement.refreshes} refreshes; the next scheduled run will continue convergence.`);
    }
  }

  console.log(`Done. Fetched ${totalFetched} and attempted to save ${totalSaved} lifelogs.`);
  return { fetched: totalFetched, saved: totalSaved, windows, ...settlement };
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = {
  run,
  saveLifelogsToDB,
  getLatestStartTime,
  lifelogSnapshot,
  settleLatestWindow,
};
