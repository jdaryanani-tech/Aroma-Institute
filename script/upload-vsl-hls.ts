import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "@replit/object-storage";

const execFileAsync = promisify(execFile);
const SOURCE_FILE = path.resolve("attached_assets/Aroma_VSL_Video_1793184188283.mp4");
const OUTPUT_DIRECTORY = path.resolve("generated-artifacts/vsl-hls");
const OBJECT_PREFIX = "vsl/hls/v1/";
const SEGMENT_PATTERN = /^segment-\d{5}\.ts$/;
const UPLOAD_CONCURRENCY = 4;

async function uploadSegments(client: Client, segmentNames: string[]) {
  for (let index = 0; index < segmentNames.length; index += UPLOAD_CONCURRENCY) {
    const batch = segmentNames.slice(index, index + UPLOAD_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (fileName) => ({
        fileName,
        result: await client.uploadFromFilename(
          `${OBJECT_PREFIX}${fileName}`,
          path.join(OUTPUT_DIRECTORY, fileName),
          { compress: false },
        ),
      })),
    );

    const failed = results.find(({ result }) => !result.ok);
    if (failed && !failed.result.ok) {
      throw new Error(`Unable to upload a VSL video segment: ${failed.result.error.message}`);
    }
    console.log(`Uploaded ${Math.min(index + batch.length, segmentNames.length)} of ${segmentNames.length} video segments.`);
  }
}

async function main() {
  if (process.env.NODE_ENV !== "development") {
    throw new Error("VSL media uploads are limited to the development environment.");
  }

  await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });

  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-i", SOURCE_FILE,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-c", "copy",
    "-f", "hls",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", path.join(OUTPUT_DIRECTORY, "segment-%05d.ts"),
    path.join(OUTPUT_DIRECTORY, "index.m3u8"),
  ], { maxBuffer: 5 * 1024 * 1024 });

  const files = await readdir(OUTPUT_DIRECTORY);
  const segmentNames = files.filter((fileName) => SEGMENT_PATTERN.test(fileName)).sort();
  if (!segmentNames.length || !files.includes("index.m3u8")) {
    throw new Error("FFmpeg did not produce a valid VSL playlist and segments.");
  }

  const client = new Client();
  const initialList = await client.list({ prefix: OBJECT_PREFIX, maxResults: 1 });
  if (!initialList.ok) throw new Error(`App Storage is unavailable: ${initialList.error.message}`);

  await uploadSegments(client, segmentNames);
  const playlistResult = await client.uploadFromFilename(
    `${OBJECT_PREFIX}index.m3u8`,
    path.join(OUTPUT_DIRECTORY, "index.m3u8"),
    { compress: false },
  );
  if (!playlistResult.ok) throw new Error(`Unable to upload the VSL playlist: ${playlistResult.error.message}`);

  console.log(`Uploaded the VSL playlist and ${segmentNames.length} lossless video segments to App Storage.`);
  await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unable to upload the VSL video.");
  process.exitCode = 1;
});
