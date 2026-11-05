import { badRequest } from "../../common/errors";
import type {
  AssetMetadata,
  DownloadUrl,
  StoragePort,
  StoragePurpose,
  UploadConfig,
  UploadInput
} from "./storage.port";

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

export class MockStorage implements StoragePort {
  constructor(private readonly folderPrefix = "greenwallet") {}

  getUploadConfig(purpose: StoragePurpose): UploadConfig {
    return {
      provider: "MOCK",
      cloudName: "mock-cloud",
      uploadPreset: `mock-${purpose.toLowerCase()}`,
      uploadUrl: `http://localhost/mock-upload/${folderNames[purpose]}`,
      folder: `${this.folderPrefix}/${folderNames[purpose]}`,
      maxBytes: 10 * 1024 * 1024,
      allowedFormats: allowedFormats[purpose]
    };
  }

  async getAsset(
    publicId: string,
    resourceType: string
  ): Promise<AssetMetadata> {
    const extension = publicId.split(".").pop() ?? "bin";
    return {
      publicId,
      secureUrl: `https://mock.cloudinary.local/${publicId}`,
      resourceType,
      format: extension.toLowerCase(),
      bytes: 1024,
      etag: `mock-etag-${publicId}`,
      originalName: publicId.split("/").pop() ?? publicId,
      createdAt: new Date()
    };
  }

  buildDownloadUrl(
    publicId: string,
    _resourceType: string,
    _format: string
  ): DownloadUrl {
    return {
      url: `https://mock.cloudinary.local/signed/${encodeURIComponent(publicId)}`,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000)
    };
  }

  async upload(input: UploadInput): Promise<AssetMetadata> {
    const config = this.getUploadConfig(input.purpose);
    if (!input.publicId.startsWith(`${config.folder}/`)) {
      throw badRequest(
        `Uploaded asset must be in the ${config.folder} storage folder`
      );
    }
    if (!config.allowedFormats.includes(input.format)) {
      throw badRequest(`File format ${input.format || "unknown"} is not allowed`);
    }
    if (input.buffer.length > config.maxBytes) {
      throw badRequest("Uploaded file is too large");
    }

    return {
      publicId: input.publicId,
      secureUrl: `https://mock.cloudinary.local/${input.publicId}`,
      resourceType: input.resourceType,
      format: input.format,
      bytes: input.buffer.length,
      etag: `mock-etag-${input.publicId}-${input.buffer.length}`,
      originalName: input.publicId.split("/").pop() ?? input.publicId,
      createdAt: new Date()
    };
  }
}
