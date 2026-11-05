export const STORAGE_PURPOSES = [
  "VERIFICATION",
  "TICKET",
  "EVIDENCE"
] as const;

export type StoragePurpose = (typeof STORAGE_PURPOSES)[number];

export type UploadConfig = {
  provider: "CLOUDINARY" | "MOCK";
  cloudName: string;
  uploadPreset: string;
  uploadUrl: string;
  folder: string;
  maxBytes: number;
  allowedFormats: string[];
};

export type AssetMetadata = {
  publicId: string;
  secureUrl: string;
  resourceType: string;
  format: string;
  bytes: number;
  etag: string;
  originalName: string | null;
  createdAt: Date;
};

export type DownloadUrl = {
  url: string;
  expiresAt: Date;
};

export type UploadInput = {
  purpose: StoragePurpose;
  publicId: string;
  buffer: Buffer;
  resourceType: string;
  format: string;
  contentType: string;
};

export interface StoragePort {
  getUploadConfig(purpose: StoragePurpose): UploadConfig;
  getAsset(publicId: string, resourceType: string): Promise<AssetMetadata>;
  buildDownloadUrl(
    publicId: string,
    resourceType: string,
    format: string
  ): DownloadUrl;
  upload(input: UploadInput): Promise<AssetMetadata>;
}
