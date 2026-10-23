import type { InspectionAsset, InspectionReport } from "../domain/inspection";
import type { Inspector } from "../ports/inspector";
import type { AssetStore } from "../ports/asset-store";
import type { Journal } from "../ports/journal";
import type { PdfReader } from "../ports/pdf-reader";

const PDF_MEDIA_TYPE = "application/pdf";

export class InspectionService {
  constructor(
    private readonly storage: AssetStore,
    private readonly pdfReader: PdfReader,
    private readonly inspector: Inspector,
    private readonly journal: Journal,
    private readonly supportedMediaTypes: Readonly<Record<string, string>>,
  ) {}

  async inspect(path: string): Promise<InspectionReport> {
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
    const mediaType = this.supportedMediaTypes[extension];
    if (!mediaType) {
      const supported = Object.keys(this.supportedMediaTypes).join(", ");
      throw new Error(
        `Unsupported media type for "${path}". Use one of: ${supported}.`,
      );
    }

    const asset: InspectionAsset = {
      path,
      mediaType,
      data: await this.storage.read(path),
      extractedText:
        mediaType === PDF_MEDIA_TYPE
          ? (await this.pdfReader.read(path)).text
          : undefined,
    };
    return this.inspector.inspect(asset, this.journal);
  }
}
