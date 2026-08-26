import fs from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

function missing(error) {
  return error?.name === "NoSuchKey" || error?.Code === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404;
}

export class OmgmuWatchStore {
  constructor(config) {
    this.config = config;
    this.key = "watch/omgmu/state.json";
    this.s3 = config.accessKeyId && config.secretAccessKey
      ? new S3Client({
          endpoint: config.endpoint,
          region: config.region,
          forcePathStyle: true,
          credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        })
      : null;
  }

  #normalize(state) {
    return {
      version: 1,
      university: "omgmu",
      updatedAt: state?.updatedAt || null,
      lastRunAt: state?.lastRunAt || null,
      lastRunSummary: state?.lastRunSummary && typeof state.lastRunSummary === "object" ? state.lastRunSummary : null,
      slots: state?.slots && typeof state.slots === "object" ? state.slots : {},
    };
  }

  async read() {
    if (this.s3) {
      try {
        const response = await this.s3.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key }));
        return this.#normalize(JSON.parse(await response.Body.transformToString("utf8")));
      } catch (error) {
        if (missing(error)) return this.#normalize(null);
        throw error;
      }
    }
    try {
      return this.#normalize(JSON.parse(await fs.readFile(path.join(this.config.dataDir, this.key), "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return this.#normalize(null);
      throw error;
    }
  }

  async write(state) {
    const value = this.#normalize(state);
    value.updatedAt = new Date().toISOString();
    const body = JSON.stringify(value);
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key,
        Body: body,
        ContentType: "application/json; charset=utf-8",
        CacheControl: "no-store",
      }));
      return value;
    }
    const filename = path.join(this.config.dataDir, this.key);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, body, { mode: 0o600 });
    return value;
  }
}
