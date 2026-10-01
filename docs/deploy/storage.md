---
title: Storage
summary: Where uploaded files go, local disk or S3-compatible object storage
---

AgentDash stores uploaded files (issue attachments, images, documents) through a storage provider. There are two: `local_disk` and `s3`. Source: `server/src/storage/`, `STORAGE_PROVIDERS` in `packages/shared/src/constants.ts`.

## Local disk (default)

Files go to `~/.paperclip/instances/default/data/storage`, or `PAPERCLIP_STORAGE_LOCAL_DIR` if set. No other setup.

Use it for a single machine. Back the directory up with the database: a database backup does not contain the files.

## S3-compatible

Use `s3` for AWS S3 or a compatible service (MinIO, Cloudflare R2 and others), or when more than one machine needs the same files.

| Variable | Default | Meaning |
|---|---|---|
| `PAPERCLIP_STORAGE_PROVIDER` | `local_disk` | Set to `s3` |
| `PAPERCLIP_STORAGE_S3_BUCKET` | `paperclip` | Bucket name |
| `PAPERCLIP_STORAGE_S3_REGION` | `us-east-1` | Region |
| `PAPERCLIP_STORAGE_S3_ENDPOINT` | (unset) | Endpoint URL, for non-AWS services |
| `PAPERCLIP_STORAGE_S3_PREFIX` | (empty) | Key prefix inside the bucket |
| `PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE` | `false` | Path-style URLs, which MinIO and some others need |

The S3 client is created without explicit credentials (`server/src/storage/s3-provider.ts`), so it uses the AWS SDK's default credential chain: for example `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the environment, or an attached IAM role.

The same settings can live in the instance config's `storage` section. Environment variables win. From a clone you can edit it with:

```sh
pnpm paperclipai configure --section storage
```

## Upload limits

| Variable | Default | Meaning |
|---|---|---|
| `PAPERCLIP_ATTACHMENT_MAX_BYTES` | 10 MiB | Ceiling for any upload. A company's own attachment limit is capped at this value |
| `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES` | a built-in list of image, PDF, Markdown, text, JSON, CSV and HTML types | Replaces the list. Comma-separated MIME types or wildcards, such as `image/*,application/pdf` |

Source: `server/src/attachment-types.ts`.
