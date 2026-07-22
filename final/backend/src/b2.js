const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const {
  B2_ENDPOINT,
  B2_REGION,
  B2_BUCKET,
  B2_KEY_ID,
  B2_APP_KEY,
  B2_URL_EXPIRY,
} = process.env;

const EXPIRY = Number(B2_URL_EXPIRY) || 600;
const FOLDER = "daily";

const s3 = new S3Client({
  endpoint: B2_ENDPOINT,
  region: B2_REGION,
  credentials: {
    accessKeyId: B2_KEY_ID,
    secretAccessKey: B2_APP_KEY,
  },
  // B2's S3 API requires path-style addressing.
  forcePathStyle: true,
});

/** Build a collision-resistant object key under the daily/ folder. */
function makeKey(slot, originalName) {
  const safe = String(originalName || `${slot}.csv`)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-80);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${FOLDER}/${stamp}-${slot}-${safe}`;
}

/** Presigned PUT URL the browser uses to upload a file straight to B2. */
async function presignPut(key, contentType = "text/csv") {
  const cmd = new PutObjectCommand({
    Bucket: B2_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, cmd, { expiresIn: EXPIRY });
}

/** Download an object from B2 into a Buffer (server-side, no size limit). */
async function getObjectBuffer(key) {
  const out = await s3.send(
    new GetObjectCommand({ Bucket: B2_BUCKET, Key: key })
  );
  const chunks = [];
  for await (const chunk of out.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Guard so keys stay inside the daily/ folder (no traversal). */
function assertDailyKey(key) {
  if (typeof key !== "string" || !key.startsWith(`${FOLDER}/`) || key.includes("..")) {
    throw new Error("Invalid object key");
  }
}

module.exports = {
  makeKey,
  presignPut,
  getObjectBuffer,
  assertDailyKey,
  EXPIRY,
};
