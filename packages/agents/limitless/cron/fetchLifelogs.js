require("dotenv").config({ path: require("path").resolve(__dirname, "../../../../.env.local") });
const pool = require("@secondbrain/db");
const { getLifelogs } = require("../services/limitless");

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
          markdown = EXCLUDED.markdown`,
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

async function run() {
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
    return;
  }

  console.log(
    `Fetching lifelogs from ${toApiDate(startDate)} to ${toApiDate(endDate)} in ${windowDays}-day windows (${timezone}).`
  );

  let totalFetched = 0;
  let totalSaved = 0;
  let windowStart = new Date(startDate);

  while (windowStart <= endDate) {
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + Math.max(1, windowDays) - 1);
    if (windowEnd > endDate) {
      windowEnd.setTime(endDate.getTime());
    }

    const apiStart = toApiDate(windowStart);
    const apiEnd = toApiDate(windowEnd);
    console.log(`Fetching window: ${apiStart} -> ${apiEnd}`);

    const lifelogs = await getLifelogs({
      apiKey: process.env.LIMITLESS_API_KEY,
      start: apiStart,
      end: apiEnd,
      timezone,
      direction: "asc",
      limit: null,
    });

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

  console.log(`Done. Fetched ${totalFetched} and attempted to save ${totalSaved} lifelogs.`);
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

module.exports = { run, saveLifelogsToDB, getLatestStartTime };
