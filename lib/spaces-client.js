/**
 * DigitalOcean Spaces client for image storage.
 *
 * Uploads Excalidraw image files (base64 dataURLs) to DO Spaces
 * and returns public CDN URLs.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

let s3Client = null;
let spacesConfig = null;

export function initSpacesClient(env) {
  const accessKey = env.DO_SPACES_ACCESS_KEY;
  const secretKey = env.DO_SPACES_SECRET_KEY;
  const bucket = env.DO_SPACES_BUCKET;
  const region = env.DO_SPACES_REGION || 'nyc3';

  if (!accessKey || !secretKey || !bucket) {
    return false;
  }

  s3Client = new S3Client({
    endpoint: `https://${region}.digitaloceanspaces.com`,
    region: 'us-east-1', // Required by SDK, ignored by DO
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    forcePathStyle: false,
  });

  spacesConfig = {
    bucket,
    region,
    cdnBase: `https://${bucket}.${region}.digitaloceanspaces.com`,
  };

  return true;
}

export function isSpacesEnabled() {
  return s3Client !== null && spacesConfig !== null;
}

const MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
};

/**
 * Upload an image to DO Spaces.
 *
 * @param {string} sessionId - Drawbridge session ID
 * @param {string} fileId - Excalidraw file ID
 * @param {string} dataURL - Base64 data URL (data:image/png;base64,...)
 * @param {string} mimeType - MIME type
 * @returns {Promise<string>} CDN URL
 */
export async function uploadFile(sessionId, fileId, dataURL, mimeType) {
  if (!s3Client || !spacesConfig) {
    throw new Error('Spaces client not initialized');
  }

  const base64Match = dataURL.match(/^data:[^;]+;base64,(.+)$/);
  if (!base64Match) {
    throw new Error('Invalid dataURL format');
  }

  const buffer = Buffer.from(base64Match[1], 'base64');
  const ext = MIME_EXTENSIONS[mimeType] || '.bin';
  const key = `files/${sessionId}/${fileId}${ext}`;

  // Check if already uploaded (dedup)
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: spacesConfig.bucket,
      Key: key,
    }));
    return `${spacesConfig.cdnBase}/${key}`;
  } catch (err) {
    if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
      throw err;
    }
  }

  await s3Client.send(new PutObjectCommand({
    Bucket: spacesConfig.bucket,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    ACL: 'public-read',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return `${spacesConfig.cdnBase}/${key}`;
}
