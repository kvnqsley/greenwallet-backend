import { v2 as cloudinary } from "cloudinary";
import { badRequest, notFound } from "../../common/errors";
import type {
  AssetMetadata,
  DownloadUrl,
  StoragePort,
  StoragePurpose,
  UploadConfig,
  UploadInput
} from "./storage.port";

type CloudinaryStorageOptions = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folderPrefix: string;
  maxBytes: number;
  presets: Record<StoragePurpose, string>;
};

const allowedFormats: Record<StoragePurpose, string[]> = {
  VERIFICATION: ["jpg", "jpeg", "png", "webp", "pdf"],
  TICKET: ["jpg", "jpeg", "png", "webp", "pdf", "doc", "docx", "xls", "xlsx"],
  EVIDENCE: ["jpg", "jpeg", "png", "webp", "pdf", "doc", "docx", "xls", "xlsx"]
};

const folderNames: Record<StoragePurpose, string> = {
  VERIFICATION: "verification",
  TICKET: "tickets",
  EVIDENCE: "evidence"
};

export class CloudinaryStorage implements StoragePort {
  private readonly options: CloudinaryStorageOptions;

  constructor(options: CloudinaryStorageOptions) {
    this.options = options;
    cloudinary.config({
      cloud_name: options.cloudName,
      api_key: options.apiKey,
      api_secret: options.apiSecret,
      secure: true
    });
  }

  getUploadConfig(purpose: StoragePurpose): UploadConfig {
    return {
      provider: "CLOUDINARY",
      cloudName: this.options.cloudName,
      uploadPreset: this.options.presets[purpose],
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.options.cloudName}/auto/upload`,
      folder: `${this.options.folderPrefix}/${folderNames[purpose]}`,
      maxBytes: this.options.maxBytes,
      allowedFormats: allowedFormats[purpose]
    };
  }

  async getAsset(
    publicId: string,
    resourceType: string
  ): Promise<AssetMetadata> {
    try {
      const asset = (await cloudinary.api.resource(publicId, {
        resource_type: resourceType as "image" | "raw" | "video"
      })) as Record<string, unknown>;

      const bytes = Number(asset.bytes);
      const secureUrl = asset.secure_url;
      if (
        typeof secureUrl !== "string" ||
        !Number.isFinite(bytes) ||
        bytes <= 0
      ) {
        throw badRequest("Cloudinary returned invalid asset metadata");
      }

      return {
        publicId,
        secureUrl,
        resourceType:
          typeof asset.resource_type === "string"
            ? asset.resource_type
            : resourceType,
        format: typeof asset.format === "string" ? asset.format : "",
        bytes,
        etag: typeof asset.etag === "string" ? asset.etag : "",
        originalName:
          typeof asset.original_filename === "string"
            ? asset.original_filename
            : null,
        createdAt: new Date(
          typeof asset.created_at === "string"
            ? asset.created_at
            : Date.now()
        )
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "http_code" in error &&
        (error as { http_code?: number }).http_code === 404
      ) {
        throw notFound("Uploaded asset was not found in Cloudinary");
      }
      if (error instanceof Error && "statusCode" in error) {
        throw error;
      }
      throw badRequest("Could not verify the uploaded Cloudinary asset");
    }
  }

  buildDownloadUrl(
    publicId: string,
    resourceType: string,
    format: string
  ): DownloadUrl {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const url = cloudinary.utils.private_download_url(publicId, format, {
      resource_type: resourceType as "image" | "raw" | "video",
      type: "authenticated",
      expires_at: Math.floor(expiresAt.getTime() / 1000)
    });
    return { url, expiresAt };
  }

  async upload(input: UploadInput): Promise<AssetMetadata> {
    const config = this.getUploadConfig(input.purpose);
    if (!input.publicId.startsWith(`${config.folder}/`)) {
      throw badRequest(
        `Uploaded asset must be in the ${config.folder} Cloudinary folder`
      );
    }
    if (!config.allowedFormats.includes(input.format)) {
      throw badRequest(`File format ${input.format || "unknown"} is not allowed`);
    }
    if (input.buffer.length > config.maxBytes) {
      throw badRequest("Uploaded file is too large");
    }

    const result = await new Promise<
      Record<string, unknown>
    >((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: input.publicId,
          resource_type: input.resourceType as "image" | "raw" | "video",
          type: "authenticated",
          format: input.format,
          overwrite: false,
          unique_filename: false
        },
        (error, uploadResult) => {
          if (error || !uploadResult) {
            reject(error ?? new Error("Cloudinary upload failed"));
            return;
          }
          resolve(uploadResult as unknown as Record<string, unknown>);
        }
      );
      stream.end(input.buffer);
    });

    const bytes = Number(result.bytes);
    const secureUrl = result.secure_url;
    if (
      typeof secureUrl !== "string" ||
      !Number.isFinite(bytes) ||
      bytes <= 0
    ) {
      throw badRequest("Cloudinary returned invalid upload metadata");
    }

    return {
      publicId: input.publicId,
      secureUrl,
      resourceType:
        typeof result.resource_type === "string"
          ? result.resource_type
          : input.resourceType,
      format: typeof result.format === "string" ? result.format : input.format,
      bytes,
      etag: typeof result.etag === "string" ? result.etag : "",
      originalName:
        typeof result.original_filename === "string"
          ? result.original_filename
          : input.publicId.split("/").pop() ?? input.publicId,
      createdAt: new Date(
        typeof result.created_at === "string"
          ? result.created_at
          : Date.now()
      )
    };
  }
}
